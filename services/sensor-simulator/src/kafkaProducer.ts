import { Kafka, Producer, ProducerRecord, Partitioners } from 'kafkajs';
import { SensorEvent } from './types';

const KAFKA_TOPIC = 'raw.zone.events';
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

/**
 * Kafka producer for sensor events
 * Handles connection management and message production
 */
export class KafkaEventProducer {
  private kafka: Kafka;
  private producer: Producer;
  private isConnected: boolean = false;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'sensor-simulator',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 8
      }
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
      createPartitioner: Partitioners.LegacyPartitioner
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
      await this.producer.connect();
      this.isConnected = true;
      console.log(`✅ Connected to Kafka broker: ${KAFKA_BROKER}`);
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
      await this.producer.disconnect();
      this.isConnected = false;
      console.log('✅ Disconnected from Kafka');
    } catch (error) {
      console.error('❌ Error disconnecting from Kafka:', error);
      throw error;
    }
  }

  /**
   * Send sensor event to Kafka
   * Uses zoneId as message key for partitioning
   */
  async sendEvent(event: SensorEvent): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Kafka producer not connected');
    }

    const record: ProducerRecord = {
      topic: KAFKA_TOPIC,
      messages: [
        {
          key: event.zoneId, // Partition by zoneId
          value: JSON.stringify(event),
          timestamp: event.eventTimestamp.toString()
        }
      ]
    };

    try {
      await this.producer.send(record);
    } catch (error) {
      console.error(`❌ Failed to send event ${event.eventId}:`, error);
      throw error;
    }
  }

  /**
   * Send batch of events to Kafka
   */
  async sendEvents(events: SensorEvent[]): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Kafka producer not connected');
    }

    if (events.length === 0) {
      return;
    }

    // Group events by zoneId for proper partitioning
    const eventsByZone = new Map<string, SensorEvent[]>();
    
    for (const event of events) {
      if (!eventsByZone.has(event.zoneId)) {
        eventsByZone.set(event.zoneId, []);
      }
      eventsByZone.get(event.zoneId)!.push(event);
    }

    // Send each zone's events as a batch
    const promises = Array.from(eventsByZone.entries()).map(
      async ([zoneId, zoneEvents]) => {
        const record: ProducerRecord = {
          topic: KAFKA_TOPIC,
          messages: zoneEvents.map(event => ({
            key: event.zoneId,
            value: JSON.stringify(event),
            timestamp: event.eventTimestamp.toString()
          }))
        };

        return this.producer.send(record);
      }
    );

    try {
      await Promise.all(promises);
    } catch (error) {
      console.error('❌ Failed to send event batch:', error);
      throw error;
    }
  }
}