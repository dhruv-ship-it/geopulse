/**
 * The Kafka client wiring, against a mocked kafkajs.
 *
 * These are thin classes, and the point of testing them is not the wiring — it is the three
 * claims the README and ADR-004 make about the bytes that reach the broker, each of which is
 * invisible in the type system and each of which has already cost this project once:
 *
 *   1. incidents are keyed by `h3CoarseCell`, not by `incidentId`;
 *   2. no record timestamp is set (defect D10 — the broker deleted 5.76M messages because the
 *      producer told it they were 245 days old);
 *   3. auto topic creation is off on both clients (a silently auto-created 1-partition topic
 *      throws away the only parallelism the keying was designed to buy).
 */

const sendMock = jest.fn<Promise<void>, any[]>(async () => undefined);
const producerConnect = jest.fn(async () => undefined);
const producerDisconnect = jest.fn(async () => undefined);
const consumerConnect = jest.fn(async () => undefined);
const consumerDisconnect = jest.fn(async () => undefined);
const subscribeMock = jest.fn<Promise<void>, any[]>(async () => undefined);
const runMock = jest.fn<Promise<void>, any[]>(async () => undefined);

const producerConfigs: any[] = [];
const consumerConfigs: any[] = [];

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: (config: any) => {
      producerConfigs.push(config);
      return {
        connect: producerConnect,
        disconnect: producerDisconnect,
        send: sendMock
      };
    },
    consumer: (config: any) => {
      consumerConfigs.push(config);
      return {
        connect: consumerConnect,
        disconnect: consumerDisconnect,
        subscribe: subscribeMock,
        run: runMock
      };
    }
  })),
  Partitioners: { LegacyPartitioner: 'legacy' }
}));

import { KafkaDegradationConsumer } from '../kafkaConsumer';
import { KafkaIncidentProducer } from '../kafkaProducer';
import { IncidentWireEvent } from '../types';

const event = (overrides: Partial<IncidentWireEvent> = {}): IncidentWireEvent => ({
  incidentId: 'INC-0123456789abcdef',
  eventType: 'OPENED',
  status: 'OPEN',
  lifecycleStatus: 'OPEN',
  memberZones: ['Z-1', 'Z-2', 'Z-3'],
  memberCount: 3,
  peakSeverity: 0.9,
  severity: 0.85,
  footprint: {
    h3Cells: ['cell-a'],
    centroid: { latitude: 30, longitude: 70 },
    radiusKm: 4.2
  },
  propagation: null,
  mergedFrom: null,
  supersededBy: null,
  splitFrom: null,
  closeReason: null,
  openedAt: 1768478400000,
  updatedAt: 1768478400000,
  closedAt: null,
  h3CoarseCell: '83283ffffffffff',
  ...overrides
});

beforeEach(() => {
  jest.clearAllMocks();
  producerConfigs.length = 0;
  consumerConfigs.length = 0;
});

describe('KafkaIncidentProducer', () => {
  it('keys every message by the coarse cell, never by the incident id', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.connect();

    await producer.publish([
      event(),
      event({ incidentId: 'INC-aaaaaaaaaaaaaaaa', h3CoarseCell: '83283ffffffffff' })
    ]);

    const record = sendMock.mock.calls[0][0] as any;
    expect(record.topic).toBe('zone.incidents');
    expect(record.messages.map((m: any) => m.key)).toEqual([
      '83283ffffffffff',
      '83283ffffffffff'
    ]);
    // Keying by incident id would scatter one region's incidents across every partition, and
    // would split an incident's own events across partitions as it grew. See ADR-004.
    expect(record.messages.map((m: any) => m.key)).not.toContain('INC-0123456789abcdef');
  });

  it('sets no record timestamp', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.connect();
    await producer.publish([event()]);

    // Defect D10: retention is evaluated against the record timestamp, so a producer stamping a
    // simulated historical epoch tells the broker to delete every message on arrival. Event time
    // travels in the payload instead. ADR-007.
    const record = sendMock.mock.calls[0][0] as any;
    expect(record.messages[0].timestamp).toBeUndefined();
    expect(JSON.parse(record.messages[0].value).updatedAt).toBe(1768478400000);
  });

  it('sends one record for a whole reconcile, not one per event', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.connect();

    await producer.publish([event(), event({ incidentId: 'INC-b' }), event({ incidentId: 'INC-c' })]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0][0] as any).messages).toHaveLength(3);
  });

  it('does not auto-create its topic', () => {
    // eslint-disable-next-line no-new
    new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    expect(producerConfigs[0].allowAutoTopicCreation).toBe(false);
  });

  it('refuses to publish before it is connected', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await expect(producer.publish([event()])).rejects.toThrow('not connected');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an empty batch, connected or not', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.publish([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('connects and disconnects once, however many times it is asked', async () => {
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.connect();
    await producer.connect();
    await producer.disconnect();
    await producer.disconnect();

    expect(producerConnect).toHaveBeenCalledTimes(1);
    expect(producerDisconnect).toHaveBeenCalledTimes(1);
  });

  it('lets a send failure escape so the caller does not resolve its offsets', async () => {
    sendMock.mockRejectedValueOnce(new Error('broker is down'));
    const producer = new KafkaIncidentProducer('localhost:9092', 'zone.incidents');
    await producer.connect();

    await expect(producer.publish([event()])).rejects.toThrow('broker is down');
  });
});

describe('KafkaDegradationConsumer connection', () => {
  const options = {
    broker: 'localhost:9092',
    topic: 'zone.degradations',
    groupId: 'correlation-engine',
    fromBeginning: true,
    maxBatchSize: 500
  };

  it('subscribes to the configured topic with the configured offset policy', async () => {
    const consumer = new KafkaDegradationConsumer(options);
    await consumer.connect();

    expect(subscribeMock).toHaveBeenCalledWith({
      topic: 'zone.degradations',
      fromBeginning: true
    });
    expect(consumerConfigs[0].groupId).toBe('correlation-engine');
    expect(consumerConfigs[0].allowAutoTopicCreation).toBe(false);
  });

  it('runs with auto offset resolution turned off', async () => {
    const consumer = new KafkaDegradationConsumer(options);
    await consumer.connect();
    await consumer.startConsuming(async () => undefined);

    // Offsets are resolved by hand after the handler returns. With autoResolve on, kafkajs
    // decides when work counts as done, which is how defect D1 committed offsets for failed work.
    expect((runMock.mock.calls[0][0] as any).eachBatchAutoResolve).toBe(false);
  });

  it('routes the kafkajs batch through processBatch', async () => {
    const consumer = new KafkaDegradationConsumer(options);
    await consumer.connect();
    const handler = jest.fn(async () => undefined);
    await consumer.startConsuming(handler);

    const eachBatch = (runMock.mock.calls[0][0] as any).eachBatch;
    const resolved: string[] = [];
    await eachBatch({
      batch: {
        topic: 'zone.degradations',
        partition: 0,
        messages: [{ value: Buffer.from('{"zoneId":"Z-1"}'), offset: '7' }]
      },
      resolveOffset: (offset: string) => void resolved.push(offset),
      heartbeat: async () => undefined,
      isRunning: () => true,
      isStale: () => false
    });

    expect(handler).toHaveBeenCalledWith([{ zoneId: 'Z-1' }]);
    expect(resolved).toEqual(['7']);
  });

  it('connects and disconnects once, however many times it is asked', async () => {
    const consumer = new KafkaDegradationConsumer(options);
    await consumer.connect();
    await consumer.connect();
    await consumer.disconnect();
    await consumer.disconnect();

    expect(consumerConnect).toHaveBeenCalledTimes(1);
    expect(consumerDisconnect).toHaveBeenCalledTimes(1);
  });
});
