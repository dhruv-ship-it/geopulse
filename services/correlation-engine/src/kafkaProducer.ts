import { Kafka, Partitioners, Producer, ProducerRecord } from 'kafkajs';

import { logger } from './logger';
import { incidentEventsPublishedTotal, incidentPublishLatencyMs } from './metrics';
import { IncidentWireEvent } from './types';

export interface IncidentPublisher {
  publish(events: readonly IncidentWireEvent[]): Promise<void>;
}

/**
 * Publishes incident lifecycle events to `zone.incidents`.
 *
 * **Keyed by `h3CoarseCell`, not by `incidentId`.** Keying by incident id would look natural and
 * would be the same mistake the pipeline started with: hashing by an identifier scatters things
 * that belong together uniformly at random. A consumer rebuilding one region's state would then
 * have to read every partition. Keying by coarse cell means a region's whole incident history
 * lands on one partition, in order — and the key is fixed at the incident's first event
 * (`CorrelationEngine.coarseCellFor`), so an incident's own events never split across partitions
 * and lose their relative ordering. See `01-ARCHITECTURE.md` §6.
 *
 * **No record timestamp is set.** The topic pins `message.timestamp.type=LogAppendTime`, so the
 * broker stamps arrival time and retention is evaluated against it. Setting a simulated event
 * time here is what destroyed 5.76M messages in defect D10: retention is judged against the
 * record timestamp, and a producer publishing at a fixed historical epoch tells the broker every
 * message is 245 days past its deletion deadline. Event time travels in the payload, which is
 * the only place any consumer here reads it from. See ADR-007.
 */
export class KafkaIncidentProducer implements IncidentPublisher {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private connected = false;

  constructor(
    private readonly broker: string,
    private readonly topic: string
  ) {
    this.kafka = new Kafka({
      clientId: 'correlation-engine-incident-producer',
      brokers: [broker],
      retry: {
        initialRetryTime: 100,
        retries: 2
      }
    });

    this.producer = this.kafka.producer({
      // Topics are created explicitly by tools/kafka-bootstrap. Auto-creation would silently
      // produce a 1-partition topic and hide the misconfiguration.
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
      createPartitioner: Partitioners.LegacyPartitioner
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    logger.info({ broker: this.broker, topic: this.topic }, 'Incident producer connected');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    logger.info('Incident producer disconnected');
  }

  /**
   * Publish a whole reconcile's worth of events in one `send`.
   *
   * One send per batch rather than per event, for the same reason the Redis write is one
   * pipeline: the events came from a single reconcile and there is nothing to be gained by
   * paying a round trip each. Failure throws, and the caller must not resolve its offsets —
   * that is defect D1's lesson, written down in ADR-000.
   */
  async publish(events: readonly IncidentWireEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    if (!this.connected) {
      throw new Error('Incident producer not connected');
    }

    const record: ProducerRecord = {
      topic: this.topic,
      messages: events.map((event) => ({
        key: event.h3CoarseCell,
        value: JSON.stringify(event)
      }))
    };

    const startedAt = Date.now();
    await this.producer.send(record);
    incidentPublishLatencyMs.observe(Date.now() - startedAt);

    for (const event of events) {
      incidentEventsPublishedTotal.labels(event.eventType).inc();
    }
  }
}
