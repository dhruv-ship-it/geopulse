import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import {
  DeadLetterPublisher,
  KafkaDeadLetterProducer,
  processWithRecovery,
  retryPolicyFromEnv,
  RetryPolicy
} from '@geopulse/kafka-recovery';

import { ZoneDegradation } from './types';
import { logger } from './logger';
import { alertsDeadLetteredTotal, alertRetriesTotal } from './metrics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const DEGRADATIONS_TOPIC = process.env.DEGRADATIONS_TOPIC || 'zone.degradations';
const CONSUMER_GROUP = 'alert-processor';

export interface AlertConsumerOptions {
  policy?: RetryPolicy;
  /** Overridable so an integration test can use a throwaway group and not move production offsets. */
  groupId?: string;
  topic?: string;
  dlqTopic?: string;
  fromBeginning?: boolean;
}

/**
 * Consumes `zone.degradations` and hands each message to a persistence handler.
 *
 * ## Failure policy: dead-letter, not drop
 *
 * `processWithRecovery` makes the choice explicit at the call site, and this service chooses the
 * expensive one. A degradation is a *derived fact* — the state machine ran, a zone crossed a
 * threshold, and this message is the only record of that having happened. Nothing re-emits it:
 * the state machine has already advanced past the transition, so a dropped message is a hole in
 * the history that nothing will ever fill. `stream-processor` makes the opposite call about the
 * raw samples it derived this from, and the reasoning for both is in ADR-000's amendment.
 */
export class KafkaAlertConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private deadLetterProducer: KafkaDeadLetterProducer;
  private isConnected: boolean = false;
  private messageHandler: ((degradation: ZoneDegradation) => Promise<void>) | null = null;
  private policy: RetryPolicy;
  private topic: string;
  private fromBeginning: boolean;

  constructor(options: AlertConsumerOptions = {}) {
    this.policy = options.policy ?? retryPolicyFromEnv('ALERT');
    this.topic = options.topic ?? DEGRADATIONS_TOPIC;
    this.fromBeginning = options.fromBeginning ?? true;

    this.kafka = new Kafka({
      clientId: 'alert-processor',
      brokers: [KAFKA_BROKER]
    });

    this.consumer = this.kafka.consumer({
      groupId: options.groupId ?? CONSUMER_GROUP,
      // Off deliberately: subscribing to a topic that does not exist should fail loudly
      // rather than conjure a 1-partition topic. See tools/kafka-bootstrap.
      allowAutoTopicCreation: false
    });

    this.deadLetterProducer = new KafkaDeadLetterProducer(this.kafka, options.dlqTopic);
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.consumer.connect();
    // Connect the DLQ before consuming: if we cannot dead-letter, we cannot safely commit
    // after a failure, and it is better to find that out at startup.
    await this.deadLetterProducer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: this.fromBeginning });
    this.isConnected = true;
    logger.info({ broker: KAFKA_BROKER, topic: this.topic }, 'Kafka consumer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.consumer.disconnect();
    await this.deadLetterProducer.disconnect();
    this.isConnected = false;
    logger.info('Kafka consumer disconnected');
  }

  /** Exposed for tests and for callers that want to substitute the DLQ sink. */
  getDeadLetterPublisher(): DeadLetterPublisher {
    return this.deadLetterProducer;
  }

  async startConsuming(handler: (degradation: ZoneDegradation) => Promise<void>): Promise<void> {
    if (!this.isConnected) throw new Error('Consumer not connected');
    this.messageHandler = handler;

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        // No try/catch here on purpose. Anything processWithRecovery throws must escape
        // eachMessage so kafkajs does not commit the offset.
        const disposition = await processWithRecovery<ZoneDegradation>({
          value: message.value,
          key: message.key,
          topic,
          partition,
          offset: message.offset,
          parse: (raw) => JSON.parse(raw.toString()) as ZoneDegradation,
          handle: async (degradation) => {
            if (this.messageHandler) await this.messageHandler(degradation);
          },
          onFailure: 'dead-letter',
          deadLetter: this.deadLetterProducer,
          policy: this.policy,
          onRetry: (attempt, delayMs, err) => {
            alertRetriesTotal.inc();
            logger.warn(
              { attempt, delayMs, error: err, topic, partition, offset: message.offset },
              'Degradation persistence failed; retrying'
            );
          },
          onDeadLetter: (reason, err) => {
            alertsDeadLetteredTotal.labels(reason).inc();
            logger.error(
              { reason, error: err, topic, partition, offset: message.offset },
              'Degradation exhausted recovery; routing to dead letter queue'
            );
          }
        });

        if (disposition === 'skipped') {
          logger.debug({ topic, partition, offset: message.offset }, 'Skipped empty message');
        }
      }
    });

    logger.info('Degradation consumer started');
  }
}
