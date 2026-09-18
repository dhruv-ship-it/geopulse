import { IncidentDispatcher } from '../incidentDispatcher';
import { IncidentStore } from '../incidentStore';
import { IncidentPublisher } from '../kafkaProducer';
import { IncidentWireEvent } from '../types';

const event = (incidentId: string): IncidentWireEvent => ({
  incidentId,
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
  h3CoarseCell: 'coarse-a'
});

function harness() {
  const published: string[][] = [];
  const written: string[][] = [];
  let publishFails = 0;
  let storeFails = 0;

  const publisher: IncidentPublisher = {
    publish: async (events) => {
      if (publishFails > 0) {
        publishFails--;
        throw new Error('kafka is down');
      }
      published.push(events.map((e) => e.incidentId));
    }
  };

  const store = {
    apply: async (events: readonly IncidentWireEvent[]) => {
      if (storeFails > 0) {
        storeFails--;
        throw new Error('redis is down');
      }
      written.push(events.map((e) => e.incidentId));
    }
  } as unknown as IncidentStore;

  return {
    published,
    written,
    dispatcher: new IncidentDispatcher(publisher, store),
    failPublish: (times: number) => {
      publishFails = times;
    },
    failStore: (times: number) => {
      storeFails = times;
    }
  };
}

describe('IncidentDispatcher', () => {
  it('publishes to Kafka before writing Redis', async () => {
    const order: string[] = [];
    const publisher: IncidentPublisher = {
      publish: async () => void order.push('kafka')
    };
    const store = { apply: async () => void order.push('redis') } as unknown as IncidentStore;

    await new IncidentDispatcher(publisher, store).dispatch([event('INC-a')]);

    expect(order).toEqual(['kafka', 'redis']);
  });

  it('does nothing when there is nothing to dispatch', async () => {
    const h = harness();
    await h.dispatcher.dispatch([]);
    expect(h.published).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.dispatcher.stats().flushes).toBe(0);
  });

  it('clears its buffer on success', async () => {
    const h = harness();
    await h.dispatcher.dispatch([event('INC-a')]);
    await h.dispatcher.dispatch([event('INC-b')]);

    expect(h.published).toEqual([['INC-a'], ['INC-b']]);
    expect(h.dispatcher.stats().pending).toBe(0);
    expect(h.dispatcher.stats().dispatched).toBe(2);
  });

  /**
   * The reason this class exists. A failed flush must not lose its events, because the batch
   * redelivery that follows re-folds the same messages into the same in-memory state and emits
   * nothing at all — there is no transition left to describe.
   */
  it('holds events when the publish fails, and sends them on the next attempt', async () => {
    const h = harness();
    h.failPublish(1);

    await expect(h.dispatcher.dispatch([event('INC-a')])).rejects.toThrow('kafka is down');
    expect(h.dispatcher.stats().pending).toBe(1);
    expect(h.published).toEqual([]);

    // The retried batch re-folds to the same state and emits nothing; the held event still goes.
    await h.dispatcher.dispatch([]);

    expect(h.published).toEqual([['INC-a']]);
    expect(h.written).toEqual([['INC-a']]);
    expect(h.dispatcher.stats().pending).toBe(0);
    expect(h.dispatcher.stats().retainedFlushes).toBe(1);
  });

  it('holds events when the Redis write fails, republishing on retry', async () => {
    const h = harness();
    h.failStore(1);

    await expect(h.dispatcher.dispatch([event('INC-a')])).rejects.toThrow('redis is down');
    await h.dispatcher.dispatch([]);

    // At-least-once: the event is on the topic twice. Ids are deterministic (ADR-003), so the
    // duplicate is byte-identical and a consumer keyed by id converges either way.
    expect(h.published).toEqual([['INC-a'], ['INC-a']]);
    expect(h.written).toEqual([['INC-a']]);
  });

  it('accumulates across several failed flushes and sends them all at once', async () => {
    const h = harness();
    h.failPublish(2);

    await expect(h.dispatcher.dispatch([event('INC-a')])).rejects.toThrow();
    await expect(h.dispatcher.dispatch([event('INC-b')])).rejects.toThrow();
    await h.dispatcher.dispatch([event('INC-c')]);

    expect(h.published).toEqual([['INC-a', 'INC-b', 'INC-c']]);
    expect(h.dispatcher.stats().flushes).toBe(1);
    expect(h.dispatcher.stats().retainedFlushes).toBe(2);
  });

  it('keeps the order events were reconciled in', async () => {
    const h = harness();
    h.failPublish(1);

    await expect(
      h.dispatcher.dispatch([event('INC-a'), event('INC-b')])
    ).rejects.toThrow();
    await h.dispatcher.dispatch([event('INC-c')]);

    // A lifecycle stream is only readable in order: a MERGED that arrives before the OPENED it
    // refers to describes an incident the consumer has never heard of.
    expect(h.published[0]).toEqual(['INC-a', 'INC-b', 'INC-c']);
  });
});
