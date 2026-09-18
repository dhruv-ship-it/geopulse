import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import {
  Disposition,
  processWithRecovery,
  retryPolicyFromEnv,
  RetryPolicy
} from '@geopulse/kafka-recovery';

import { logger } from './logger';
import { sensorEventsDroppedTotal, sensorEventRetriesTotal } from './metrics';
import { SensorEvent } from './types';

const KAFKA_TOPIC = process.env.RAW_EVENTS_TOPIC || 'raw.zone.events';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const CONSUMER_GROUP = process.env.STREAM_CONSUMER_GROUP || 'zone-stream-processor';

export interface EventConsumerOptions {
  topic?: string;
  groupId?: string;
  fromBeginning?: boolean;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Kafka consumer for raw sensor events.
 *
 * ## Defect D1, the second copy of it
 *
 * `eachMessage` used to wrap the whole handler in try/catch and log whatever came out. Returning
 * normally from `eachMessage` is how a consumer tells kafkajs the message was handled, so the
 * offset committed and the event was gone — a failed Redis write or a failed degradation publish
 * destroyed the thing it was supposed to record, and the only trace was one line in a log nobody
 * reads at 400 events per second. `alert-processor` had the same bug and it was fixed there
 * first; this is the same fix, from the same module, rather than a second implementation.
 *
 * ## But with the *other* failure policy, and that is the interesting part
 *
 * `@geopulse/kafka-recovery` makes the give-up behaviour an explicit argument because the two
 * consumers should not make the same choice. `alert-processor` dead-letters, because a
 * degradation is a derived fact that nothing re-emits. This one drops, because a raw sensor
 * event is **one sample of a signal that is re-sampled every second**.
 *
 * Concretely: `avg1m` is a mean over roughly sixty samples and `avg5m` over three hundred.
 * Losing one moves `avg1m` by at most 1/60 of its range, for at most sixty seconds, after which
 * the sample has left the window and the loss has no representation anywhere in the system. The
 * *state* the zone is in is derived from the average, not from any individual event, so the
 * transition this pipeline exists to detect still fires — up to one sample late in the worst
 * case, which is below the 60-second confirmation delay the state machine already imposes.
 *
 * And the DLQ side of it does not survive contact with the volume. At 400 zones sampling once a
 * second a sustained failure would write 400 dead letters per second, against a 14-day-retention
 * topic sized for an occasional poison message, to preserve samples that are worthless by the
 * time anyone looks: replaying an hour-old sensor reading into a five-minute window does nothing
 * except corrupt it. The reasoning is written up as the amendment to ADR-000.
 *
 * Dropping is not the same as swallowing, which was D1. A drop is counted
 * (`sensor_events_dropped_total`, labelled by reason) and logged at error, so a non-zero rate is
 * visible on the metrics endpoint rather than inferrable from the absence of alerts — which is
 * exactly how D10 stayed hidden for a week.
 */
export class KafkaEventConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private isConnected: boolean = false;
  private messageHandler: ((event: SensorEvent, partition: number) => Promise<void>) | null = null;
  private readonly topic: string;
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly policy: RetryPolicy;
  private readonly sleep?: (ms: number) => Promise<void>;

  private consumed = 0;
  private dropped = 0;

  constructor(options: EventConsumerOptions = {}) {
    this.topic = options.topic ?? KAFKA_TOPIC;
    this.groupId = options.groupId ?? CONSUMER_GROUP;
    this.fromBeginning = options.fromBeginning ?? true;
    this.policy = options.policy ?? retryPolicyFromEnv('SENSOR', process.env, {
      // Deliberately shorter than alert-processor's. A sensor event is worth a couple of quick
      // retries over a blip and no more: the backoff runs inside eachMessage, so a long one
      // stalls the partition — and everything behind this message is newer data about the same
      // zones, which is worth more than this message is.
      maxAttempts: 3,
      initialBackoffMs: 50,
      backoffMultiplier: 3,
      maxBackoffMs: 500
    });
    this.sleep = options.sleep;

    this.kafka = new Kafka({
      clientId: 'stream-processor',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 8
      }
    });

    this.consumer = this.kafka.consumer({
      groupId: this.groupId,
      // Off deliberately: subscribing to a topic that does not exist should fail loudly
      // rather than conjure a 1-partition topic. See tools/kafka-bootstrap.
      allowAutoTopicCreation: false,
      retry: { retries: 3 }
    });
  }

  /** The Kafka client, so producers can share this connection's configuration. */
  getKafka(): Kafka {
    return this.kafka;
  }

  stats(): { consumed: number; dropped: number } {
    return { consumed: this.consumed, dropped: this.dropped };
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning });
      this.isConnected = true;
      logger.info(
        { broker: KAFKA_BROKER, topic: this.topic, groupId: this.groupId },
        'Sensor event consumer connected'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to connect to Kafka');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.consumer.disconnect();
      this.isConnected = false;
      logger.info('Sensor event consumer disconnected');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting from Kafka');
      throw error;
    }
  }

  /**
   * Set message handler and start consuming.
   */
  async startConsuming(
    messageHandler: (event: SensorEvent, partition: number) => Promise<void>
  ): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Kafka consumer not connected');
    }

    this.messageHandler = messageHandler;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      }
    });

    logger.info({ policy: this.policy }, 'Started consuming sensor events');
  }

  /**
   * Exposed so a test can drive the recovery path with a hand-built payload. Standing up a
   * broker to prove that a failing handler does not commit an offset would be slower and would
   * prove less, because the failure it has to produce is one a broker will not produce on
   * request.
   */
  async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<Disposition> {
    // No try/catch. Anything processWithRecovery throws must escape eachMessage so kafkajs
    // does not commit the offset. That is defect D1, in one comment.
    const disposition = await processWithRecovery<SensorEvent>({
      value: message.value,
      key: message.key,
      topic,
      partition,
      offset: message.offset,
      parse: (raw) => JSON.parse(raw.toString()) as SensorEvent,
      handle: async (event) => {
        if (this.messageHandler) {
          // The partition goes through to the processor because event-time progress is a
          // per-partition property: kafkajs drains partitions concurrently and at different
          // rates, so "the highest event time seen" says nothing about how far the slowest
          // input has actually got.
          await this.messageHandler(event, partition);
        }
      },
      onFailure: 'drop',
      policy: this.policy,
      sleep: this.sleep,
      onRetry: (attempt, delayMs, err) => {
        sensorEventRetriesTotal.inc();
        logger.warn(
          { attempt, delayMs, error: err, topic, partition, offset: message.offset },
          'Sensor event processing failed; retrying'
        );
      },
      onDrop: (reason, err, attempts) => {
        this.dropped++;
        sensorEventsDroppedTotal.labels(reason).inc();
        logger.error(
          { reason, attempts, error: err, topic, partition, offset: message.offset },
          'Sensor event exhausted recovery; dropping it (see ADR-000 amendment)'
        );
      }
    });

    if (disposition === 'processed') {
      this.consumed++;
    }
    return disposition;
  }

  /**
   * Get consumer metrics
   */
  async getMetrics(): Promise<any> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const groupDescription = await this.consumer.describeGroup();
      return {
        groupId: this.groupId,
        state: groupDescription.state,
        members: groupDescription.members.length
      };
    } catch (error) {
      logger.error({ error }, 'Error getting consumer metrics');
      return null;
    }
  }
}
