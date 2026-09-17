import { Kafka, Producer, Partitioners } from 'kafkajs';

export const DLQ_TOPIC = process.env.DLQ_TOPIC || 'zone.degradations.dlq';

export interface DeadLetterRecord {
  /** The original message bytes, untouched, so the message can be replayed verbatim. */
  value: Buffer;
  key: Buffer | null;
  sourceTopic: string;
  sourcePartition: number;
  sourceOffset: string;
  /** Why it ended up here. */
  reason: string;
  error: string;
  attempts: number;
  failedAt: number;
}

/**
 * Where a message goes when it cannot be processed.
 *
 * An interface rather than a concrete class so the consumer's recovery path can be tested
 * without a broker — the point of the test is that the message survives, and that assertion
 * should not depend on Kafka being up.
 */
export interface DeadLetterPublisher {
  publish(record: DeadLetterRecord): Promise<void>;
}

/**
 * Kafka-backed dead letter queue.
 *
 * Headers carry the provenance so a replay tool can put the message back on its source topic
 * without parsing the payload. The payload itself is the original bytes.
 */
export class KafkaDeadLetterProducer implements DeadLetterPublisher {
  private producer: Producer;
  private isConnected = false;

  constructor(kafka: Kafka, private topic: string = DLQ_TOPIC) {
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.LegacyPartitioner
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.producer.connect();
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.producer.disconnect();
    this.isConnected = false;
  }

  async publish(record: DeadLetterRecord): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Dead letter producer not connected');
    }

    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: record.key,
          value: record.value,
          headers: {
            'x-source-topic': record.sourceTopic,
            'x-source-partition': String(record.sourcePartition),
            'x-source-offset': record.sourceOffset,
            'x-failure-reason': record.reason,
            'x-failure-error': record.error,
            'x-failure-attempts': String(record.attempts),
            'x-failed-at': String(record.failedAt)
          }
        }
      ]
    });
  }
}
