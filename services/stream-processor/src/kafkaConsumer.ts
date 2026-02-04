import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { SensorEvent } from './types';

const KAFKA_TOPIC = 'raw.zone.events';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const CONSUMER_GROUP = 'zone-stream-processor';

/**
 * Kafka consumer for raw sensor events
 * Handles connection management and message consumption
 */
export class KafkaEventConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private isConnected: boolean = false;
  private messageHandler: ((event: SensorEvent) => Promise<void>) | null = null;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'stream-processor',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 8
      }
    });

    this.consumer = this.kafka.consumer({
      groupId: CONSUMER_GROUP,
      retry: { retries: 3 }
    });
  }

  /**
   * Connect to Kafka
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
      this.isConnected = true;
      console.log(`✅ Connected to Kafka broker: ${KAFKA_BROKER}`);
      console.log(`✅ Subscribed to topic: ${KAFKA_TOPIC}`);
      console.log(`✅ Consumer group: ${CONSUMER_GROUP}`);
    } catch (error) {
      console.error('❌ Failed to connect to Kafka:', error);
      throw error;
    }
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.consumer.disconnect();
      this.isConnected = false;
      console.log('✅ Disconnected from Kafka');
    } catch (error) {
      console.error('❌ Error disconnecting from Kafka:', error);
      throw error;
    }
  }

  /**
   * Set message handler and start consuming
   */
  async startConsuming(messageHandler: (event: SensorEvent) => Promise<void>): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Kafka consumer not connected');
    }

    this.messageHandler = messageHandler;

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        try {
          if (!message.value) return;
          
          const event: SensorEvent = JSON.parse(message.value.toString());
          
          if (this.messageHandler) {
            await this.messageHandler(event);
          }
        } catch (error) {
          console.error('❌ Error processing message:', error);
        }
      }
    });

    console.log('▶️ Started consuming messages');
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
        groupId: CONSUMER_GROUP,
        state: groupDescription.state,
        members: groupDescription.members.length
      };
    } catch (error) {
      console.error('❌ Error getting consumer metrics:', error);
      return null;
    }
  }
}