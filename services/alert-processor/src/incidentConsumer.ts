import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import {
  DeadLetterPublisher,
  Disposition,
  processWithRecovery,
  retryPolicyFromEnv,
  RetryPolicy
} from '@geopulse/kafka-recovery';

import { IncidentWireEvent } from './incidentTypes';
import { logger } from './logger';
import { incidentsConsumedTotal, incidentsDeadLetteredTotal, incidentRetriesTotal } from './metrics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const INCIDENTS_TOPIC = process.env.INCIDENTS_TOPIC || 'zone.incidents';
const CONSUMER_GROUP = process.env.INCIDENT_CONSUMER_GROUP || 'incident-persister';

export interface IncidentConsumerOptions {
  kafka?: Kafka;
  topic?: string;
  groupId?: string;
  fromBeginning?: boolean;
  policy?: RetryPolicy;
  /** Required in production; injectable so the recovery path can be tested without a broker. */
  deadLetter: DeadLetterPublisher;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Consumes `zone.incidents` and hands each event to the incident repository.
 *
 * ## Its own consumer group, in the same process
 *
 * This is a second, independent consumer alongside the degradation one. Two groups, two sets of
 * offsets, two failure domains — a stalled incident write does not hold up degradation
 * persistence and vice versa. What they share is the process, the Postgres pool and the DLQ
 * connection, which is the whole argument for not making this a sixth service (see `index.ts`).
 *
 * ## Dead-letter, like the degradation side
 *
 * An incident event is the product's output. Nothing re-emits it: the correlation engine's state
 * is in memory and every operation in its fold is idempotent, so re-reading the degradations
 * that produced this event produces the *same state* and therefore emits nothing at all. That is
 * the same trap `IncidentDispatcher` exists to avoid one service upstream, and it means a lost
 * incident event is lost for good. Retry, then park it where it can be replayed.
 *
 * `fromBeginning` is true by default, matching the rest of the pipeline and the eval harness: a
 * run is only reproducible if the persister sees the same events. A long-lived deployment would
 * want false, and the environment variable is there for it.
 */
export class KafkaIncidentConsumer {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly topic: string;
  private readonly fromBeginning: boolean;
  private readonly policy: RetryPolicy;
  private readonly deadLetter: DeadLetterPublisher;
  private readonly sleep?: (ms: number) => Promise<void>;

  private handler: ((event: IncidentWireEvent) => Promise<void>) | null = null;
  private connected = false;
  private consumed = 0;
  private deadLettered = 0;

  constructor(options: IncidentConsumerOptions) {
    this.topic = options.topic ?? INCIDENTS_TOPIC;
    this.fromBeginning = options.fromBeginning ?? true;
    this.policy = options.policy ?? retryPolicyFromEnv('INCIDENT');
    this.deadLetter = options.deadLetter;
    this.sleep = options.sleep;

    this.kafka =
      options.kafka ?? new Kafka({ clientId: 'incident-persister', brokers: [KAFKA_BROKER] });

    this.consumer = this.kafka.consumer({
      groupId: options.groupId ?? CONSUMER_GROUP,
      // Off deliberately: subscribing to a topic that does not exist should fail loudly
      // rather than conjure a 1-partition topic. See tools/kafka-bootstrap.
      allowAutoTopicCreation: false
    });
  }

  stats(): { consumed: number; deadLettered: number } {
    return { consumed: this.consumed, deadLettered: this.deadLettered };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning });
    this.connected = true;
    logger.info({ broker: KAFKA_BROKER, topic: this.topic }, 'Incident consumer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.consumer.disconnect();
    this.connected = false;
    logger.info('Incident consumer disconnected');
  }

  async startConsuming(handler: (event: IncidentWireEvent) => Promise<void>): Promise<void> {
    if (!this.connected) throw new Error('Incident consumer not connected');
    this.handler = handler;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      }
    });

    logger.info('Incident consumer started');
  }

  /** Exposed so the recovery path can be driven from a test without a broker. */
  async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<Disposition> {
    // No try/catch. Anything processWithRecovery throws must escape eachMessage so kafkajs
    // does not commit the offset. Defect D1.
    const disposition = await processWithRecovery<IncidentWireEvent>({
      value: message.value,
      key: message.key,
      topic,
      partition,
      offset: message.offset,
      parse: (raw) => JSON.parse(raw.toString()) as IncidentWireEvent,
      handle: async (event) => {
        if (this.handler) await this.handler(event);
      },
      onFailure: 'dead-letter',
      deadLetter: this.deadLetter,
      policy: this.policy,
      sleep: this.sleep,
      onRetry: (attempt, delayMs, err) => {
        incidentRetriesTotal.inc();
        logger.warn(
          { attempt, delayMs, error: err, topic, partition, offset: message.offset },
          'Incident persistence failed; retrying'
        );
      },
      onDeadLetter: (reason, err) => {
        this.deadLettered++;
        incidentsDeadLetteredTotal.labels(reason).inc();
        logger.error(
          { reason, error: err, topic, partition, offset: message.offset },
          'Incident event exhausted recovery; routing to dead letter queue'
        );
      }
    });

    if (disposition === 'processed') {
      this.consumed++;
      incidentsConsumedTotal.inc();
    }
    return disposition;
  }
}
