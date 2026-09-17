import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { ZoneAlert } from './types';
import { KafkaDeadLetterProducer, DeadLetterPublisher } from './deadLetter';
import { processWithRecovery, RetryPolicy, DEFAULT_RETRY_POLICY } from './messageRecovery';
import { logger } from './logger';
import { alertsDeadLetteredTotal, alertRetriesTotal } from './metrics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const ALERTS_TOPIC = 'zone.alerts';
const CONSUMER_GROUP = 'alert-processor';

export class KafkaAlertConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private deadLetterProducer: KafkaDeadLetterProducer;
  private isConnected: boolean = false;
  private messageHandler: ((alert: ZoneAlert) => Promise<void>) | null = null;

  constructor(private policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
    this.kafka = new Kafka({
      clientId: 'alert-processor',
      brokers: [KAFKA_BROKER]
    });

    this.consumer = this.kafka.consumer({
      groupId: CONSUMER_GROUP,
      // Off deliberately: subscribing to a topic that does not exist should fail loudly
      // rather than conjure a 1-partition topic. See tools/kafka-bootstrap.
      allowAutoTopicCreation: false
    });

    this.deadLetterProducer = new KafkaDeadLetterProducer(this.kafka);
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.consumer.connect();
    // Connect the DLQ before consuming: if we cannot dead-letter, we cannot safely commit
    // after a failure, and it is better to find that out at startup.
    await this.deadLetterProducer.connect();
    await this.consumer.subscribe({ topic: ALERTS_TOPIC, fromBeginning: true });
    this.isConnected = true;
    logger.info({ broker: KAFKA_BROKER, topic: ALERTS_TOPIC, group: CONSUMER_GROUP }, 'Kafka consumer connected');
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

  async startConsuming(handler: (alert: ZoneAlert) => Promise<void>): Promise<void> {
    if (!this.isConnected) throw new Error('Consumer not connected');
    this.messageHandler = handler;

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        // No try/catch here on purpose. Anything processWithRecovery throws must escape
        // eachMessage so kafkajs does not commit the offset.
        const disposition = await processWithRecovery<ZoneAlert>({
          value: message.value,
          key: message.key,
          topic,
          partition,
          offset: message.offset,
          parse: (raw) => JSON.parse(raw.toString()) as ZoneAlert,
          handle: async (alert) => {
            if (this.messageHandler) await this.messageHandler(alert);
          },
          deadLetter: this.deadLetterProducer,
          policy: this.policy,
          onRetry: (attempt, delayMs, err) => {
            alertRetriesTotal.inc();
            logger.warn(
              { attempt, delayMs, error: err, topic, partition, offset: message.offset },
              'Alert persistence failed; retrying'
            );
          },
          onDeadLetter: (reason, err) => {
            alertsDeadLetteredTotal.labels(reason).inc();
            logger.error(
              { reason, error: err, topic, partition, offset: message.offset },
              'Alert exhausted recovery; routing to dead letter queue'
            );
          }
        });

        if (disposition === 'skipped') {
          logger.debug({ topic, partition, offset: message.offset }, 'Skipped empty message');
        }
      }
    });

    logger.info('Alert consumer started');
  }
}
