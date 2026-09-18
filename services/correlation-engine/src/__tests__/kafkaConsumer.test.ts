import { EachBatchPayload } from 'kafkajs';

import { KafkaDegradationConsumer } from '../kafkaConsumer';
import { ZoneDegradation } from '../types';

const T0 = 1768478400000;

const degradation = (zoneId: string, eventTime: number): ZoneDegradation => ({
  zoneId,
  h3Cell: `cell-${zoneId}`,
  h3CoarseCell: 'coarse-a',
  latitude: 30,
  longitude: 70,
  previousState: 'NORMAL',
  currentState: 'STRESSED',
  severity: 0.8,
  avg1m: 0.8,
  avg5m: 0.78,
  eventTime
});

interface BatchOptions {
  values: Array<Buffer | null>;
  isRunning?: boolean;
  isStale?: boolean;
}

function fakeBatch(options: BatchOptions) {
  const resolved: string[] = [];
  const heartbeats = { count: 0 };

  const payload = {
    batch: {
      topic: 'zone.degradations',
      partition: 3,
      messages: options.values.map((value, index) => ({
        key: null,
        value,
        offset: String(100 + index),
        timestamp: '0',
        attributes: 0,
        headers: {}
      }))
    },
    resolveOffset: (offset: string) => void resolved.push(offset),
    heartbeat: async () => void heartbeats.count++,
    isRunning: () => options.isRunning ?? true,
    isStale: () => options.isStale ?? false,
    commitOffsetsIfNecessary: async () => undefined,
    uncommittedOffsets: () => ({}) as any,
    pause: () => () => undefined
  } as unknown as EachBatchPayload;

  return { payload, resolved, heartbeats };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function consumer(maxBatchSize = 1000) {
  return new KafkaDegradationConsumer({
    broker: 'localhost:9092',
    topic: 'zone.degradations',
    groupId: 'correlation-engine-test',
    fromBeginning: false,
    maxBatchSize
  });
}

describe('KafkaDegradationConsumer.processBatch', () => {
  it('hands the whole batch to the handler as one unit', async () => {
    const seen: ZoneDegradation[][] = [];
    const { payload, resolved } = fakeBatch({
      values: [
        json(degradation('Z-1', T0)),
        json(degradation('Z-2', T0 + 1)),
        json(degradation('Z-3', T0 + 2))
      ]
    });

    await consumer().processBatch(payload, async (messages) => void seen.push(messages));

    // One call, three messages — this is the eachBatch contract the engine's consolidation
    // depends on. Three calls of one message each would be eachMessage with extra steps.
    expect(seen).toHaveLength(1);
    expect(seen[0].map((m) => m.zoneId)).toEqual(['Z-1', 'Z-2', 'Z-3']);
    expect(resolved).toEqual(['100', '101', '102']);
  });

  it('resolves no offset when the handler throws', async () => {
    const { payload, resolved } = fakeBatch({ values: [json(degradation('Z-1', T0))] });

    await expect(
      consumer().processBatch(payload, async () => {
        throw new Error('redis is down');
      })
    ).rejects.toThrow('redis is down');

    // Defect D1, asserted: a failure must not look like a success to kafkajs.
    expect(resolved).toEqual([]);
  });

  it('resolves offsets only after the handler has returned', async () => {
    const order: string[] = [];
    const { payload } = fakeBatch({ values: [json(degradation('Z-1', T0))] });

    await consumer().processBatch(payload, async () => {
      order.push('handled');
    });
    order.push('resolved');

    expect(order).toEqual(['handled', 'resolved']);
  });

  it('skips a message that is not valid JSON but still resolves its offset', async () => {
    const seen: ZoneDegradation[][] = [];
    const { payload, resolved } = fakeBatch({
      values: [json(degradation('Z-1', T0)), Buffer.from('{not json'), json(degradation('Z-2', T0))]
    });
    const subject = consumer();

    await subject.processBatch(payload, async (messages) => void seen.push(messages));

    expect(seen[0].map((m) => m.zoneId)).toEqual(['Z-1', 'Z-2']);
    // A message that cannot be parsed now cannot be parsed later either. Leaving its offset
    // unresolved would stall the partition forever on one bad byte.
    expect(resolved).toEqual(['100', '101', '102']);
    expect(subject.stats().unparseable).toBe(1);
  });

  it('counts a tombstone rather than crashing on it', async () => {
    const { payload, resolved } = fakeBatch({ values: [null, json(degradation('Z-1', T0))] });
    const subject = consumer();

    await subject.processBatch(payload, async () => undefined);

    expect(subject.stats().skipped).toBe(1);
    expect(resolved).toEqual(['100', '101']);
  });

  it('drops a stale batch without resolving or handling anything', async () => {
    const handler = jest.fn();
    const { payload, resolved } = fakeBatch({
      values: [json(degradation('Z-1', T0))],
      isStale: true
    });

    await consumer().processBatch(payload, handler);

    // The partition has been reassigned; folding these messages would update a window whose
    // partition now belongs to another consumer.
    expect(handler).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
  });

  it('drops a batch fetched while shutting down', async () => {
    const handler = jest.fn();
    const { payload, resolved } = fakeBatch({
      values: [json(degradation('Z-1', T0))],
      isRunning: false
    });

    await consumer().processBatch(payload, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
  });

  it('slices an oversized batch and heartbeats between slices', async () => {
    const sizes: number[] = [];
    const { payload, resolved, heartbeats } = fakeBatch({
      values: Array.from({ length: 5 }, (_, index) => json(degradation(`Z-${index}`, T0 + index)))
    });

    await consumer(2).processBatch(payload, async (messages) => void sizes.push(messages.length));

    expect(sizes).toEqual([2, 2, 1]);
    expect(resolved).toEqual(['100', '101', '102', '103', '104']);
    // A fold long enough to miss the session timeout gets the consumer evicted mid-batch, which
    // then redelivers to somebody else and looks exactly like a slow consumer getting slower.
    expect(heartbeats.count).toBe(3);
  });

  it('stops slicing the moment the batch goes stale', async () => {
    let stale = false;
    const seen: number[] = [];
    const { payload, resolved } = fakeBatch({
      values: Array.from({ length: 6 }, (_, index) => json(degradation(`Z-${index}`, T0 + index)))
    });
    (payload as any).isStale = () => stale;

    await consumer(2).processBatch(payload, async (messages) => {
      seen.push(messages.length);
      stale = true;
    });

    expect(seen).toEqual([2]);
    expect(resolved).toEqual(['100', '101']);
  });

  it('refuses to start consuming before it is connected', async () => {
    await expect(consumer().startConsuming(async () => undefined)).rejects.toThrow('not connected');
  });
});
