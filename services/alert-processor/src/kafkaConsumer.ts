import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { ZoneAlert } from './types';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const ALERTS_TOPIC = 'zone.alerts';
const CONSUMER_GROUP = 'alert-processor';

export class KafkaAlertConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private isConnected: boolean = false;
  private messageHandler: ((alert: ZoneAlert) => Promise<void>) | null = null;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'alert-processor',
      brokers: [KAFKA_BROKER]
    });

    this.consumer = this.kafka.consumer({ groupId: CONSUMER_GROUP });
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: ALERTS_TOPIC, fromBeginning: true });
    this.isConnected = true;
    console.log(`✅ Connected to Kafka broker: ${KAFKA_BROKER}`);
    console.log(`✅ Subscribed to topic: ${ALERTS_TOPIC}`);
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    await this.consumer.disconnect();
    this.isConnected = false;
    console.log('✅ Disconnected from Kafka');
  }

  async startConsuming(handler: (alert: ZoneAlert) => Promise<void>): Promise<void> {
    if (!this.isConnected) throw new Error('Consumer not connected');
    this.messageHandler = handler;

    await this.consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        try {
          if (!message.value) return;
          const alert: ZoneAlert = JSON.parse(message.value.toString());
          if (this.messageHandler) await this.messageHandler(alert);
        } catch (err) {
          console.error('❌ Error processing alert message:', err);
        }
      }
    });

    console.log('▶️ Alert consumer started');
  }
}
