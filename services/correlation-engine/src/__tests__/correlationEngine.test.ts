import { NeighbourGraph } from '@geopulse/spatial';

import { CorrelationEngine, rejectionReason } from '../correlationEngine';
import { AdjacencyProvider } from '../core';
import { IncidentWireEvent, ZoneDegradation, ZoneState } from '../types';

/** The simulator's fixed epoch (ADR-005), so timestamps here look like the real ones. */
const T0 = 1768478400000;

const OPTIONS = {
  windowMs: 120000,
  compactionIntervalMs: 5000,
  minZones: 3,
  closeGraceMs: 60000
};

/**
 * A hand-built adjacency, so a test says what the geometry is instead of depending on where H3
 * happens to put a coordinate. `NeighbourGraph` satisfies the same interface, and
 * `buildsIncidentsOverTheRealGraph` below uses the real one.
 */
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

const recovery = (zoneId: string, eventTime: number): ZoneDegradation =>
  degradation(zoneId, eventTime, { previousState: 'STRESSED', currentState: 'NORMAL' });

/** A triangle: every zone adjacent to every other, so three degradations make one component. */
const triangle = () => new Lattice([['Z-1', 'Z-2'], ['Z-2', 'Z-3'], ['Z-1', 'Z-3']]);

describe('CorrelationEngine — the collapse', () => {
  it('turns a burst of adjacent degradations into exactly one incident', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);

    const events = engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0 + 1000),
      degradation('Z-3', T0 + 2000)
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('OPENED');
    expect(events[0].memberZones).toEqual(['Z-1', 'Z-2', 'Z-3']);
    expect(events[0].status).toBe('OPEN');
    // The whole thesis, in one assertion: three degradation messages in, one incident event out.
    expect(engine.stats().degradations).toBe(3);
    expect(engine.stats().emitted).toBe(1);
  });

  it('does not open an incident below the minimum size', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const events = engine.applyBatch([degradation('Z-1', T0), degradation('Z-2', T0 + 1000)]);
    expect(events).toEqual([]);
  });

  it('does not join zones that are not adjacent, however simultaneous they are', () => {
    // Three zones, no edges at all: three singleton components, no incident.
    const engine = new CorrelationEngine(new Lattice([]), noPlacer, OPTIONS);
    const events = engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);
    expect(events).toEqual([]);
  });

  it('emits one consolidated GREW for a burst rather than one per zone', () => {
    const lattice = new Lattice([
      ['Z-1', 'Z-2'],
      ['Z-2', 'Z-3'],
      ['Z-3', 'Z-4'],
      ['Z-4', 'Z-5']
    ]);
    const engine = new CorrelationEngine(lattice, noPlacer, OPTIONS);

    engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);
    const grown = engine.applyBatch([
      degradation('Z-4', T0 + 1000),
      degradation('Z-5', T0 + 1100)
    ]);

    // This is the eachBatch argument, asserted: two zones joined, one event describes it.
    expect(grown).toHaveLength(1);
    expect(grown[0].eventType).toBe('GREW');
    expect(grown[0].memberZones).toEqual(['Z-1', 'Z-2', 'Z-3', 'Z-4', 'Z-5']);
  });

  it('merges two incidents when a zone bridges them, and points the loser at the survivor', () => {
    const lattice = new Lattice([
      ['A-1', 'A-2'],
      ['A-2', 'A-3'],
      ['A-1', 'A-3'],
      ['B-1', 'B-2'],
      ['B-2', 'B-3'],
      ['B-1', 'B-3'],
      // The bridge, adjacent to one member of each side.
      ['X-1', 'A-3'],
      ['X-1', 'B-1']
    ]);
    const engine = new CorrelationEngine(lattice, noPlacer, OPTIONS);

    const first = engine.applyBatch([
      degradation('A-1', T0),
      degradation('A-2', T0),
      degradation('A-3', T0)
    ]);
    const second = engine.applyBatch([
      degradation('B-1', T0 + 1000),
      degradation('B-2', T0 + 1000),
      degradation('B-3', T0 + 1000)
    ]);
    const merged = engine.applyBatch([degradation('X-1', T0 + 2000)]);

    const survivor = merged.find((event) => event.eventType === 'MERGED');
    const loser = merged.find((event) => event.eventType === 'CLOSED');
    expect(survivor).toBeDefined();
    expect(loser).toBeDefined();
    // Merge is won by age (ADR-003), and the A incident opened first.
    expect(survivor!.incidentId).toBe(first[0].incidentId);
    expect(loser!.incidentId).toBe(second[0].incidentId);
    expect(loser!.closeReason).toBe('SUPERSEDED');
    expect(loser!.supersededBy).toBe(survivor!.incidentId);
    expect(survivor!.mergedFrom).toEqual([second[0].incidentId]);
    expect(survivor!.memberCount).toBe(7);
  });
});

describe('CorrelationEngine — membership over time', () => {
  it('releases a member the moment it recovers, without waiting out the window', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);

    const shrunk = engine.applyBatch([recovery('Z-3', T0 + 1000)]);

    expect(shrunk).toHaveLength(1);
    expect(shrunk[0].eventType).toBe('SHRANK');
    expect(shrunk[0].memberZones).toEqual(['Z-1', 'Z-2']);
    // Below the minimum, but inside the grace period: still live, and a consumer is told both.
    expect(shrunk[0].status).toBe('OPEN');
    expect(shrunk[0].lifecycleStatus).toBe('DRAINING');
    expect(engine.stats().recoveries).toBe(1);
  });

  it('closes a draining incident once its grace period elapses in event time', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);
    engine.applyBatch([recovery('Z-3', T0 + 1000), recovery('Z-2', T0 + 1000)]);

    // An unrelated zone keeps event time moving; nothing else happens.
    const closed = engine.applyBatch([degradation('Z-far', T0 + 70000)]);

    const close = closed.find((event) => event.eventType === 'CLOSED');
    expect(close).toBeDefined();
    expect(close!.closeReason).toBe('GRACE_EXPIRED');
    expect(close!.status).toBe('CLOSED');
    expect(close!.closedAt).toBe(T0 + 70000);
  });

  it('expires members whose window ran out, and dissolves the incident with them', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const opened = engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);

    // Past every member's deadline. Nothing refreshed them, so the sweep takes all three.
    const closed = engine.applyBatch([degradation('Z-far', T0 + 130000)]);

    const close = closed.find((event) => event.eventType === 'CLOSED');
    expect(close).toBeDefined();
    expect(close!.incidentId).toBe(opened[0].incidentId);
    expect(close!.closeReason).toBe('DISSOLVED');
    expect(close!.memberZones).toEqual([]);
    // Nothing is left to measure, so the last known footprint is reported rather than a
    // zeroed one at latitude 0.
    expect(close!.footprint.h3Cells).toEqual(['cell-Z-1', 'cell-Z-2', 'cell-Z-3']);
    expect(close!.severity).toBeGreaterThan(0);
  });

  it('refuses a degradation whose whole window already lies behind the watermark', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([degradation('Z-1', T0 + 500000)]);

    const events = engine.applyBatch([degradation('Z-2', T0)]);

    expect(events).toEqual([]);
    expect(engine.stats().stale).toBe(1);
    expect(engine.stats().window.members).toBe(1);
  });

  it('keeps a member alive while it keeps re-degrading', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);

    // Refresh all three every 30s for five minutes of event time — well past windowMs.
    for (let offset = 30000; offset <= 300000; offset += 30000) {
      engine.applyBatch([
        degradation('Z-1', T0 + offset),
        degradation('Z-2', T0 + offset),
        degradation('Z-3', T0 + offset)
      ]);
    }

    expect(engine.stats().window.members).toBe(3);
    expect(engine.stats().incidents.activeIncidents).toBe(1);
  });
});

describe('CorrelationEngine — the wire event', () => {
  it('carries the footprint, severity and a fixed coarse-cell key', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const [opened] = engine.applyBatch([
      degradation('Z-1', T0, { h3CoarseCell: 'coarse-m', severity: 0.6 }),
      degradation('Z-2', T0, { h3CoarseCell: 'coarse-b', severity: 0.9 }),
      degradation('Z-3', T0, { h3CoarseCell: 'coarse-z', severity: 0.7 })
    ]);

    expect(opened.severity).toBeCloseTo(0.9, 10);
    expect(opened.peakSeverity).toBeCloseTo(0.9, 10);
    expect(opened.footprint.h3Cells).toEqual(['cell-Z-1', 'cell-Z-2', 'cell-Z-3']);
    expect(opened.footprint.radiusKm).toBeGreaterThan(0);
    // The smallest coarse cell among the founding members, by rule rather than by arrival order.
    expect(opened.h3CoarseCell).toBe('coarse-b');
    expect(opened.propagation).toBeNull();
    expect(opened.openedAt).toBe(T0);
    expect(opened.updatedAt).toBe(T0);
    expect(opened.closedAt).toBeNull();
  });

  it('keeps the partition key fixed as the incident grows into another coarse cell', () => {
    const lattice = new Lattice([
      ['Z-1', 'Z-2'],
      ['Z-2', 'Z-3'],
      ['Z-3', 'Z-4']
    ]);
    const engine = new CorrelationEngine(lattice, noPlacer, OPTIONS);

    const [opened] = engine.applyBatch([
      degradation('Z-1', T0, { h3CoarseCell: 'coarse-m' }),
      degradation('Z-2', T0, { h3CoarseCell: 'coarse-m' }),
      degradation('Z-3', T0, { h3CoarseCell: 'coarse-m' })
    ]);
    const [grown] = engine.applyBatch([
      degradation('Z-4', T0 + 1000, { h3CoarseCell: 'coarse-a' })
    ]);

    // 'coarse-a' sorts first, but the key was fixed at OPEN: an incident's events must not
    // scatter across partitions half way through its life.
    expect(grown.h3CoarseCell).toBe('coarse-m');
    expect(opened.h3CoarseCell).toBe('coarse-m');
  });

  it('tracks peak severity separately from current severity', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0, { severity: 0.95 }),
      degradation('Z-2', T0, { severity: 0.6 }),
      degradation('Z-3', T0, { severity: 0.6 })
    ]);

    const [shrunk] = engine.applyBatch([recovery('Z-1', T0 + 1000)]);

    expect(shrunk.severity).toBeCloseTo(0.6, 10);
    expect(shrunk.peakSeverity).toBeCloseTo(0.95, 10);
  });

  it('rolls severity up as a maximum, not a mean', () => {
    const lattice = new Lattice([
      ['Z-1', 'Z-2'],
      ['Z-2', 'Z-3'],
      ['Z-3', 'Z-4']
    ]);
    const engine = new CorrelationEngine(lattice, noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0, { severity: 0.99 }),
      degradation('Z-2', T0, { severity: 0.5 }),
      degradation('Z-3', T0, { severity: 0.5 })
    ]);
    const [grown] = engine.applyBatch([degradation('Z-4', T0 + 1000, { severity: 0.5 })]);

    // A mean would have this incident looking *better* for having spread, which is backwards.
    expect(grown.severity).toBeCloseTo(0.99, 10);
  });
});

describe('CorrelationEngine — unusable input', () => {
  it.each([
    ['not-an-object', null],
    ['missing-zone-id', { ...degradation('Z-1', T0), zoneId: '' }],
    ['missing-event-time', { ...degradation('Z-1', T0), eventTime: Number.NaN }],
    ['missing-position', { ...degradation('Z-1', T0), latitude: Number.NaN }],
    ['position-out-of-range', { ...degradation('Z-1', T0), latitude: 91 }],
    ['unknown-state', { ...degradation('Z-1', T0), currentState: 'MELTED' }],
    ['missing-severity', { ...degradation('Z-1', T0), severity: undefined }]
  ])('names %s as the rejection reason', (reason, message) => {
    expect(rejectionReason(message)).toBe(reason);
  });

  it('accepts a well-formed message', () => {
    expect(rejectionReason(degradation('Z-1', T0))).toBeNull();
  });

  it('skips a poison message and correlates the rest of the batch', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const events = engine.applyBatch([
      degradation('Z-1', T0),
      { ...degradation('Z-bad', T0), latitude: Number.NaN },
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].memberZones).toEqual(['Z-1', 'Z-2', 'Z-3']);
    expect(engine.stats().rejected).toBe(1);
  });

  it('does nothing at all for a batch that was entirely unusable', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);
    const watermark = engine.watermark;

    expect(engine.applyBatch([{ ...degradation('Z-4', T0 + 1000), zoneId: '' }])).toEqual([]);
    expect(engine.watermark).toBe(watermark);
  });

  it('returns nothing for an empty batch', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    expect(engine.applyBatch([])).toEqual([]);
    expect(engine.stats().batches).toBe(0);
  });
});

describe('CorrelationEngine — determinism', () => {
  /** The sequence both replays are driven through, batched identically each time. */
  const script: ZoneDegradation[][] = [
    [degradation('Z-1', T0), degradation('Z-2', T0 + 500)],
    [degradation('Z-3', T0 + 1000)],
    [degradation('Z-1', T0 + 30000), degradation('Z-2', T0 + 30100)],
    [recovery('Z-2', T0 + 40000)],
    [degradation('Z-2', T0 + 45000)],
    [degradation('Z-far', T0 + 200000)],
    [degradation('Z-1', T0 + 210000), degradation('Z-2', T0 + 210000), degradation('Z-3', T0 + 210000)]
  ];

  function replay(): string {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const emitted: IncidentWireEvent[] = [];
    for (const batch of script) {
      emitted.push(...engine.applyBatch(batch));
    }
    return emitted.map((event) => JSON.stringify(event)).join('\n');
  }

  it('replays byte-identically, incident ids included', () => {
    const first = replay();
    const second = replay();
    expect(second).toBe(first);
    // A run that emitted nothing would satisfy the above while proving nothing.
    expect(first.length).toBeGreaterThan(0);
    expect(first).toContain('"eventType":"OPENED"');
  });

  it('mints ids in the documented shape', () => {
    const engine = new CorrelationEngine(triangle(), noPlacer, OPTIONS);
    const [opened] = engine.applyBatch([
      degradation('Z-1', T0),
      degradation('Z-2', T0),
      degradation('Z-3', T0)
    ]);
    expect(opened.incidentId).toMatch(/^INC-[0-9a-f]{16}$/);
  });

  it('reads no wall clock on any path that decides anything', () => {
    // Rule 3 in CLAUDE.md. `src/core` has its own grep-based guard; this is the service layer's,
    // and it is narrower on purpose: the engine does read the wall clock, as a stopwatch around
    // compaction — two reads, start and stop — whose difference goes to a histogram and nowhere
    // else. A third would mean something new started asking what time it is, which is worth a
    // deliberate look rather than a silent pass.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'correlationEngine.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/new Date\(/);
    expect((source.match(/Date\.now\(\)/g) ?? []).length).toBe(2);
  });
});

describe('CorrelationEngine — over the real neighbour graph', () => {
  it('correlates zones that H3 actually places next to each other', () => {
    const graph = new NeighbourGraph();
    // A tight cluster: a few km apart, comfortably inside one H3 res-5 ring.
    graph.build([
      { zoneId: 'Z-1', latitude: 30.0, longitude: 70.0 },
      { zoneId: 'Z-2', latitude: 30.02, longitude: 70.02 },
      { zoneId: 'Z-3', latitude: 30.04, longitude: 70.01 },
      // Far away: hundreds of km, so it cannot be adjacent to any of the above.
      { zoneId: 'Z-9', latitude: 34.0, longitude: 76.0 }
    ]);
    const engine = new CorrelationEngine(graph, noPlacer, OPTIONS);

    const events = engine.applyBatch([
      degradation('Z-1', T0, { latitude: 30.0, longitude: 70.0 }),
      degradation('Z-2', T0, { latitude: 30.02, longitude: 70.02 }),
      degradation('Z-3', T0, { latitude: 30.04, longitude: 70.01 }),
      degradation('Z-9', T0, { latitude: 34.0, longitude: 76.0 })
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].memberZones).toEqual(['Z-1', 'Z-2', 'Z-3']);
    // The distant zone degraded at the same instant and is deliberately not in it. That is the
    // whole point: simultaneity is not correlation, geometry is.
    expect(events[0].memberZones).not.toContain('Z-9');
    expect(events[0].footprint.radiusKm).toBeLessThan(25);
  });

  it('places a zone it has never been told about, from the degradation message itself', () => {
    const graph = new NeighbourGraph();
    graph.build([{ zoneId: 'Z-1', latitude: 30.0, longitude: 70.0 }]);

    // The placer the service wires in is ZoneRegistry, which does exactly this.
    const placer = {
      observe: (message: ZoneDegradation) =>
        void graph.addZone({
          zoneId: message.zoneId,
          latitude: message.latitude,
          longitude: message.longitude
        })
    };
    const engine = new CorrelationEngine(graph, placer, OPTIONS);

    const events = engine.applyBatch([
      degradation('Z-1', T0, { latitude: 30.0, longitude: 70.0 }),
      degradation('Z-new-a', T0, { latitude: 30.02, longitude: 70.02 }),
      degradation('Z-new-b', T0, { latitude: 30.04, longitude: 70.01 })
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].memberZones).toEqual(['Z-1', 'Z-new-a', 'Z-new-b']);
  });
});
