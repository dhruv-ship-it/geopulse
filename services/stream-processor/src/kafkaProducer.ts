import { Kafka, Producer, ProducerRecord, Partitioners } from 'kafkajs';

const ALERT_TOPIC = 'zone.alerts';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

export interface ZoneAlert {
  zoneId: string;
  previousState: string;
  currentState: string;
  avg1m: number;
  avg5m: number;
  timestamp: number;
}

/**
 * Kafka producer specialized for publishing zone.alerts
 */
export class KafkaAlertProducer {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected: boolean = false;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'stream-processor-alert-producer',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 2
      }
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
      createPartitioner: Partitioners.LegacyPartitioner
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.producer.connect();
    this.isConnected = true;
    console.log(`✅ Alert producer connected to Kafka broker: ${KAFKA_BROKER}`);
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.producer.disconnect();
    this.isConnected = false;
    console.log('✅ Alert producer disconnected from Kafka');
  }

  /**
   * Publish a single alert event to the topic `zone.alerts`
   * The produced message will match the strict schema required by Phase 4.
   */
  async sendAlert(alert: ZoneAlert): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Alert producer not connected');
    }

    const record: ProducerRecord = {
      topic: ALERT_TOPIC,
      messages: [
        {
          key: alert.zoneId,
          value: JSON.stringify(alert),
          timestamp: alert.timestamp.toString()
        }
      ]
    };

    await this.producer.send(record);
  }
}
