import { Kafka, Producer, ProducerRecord, Partitioners } from 'kafkajs';
import {
  DeadLetterPublisher,
  KafkaDeadLetterProducer,
  retryPolicyFromEnv,
  RetryPolicy,
  retryWithBackoff
} from '@geopulse/kafka-recovery';

import { logger } from './logger';
import { ZoneDegradation } from './types';

const DEGRADATIONS_TOPIC = process.env.DEGRADATIONS_TOPIC || 'zone.degradations';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

export interface DegradationProducerOptions {
  topic?: string;
  dlqTopic?: string;
  policy?: RetryPolicy;
  /**
   * Substitute the DLQ sink. Production leaves this unset and gets a Kafka-backed one on this
   * class's own connection — the DLQ is not optional, and making the caller wire it up would
   * make it forgettable.
   */
  deadLetter?: DeadLetterPublisher;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Publishes `ZoneDegradation` to `zone.degradations`.
 *
 * ## The topic, and why the name changed
 *
 * This used to be `KafkaAlertProducer` publishing `ZoneAlert` to `zone.alerts`, keyed by
 * `zoneId`. All three changed, and the rename is the least cosmetic part of Phase 1
 * (`01-ARCHITECTURE.md` §4.1): the per-zone stage does not emit *alerts*, because an alert is a
 * claim that something is worth a human's attention, and one sensor crossing a threshold is not
 * that claim. It emits observations that a zone's degradation state changed. Deciding which of
 * those observations add up to something worth telling a person is the correlation engine's
 * job, and it is the entire thesis of the project.
 *
 * ## The key, and why it is not the zone id
 *
 * `h3CoarseCell`, so that geographic neighbours land on the same partition and one correlation
 * consumer can see them together. Keying by `zoneId` — which is right for the per-zone stage
 * upstream — hashes neighbours uniformly at random across partitions, which is precisely the
 * wrong thing for a stage whose whole question is "are these two zones next to each other".
 * The full argument, with what it costs at a cell boundary, is ADR-004.
 *
 * ## Recoveries are published too
 *
 * A transition *to* NORMAL travels on this topic like any other. The correlation window
 * otherwise holds a recovered zone as an incident member for the rest of `CORRELATION_WINDOW_MS`
 * — up to two minutes of an incident being reported over ground that has already recovered.
 * That is also why the topic is not called `zone.degradations` by accident: it carries every
 * observation of the degradation state changing, in both directions.
 */
export class KafkaDegradationProducer {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected: boolean = false;
  private readonly topic: string;
  private readonly policy: RetryPolicy;
  private readonly deadLetter: DeadLetterPublisher;
  /** Non-null only when this class built the DLQ producer and therefore has to connect it. */
  private readonly ownedDeadLetter: KafkaDeadLetterProducer | null;
  private readonly sleep?: (ms: number) => Promise<void>;

  private published = 0;
  private retried = 0;
  private deadLettered = 0;

  constructor(options: DegradationProducerOptions = {}) {
    this.topic = options.topic ?? DEGRADATIONS_TOPIC;
    this.policy = options.policy ?? retryPolicyFromEnv('DEGRADATION');
    this.sleep = options.sleep;

    this.kafka = new Kafka({
      clientId: 'stream-processor-degradation-producer',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 2
      }
    });

    this.producer = this.kafka.producer({
      // Topics are created explicitly by tools/kafka-bootstrap. Auto-creation would
      // silently produce a 1-partition topic and hide the misconfiguration.
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
      createPartitioner: Partitioners.LegacyPartitioner
    });

    if (options.deadLetter) {
      this.deadLetter = options.deadLetter;
      this.ownedDeadLetter = null;
    } else {
      const owned = new KafkaDeadLetterProducer(this.kafka, options.dlqTopic);
      this.deadLetter = owned;
      this.ownedDeadLetter = owned;
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    // The DLQ first. If we cannot dead-letter we cannot safely give up on a publish, and that
    // is worth finding out at startup rather than at the moment a degradation needs parking.
    await this.ownedDeadLetter?.connect();
    await this.producer.connect();
    this.isConnected = true;
    logger.info({ broker: KAFKA_BROKER, topic: this.topic }, 'Degradation producer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.producer.disconnect();
    await this.ownedDeadLetter?.disconnect();
    this.isConnected = false;
    logger.info('Degradation producer disconnected');
  }

  stats(): { published: number; retried: number; deadLettered: number } {
    return { published: this.published, retried: this.retried, deadLettered: this.deadLettered };
  }

  /**
   * Publish one degradation, and do not let it disappear if that fails.
   *
   * A degradation is a *derived fact*, not a sample. The raw sensor events it was computed from
   * are re-sampled every second, but the transition itself happens exactly once: the state
   * machine has already advanced past it by the time this is called, and it will not fire again
   * while the condition holds. So this gets the expensive policy — bounded retry, then the DLQ,
   * exactly as `alert-processor` treats the same message on the consuming side (ADR-000).
   *
   * **Why the caller advances state anyway, rather than rolling back and re-deriving.** The
   * tempting alternative is to leave `currentState` alone so the next event re-runs the
   * transition. It does not work: `StateMachine` clears its confirmation timer when a transition
   * fires, so declining to commit re-arms a 60-second confirmation window and the fault is
   * reported a minute late. That trades a loud DLQ entry for a quiet latency regression, which
   * is the worse of the two — a silent one-minute detection delay is exactly the kind of thing
   * that survives into a benchmark.
   *
   * **If the DLQ is unreachable too, this throws.** The consumer does not commit the offset, the
   * raw sensor event is redelivered, and the transition is re-derived from scratch. The cost is
   * that the redelivered sample is counted twice in its window — one duplicate among sixty, on a
   * path that only runs when Kafka is entirely unavailable, which is a cost worth paying to
   * avoid losing the fact.
   */
  async publish(degradation: ZoneDegradation): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Degradation producer not connected');
    }

    const record: ProducerRecord = {
      topic: this.topic,
      messages: [
        {
          // ADR-004. Not `zoneId`.
          key: degradation.h3CoarseCell,
          // No `timestamp`. The record timestamp is the broker's (LogAppendTime), because
          // retention is evaluated against it and this pipeline's event time sits at a fixed
          // historical epoch — that mismatch destroyed 5.76M messages as defect D10. Event time
          // travels in the payload, which is the only place any consumer reads it from. ADR-007.
          value: JSON.stringify(degradation)
        }
      ]
    };

    try {
      await retryWithBackoff(() => this.producer.send(record), this.policy, {
        sleep: this.sleep,
        onRetry: (attempt, delayMs, err) => {
          this.retried++;
          logger.warn(
            { attempt, delayMs, error: err, zoneId: degradation.zoneId },
            'Failed to publish degradation; retrying'
          );
        }
      });
      this.published++;
      return;
    } catch (err) {
      logger.error(
        { error: err, zoneId: degradation.zoneId },
        'Degradation exhausted publish retries; routing to dead letter queue'
      );

      // If this throws, it escapes to the consumer and the offset is not committed. That is the
      // intended last resort, not an oversight.
      await this.deadLetter.publish({
        value: Buffer.from(JSON.stringify(degradation)),
        key: Buffer.from(degradation.h3CoarseCell),
        sourceTopic: this.topic,
        // -1 rather than a partition number: this message never reached a partition, and
        // inventing one would make the DLQ's provenance headers lie to a replay tool.
        sourcePartition: -1,
        sourceOffset: 'unpublished',
        reason: 'publish-failed',
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        attempts: this.policy.maxAttempts,
        failedAt: Date.now()
      });
      this.deadLettered++;
    }
  }
}
