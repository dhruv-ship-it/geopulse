import { CorrelationEngine } from '../correlationEngine';
import { AdjacencyProvider } from '../core';
import { IncidentWireEvent, ZoneDegradation, ZoneState } from '../types';

/**
 * The reconcile grid: the fix for the one caveat that stood on this project's determinism claim.
 *
 * Until the first end-to-end run the lifecycle reconciled once per Kafka batch. `openedAt` is in
 * the incident id preimage (ADR-003) and `openedAt` is the reconcile watermark, so an incident's
 * *name* depended on where the broker happened to draw a batch boundary. Output was byte-identical
 * only for a fixed batching — a property of the fetch, not of the data — and CLAUDE.md rule 3
 * treats determinism as load-bearing.
 *
 * These tests assert the property that replaces it: **the output is a function of the messages
 * alone.** They use `engine.applyBatch` directly rather than the flushing helper in
 * `correlationEngine.test.ts`, because flushing is exactly what a live consumer does not do.
 */

/** The simulator's fixed epoch (ADR-005), and a multiple of the tick. */
const T0 = 1768478400000;

const OPTIONS = {
  windowMs: 120000,
  compactionIntervalMs: 5000,
  minZones: 3,
  closeGraceMs: 60000
};

const TICK = OPTIONS.compactionIntervalMs;

class Lattice implements AdjacencyProvider {
  private readonly edges = new Map<string, string[]>();

  constructor(pairs: ReadonlyArray<readonly [string, string]>) {
    for (const [a, b] of pairs) {
      this.link(a, b);
      this.link(b, a);
    }
  }

  neighboursOf(zoneId: string): readonly string[] {
    return this.edges.get(zoneId) ?? [];
  }

  private link(from: string, to: string): void {
    const existing = this.edges.get(from);
    if (existing === undefined) {
      this.edges.set(from, [to]);
    } else if (!existing.includes(to)) {
      existing.push(to);
    }
  }
}

const noPlacer = { observe: () => undefined };

function degradation(
  zoneId: string,
  eventTime: number,
  overrides: Partial<ZoneDegradation> = {}
): ZoneDegradation {
  const index = Number(zoneId.replace(/\D/g, '')) || 0;
  return {
    zoneId,
    h3Cell: `cell-${zoneId}`,
    h3CoarseCell: 'coarse-a',
    latitude: 30 + index * 0.01,
    longitude: 70 + index * 0.01,
    previousState: 'NORMAL',
    currentState: 'STRESSED' as ZoneState,
    severity: 0.8,
    avg1m: 0.8,
    avg5m: 0.78,
    eventTime,
    ...overrides
  };
}

const triangle = () =>
  new Lattice([
    ['Z-1', 'Z-2'],
    ['Z-2', 'Z-3'],
    ['Z-1', 'Z-3']
  ]);

/** A path graph, so an arbitrary number of zones still forms one component. */
function chain(count: number): AdjacencyProvider {
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 1; i < count; i++) {
    pairs.push([`Z-${i}`, `Z-${i + 1}`] as const);
  }
  return new Lattice(pairs);
}

function burst(count: number, from: number, stepMs: number): ZoneDegradation[] {
  return Array.from({ length: count }, (_, i) => degradation(`Z-${i + 1}`, from + i * stepMs));
}

/** Run one message stream through a fresh engine under a given batching, collecting everything. */
function runWithBatching(
  messages: readonly ZoneDegradation[],
  batchSizes: readonly number[]
): IncidentWireEvent[] {
  const engine = new CorrelationEngine(chain(messages.length), noPlacer, OPTIONS);
  const emitted: IncidentWireEvent[] = [];

  let cursor = 0;
  let sizeIndex = 0;
  while (cursor < messages.length) {
    const size = batchSizes[sizeIndex % batchSizes.length];
    emitted.push(...engine.applyBatch(messages.slice(cursor, cursor + size)));
    cursor += size;
    sizeIndex++;
  }
  emitted.push(...engine.flush());
  return emitted;
}

describe('CorrelationEngine — batching independence', () => {
  /**
   * The headline property, and the whole reason the change was worth making. Same messages, four
   * wildly different batchings — one at a time, all at once, and two irregular rhythms —
   * byte-identical output, incident ids included.
   */
  it('produces identical output under any batching, ids included', () => {
    const messages = burst(12, T0, 1500);

    const oneAtATime = runWithBatching(messages, [1]);
    const allAtOnce = runWithBatching(messages, [messages.length]);
    const lumpy = runWithBatching(messages, [5, 1, 3, 2, 1]);
    const pairs = runWithBatching(messages, [2]);

    expect(oneAtATime.length).toBeGreaterThan(0);
    const reference = JSON.stringify(oneAtATime);
    expect(JSON.stringify(allAtOnce)).toBe(reference);
    expect(JSON.stringify(lumpy)).toBe(reference);
    expect(JSON.stringify(pairs)).toBe(reference);
  });

  it('puts every event time on a tick multiple, which is what makes the ids stable', () => {
    // T0 + 137 is deliberately off-grid: the anchor is a multiple of the tick, not the first
    // message's own timestamp, so a replay and a consumer joining mid-stream agree on boundaries.
    const emitted = runWithBatching(burst(9, T0 + 137, 900), [3]);

    expect(emitted.length).toBeGreaterThan(0);
    for (const event of emitted) {
      expect(event.openedAt % TICK).toBe(0);
      expect(event.updatedAt % TICK).toBe(0);
    }
  });
});

describe('CorrelationEngine — the reconcile grid', () => {
  it('emits nothing for a batch that lies entirely inside one tick', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);

    // Three adjacent zones, comfortably an incident — but all inside one tick, so no boundary has
    // been completed and there is nothing yet that can be said without guessing.
    const events = engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);

    expect(events).toEqual([]);
    expect(engine.stats().ticks).toBe(0);
  });

  it('announces that batch as soon as any later message crosses the boundary', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);

    const events = engine.applyBatch([degradation('Z-1', T0 + 6000)]);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('OPENED');
    expect(events[0].memberZones).toEqual(['Z-1', 'Z-2', 'Z-3']);
    expect(events[0].openedAt).toBe(T0 + 5000);
  });

  it('crosses every boundary a long gap spans, not just the last one', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);

    // Jump 50 seconds. The members are still live under a 120 s window, so the fast-forward
    // cannot apply and every one of the ten intervening boundaries is genuinely reconciled.
    engine.applyBatch([degradation('Z-1', T0 + 52000)]);

    expect(engine.stats().ticks).toBe(10);
    expect(engine.stats().ticksSkipped).toBe(0);
  });

  it('fast-forwards a quiet stretch instead of running thousands of empty reconciles', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);

    // One lone zone: never an incident, and its window lapses long before the next message, so
    // there is provably nothing for the intervening reconciles to do.
    engine.applyBatch([degradation('Z-1', T0)]);
    engine.applyBatch([degradation('Z-1', T0 + 4 * 60 * 60 * 1000)]);

    const stats = engine.stats();
    // Four simulated hours at a 5 s tick would otherwise be 2,880 no-op reconciles.
    expect(stats.ticks).toBeLessThan(40);
    expect(stats.ticksSkipped).toBeGreaterThan(2800);
    expect(stats.incidents.opened).toBe(0);
  });

  it('honours a reconcile tick separate from the compaction interval', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, {
      ...OPTIONS,
      reconcileTickMs: 20000
    });

    engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);
    // Past the 5 s compaction interval but well inside the 20 s reconcile tick: still silent.
    expect(engine.applyBatch([degradation('Z-1', T0 + 9000)])).toEqual([]);

    const events = engine.applyBatch([degradation('Z-1', T0 + 21000)]);
    expect(events).toHaveLength(1);
    expect(events[0].openedAt).toBe(T0 + 20000);
  });

  it('rejects a non-positive reconcile tick rather than looping forever', () => {
    expect(
      () => new CorrelationEngine(triangle(), noPlacer, { ...OPTIONS, reconcileTickMs: 0 })
    ).toThrow(/reconcileTickMs must be positive/);
  });
});

describe('CorrelationEngine — flush', () => {
  it('closes out the final partial tick, on the grid', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);

    const [opened] = engine.flush();

    expect(opened.eventType).toBe('OPENED');
    // The boundary closing the interval the last message fell in — a tick multiple, not the
    // watermark, so an end-of-stream flush cannot put an off-grid value into an id preimage.
    expect(opened.openedAt).toBe(T0 + 5000);
  });

  it('is idempotent, so a second flush invents no event time', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0 + 1000),
      degradation('Z-2', T0 + 1500),
      degradation('Z-3', T0 + 2000)
    ]);

    const first = engine.flush();
    const watermark = engine.watermark;

    expect(first).toHaveLength(1);
    expect(engine.flush()).toEqual([]);
    expect(engine.watermark).toBe(watermark);
  });

  it('does nothing on an engine that has never seen a message', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    expect(engine.flush()).toEqual([]);
    expect(engine.stats().ticks).toBe(0);
  });
});
