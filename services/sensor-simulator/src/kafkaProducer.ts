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
      // Topics are created explicitly by tools/kafka-bootstrap. Auto-creation would
      // silently produce a 1-partition topic and hide the misconfiguration.
      allowAutoTopicCreation: false,
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
   * RECORD TIMESTAMP — deliberately not set. This is defect D10, and it destroyed every event
   * the simulator produced.
   *
   * These messages used to carry `timestamp: event.eventTimestamp`, which reads as the obviously
   * right thing to do for an event-time pipeline. It is not, and the reason is worth knowing.
   *
   * A Kafka record timestamp is not application event time. It is the field the broker uses to
   * decide how old a segment is, and therefore when to delete it. Simulated event time sits at a
   * fixed epoch in the past (2026-01-15, so runs stay comparable — ADR-005), the broker's clock
   * says today, and the topic ran CreateTime with 7-day retention. Every message was therefore
   * born 245 days past its retention deadline, and the broker deleted each segment seconds after
   * it rolled:
   *
   *   Deleting segment LogSegment(baseOffset=0, largestRecordTimestamp=Some(1768486940992))
   *   due to log retention time 604800000ms breach based on the largest record timestamp
   *
   * 5.76M events were produced, and vanished underneath the consumer while it was still reading
   * them. Evidence: `benchmarks/results/d10-root-cause.txt`.
   *
   * Event time still travels in the payload, as `eventTimestamp`, which is the only place the
   * stream processor has ever read it from. Nothing loses information; the storage layer just
   * stops being told a lie about how old its data is. The topics also now pin
   * `message.timestamp.type=LogAppendTime` (tools/kafka-bootstrap), so the broker stamps arrival
   * time whatever a producer claims — this comment is the explanation, that config is the
   * guarantee. Reasoning in `docs/adr/ADR-007-record-timestamp-vs-event-time.md`.
   */

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
          value: JSON.stringify(event)
          // No `timestamp` — see the note on RECORD TIMESTAMP below.
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
            value: JSON.stringify(event)
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