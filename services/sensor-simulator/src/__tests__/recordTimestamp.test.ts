import { KafkaEventProducer } from '../kafkaProducer';
import { LoadGenerator } from '../loadGenerator';
import { ZoneGenerator } from '../zoneGenerator';
import { SensorEvent } from '../types';

/**
 * Regression suite for defect D10.
 *
 * The producer used to set each record's Kafka timestamp to the event's simulated event time.
 * Retention is evaluated against that field, simulated event time is a fixed epoch in the past
 * (ADR-005), and the topics ran CreateTime with 7-day retention — so every message arrived 245
 * days past its deletion deadline and the broker dropped each segment seconds after it rolled.
 * 5.76M events were destroyed underneath a consumer still reading them. Evidence:
 * `benchmarks/results/d10-root-cause.txt`.
 *
 * What makes this worth a test rather than a comment is that the broken version looks *more*
 * correct than the fixed one. "It is an event-time pipeline, so stamp the record with event
 * time" is a reasonable sentence, and the failure it causes is invisible from inside the
 * producer: the send succeeds, the broker acknowledges, the offsets advance, and the data is
 * gone a minute later. Nothing short of an assertion on the emitted record catches a
 * well-intentioned reinstatement.
 *
 * These tests capture what the producer hands kafkajs, without a broker.
 */

const START = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Capture the ProducerRecords a send path produces, with the kafkajs client stubbed out. */
function captureRecords(run: (producer: KafkaEventProducer) => Promise<void>): Promise<any[]> {
  const sent: any[] = [];
  const producer = new KafkaEventProducer();

  // Stand in for the connected kafkajs producer. Reaching into the instance is deliberate:
  // the thing under test is the exact shape of the record, and any indirection that let the
  // test construct the record itself would be testing the test.
  (producer as any).producer = {
    send: async (record: any) => {
      sent.push(record);
      return [];
    }
  };
  (producer as any).isConnected = true;

  return run(producer).then(() => sent);
}

function sampleEvents(count: number): SensorEvent[] {
  const zones = ZoneGenerator.generate({ count, layout: 'regional-grid', seed: 42 });
  return zones.map((zone, i) =>
    LoadGenerator.generateEvent(zone, 'regional-anomaly', START + i * 1000)
  );
}

describe('D10 — the Kafka record timestamp is not simulated event time', () => {
  it('sends a single event with no record timestamp at all', async () => {
    const [event] = sampleEvents(1);
    const records = await captureRecords((producer) => producer.sendEvent(event));

    expect(records).toHaveLength(1);
    for (const message of records[0].messages) {
      // Absent, so kafkajs lets the broker stamp it. Not "some other number" — any value the
      // producer invents here is a claim about data ageing that it has no standing to make.
      expect(message.timestamp).toBeUndefined();
    }
  });

  it('sends a batch with no record timestamps', async () => {
    const events = sampleEvents(24);
    const records = await captureRecords((producer) => producer.sendEvents(events));

    const messages = records.flatMap((record) => record.messages);
    expect(messages.length).toBe(events.length);
    for (const message of messages) {
      expect(message.timestamp).toBeUndefined();
    }
  });

  it('never puts the simulated epoch anywhere the broker would read as a record age', async () => {
    // The specific failure, stated as itself: no message may carry a timestamp field whose value
    // is the simulated event time. This is what regressed, and it is what must not come back.
    const events = sampleEvents(24);
    const eventTimes = new Set(events.map((e) => String(e.eventTimestamp)));
    const records = await captureRecords((producer) => producer.sendEvents(events));

    for (const message of records.flatMap((r) => r.messages)) {
      expect(eventTimes.has(String(message.timestamp))).toBe(false);
    }
  });

  it('still carries event time in the payload, which is where consumers read it', async () => {
    // The fix must not be a data loss. Event time is unchanged; it simply travels in the value
    // rather than in a broker-owned header field.
    const events = sampleEvents(12);
    const records = await captureRecords((producer) => producer.sendEvents(events));

    const decoded: SensorEvent[] = records
      .flatMap((r) => r.messages)
      .map((m: any) => JSON.parse(m.value));

    expect(decoded).toHaveLength(events.length);
    for (const event of events) {
      const match = decoded.find((d) => d.eventId === event.eventId);
      expect(match).toBeDefined();
      expect(match!.eventTimestamp).toBe(event.eventTimestamp);
    }
  });

  it('keeps keying by zone id, so per-zone ordering survives the change', async () => {
    // Removing a field from the message is the kind of edit that quietly takes the key with it,
    // and the key is what keeps a zone's events on one partition and therefore in order.
    const events = sampleEvents(24);
    const records = await captureRecords((producer) => producer.sendEvents(events));

    for (const message of records.flatMap((r) => r.messages)) {
      const payload: SensorEvent = JSON.parse(message.value);
      expect(message.key).toBe(payload.zoneId);
    }
  });
});
