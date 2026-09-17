import fc from 'fast-check';
import { NeighbourGraph } from '@geopulse/spatial';

import { FuzzEvent, driveBoth, formatDivergence } from './support/driver';
import { StaticAdjacency, zoneId } from './support/graphs';

/**
 * **The acceptance criterion for WP2.** 10,000 randomised event sequences through both
 * connectivity implementations, partitions compared after every operation, zero divergence.
 *
 * Why this test and not more unit tests. `TimeAwareConnectivity` is fast because it avoids
 * recomputation, and every avoided recomputation is a place it can be subtly stale. The failures
 * that structure can have are not the failures a person thinks to write down — they need a
 * particular merge order, followed by a particular expiry, followed by a particular re-arrival.
 * Unit tests check the cases the author imagined. Differential testing checks every case the
 * generator can reach, against an implementation whose correctness is obvious by inspection.
 *
 * **The seed is pinned.** A fuzz test that draws a fresh seed each run is a test that fails once
 * on someone else's machine and passes when they re-run it, which is worse than no test: the
 * failure gets attributed to flakiness rather than to the bug it found. Pinned, the same 10,000
 * sequences run everywhere, a failure reproduces exactly, and buying new coverage is a
 * deliberate act — change the seed, commit the new one.
 *
 * **`size: 'max'` is load-bearing.** fast-check biases array lengths small by default, which is
 * usually the right instinct and is wrong here: with the default bias these sequences averaged
 * five events, so most of them never built a component at all and the 10,000 meant almost
 * nothing. The `reach` test below exists to keep that from happening again quietly — it asserts
 * what the generator actually gets the structures to do, not just that nothing crashed.
 */

const SEED = 42;
const SEQUENCES = 10_000;
const ZONE_UNIVERSE = 12;

const WINDOW_MS = 60_000;
const COMPACTION_INTERVAL_MS = 5_000;

const tally = {
  sequences: 0,
  events: 0,
  comparisons: 0,
  divergences: 0,
  splits: 0,
  expired: 0,
  recovered: 0,
  wipeouts: 0,
  largestComponent: 0
};

/**
 * Thousands separators, explicitly. `toLocaleString()` renders 551871 as "5,51,871" under an
 * Indian locale and "551,871" elsewhere, and this output is committed as evidence — a number
 * that reads differently depending on whose machine produced it is a bad artefact.
 */
function group(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function record(result: ReturnType<typeof driveBoth>): void {
  tally.sequences++;
  tally.events += result.steps;
  tally.comparisons += result.comparisons;
  tally.splits += result.splits;
  tally.expired += result.expired;
  tally.recovered += result.recovered;
  tally.wipeouts += result.wipeouts;
  tally.largestComponent = Math.max(tally.largestComponent, result.maxComponentSize);
  if (result.divergence !== null) {
    tally.divergences++;
  }
}

/**
 * Event-time deltas. Mostly small, so members accumulate, merge and refresh; occasionally large
 * enough to expire a whole component or to arrive badly out of order.
 */
const deltaArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -2_000, max: 8_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -WINDOW_MS, max: WINDOW_MS + 30_000 }) }
);

/** Degradations dominate, as they do in the real stream; recoveries are the rare event. */
function eventArb(zoneCount: number): fc.Arbitrary<FuzzEvent> {
  return fc
    .tuple(fc.nat({ max: 9 }), fc.nat({ max: zoneCount - 1 }), deltaArb)
    .map(([kind, zone, dt]): FuzzEvent => {
      if (kind <= 5) {
        return { kind: 'degrade', zone, dt };
      }
      if (kind === 6) {
        return { kind: 'recover', zone, dt };
      }
      return { kind: 'tick', dt };
    });
}

function sequenceArb(zoneCount: number, maxLength: number): fc.Arbitrary<FuzzEvent[]> {
  return fc.array(eventArb(zoneCount), { minLength: 20, maxLength, size: 'max' });
}

/**
 * A random symmetric graph over the zone universe. Edge count is generated rather than fixed, so
 * the sample spans everything from a sparse field (every member its own incident) to a dense one
 * (a single component that swallows the map) — and, in between, the shapes that actually break
 * things: bridges, rings, and long chains.
 */
const adjacencyArb = fc
  .array(fc.tuple(fc.nat({ max: ZONE_UNIVERSE - 1 }), fc.nat({ max: ZONE_UNIVERSE - 1 })), {
    minLength: 4,
    maxLength: 26,
    size: 'max'
  })
  .map((pairs) => new StaticAdjacency(pairs.map(([a, b]) => [zoneId(a), zoneId(b)] as const)));

describe('differential fuzz — optimised connectivity against the naive oracle', () => {
  it(`agrees with NaiveConnectivity across ${group(SEQUENCES)} randomised sequences`, () => {
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 80), (adjacency, events) => {
        const result = driveBoth(adjacency, events, zoneId, {
          windowMs: WINDOW_MS,
          compactionIntervalMs: COMPACTION_INTERVAL_MS
        });
        record(result);

        if (result.divergence !== null) {
          throw new Error(
            [
              formatDivergence(result.divergence),
              `  edges: ${JSON.stringify(adjacency.edgeList())}`
            ].join('\n')
          );
        }
      }),
      { numRuns: SEQUENCES, seed: SEED }
    );

    expect(tally.divergences).toBe(0);
    expect(tally.sequences).toBeGreaterThanOrEqual(SEQUENCES);
  });

  it('reaches the states the claim depends on', () => {
    // The headline number is worthless unless the sequences behind it actually merge components,
    // fracture them, and expire members. This measures that directly over the same generator, so
    // a future change to the arbitraries that quietly guts the fuzz fails here instead of
    // passing everywhere.
    const reach = { multiZone: 0, split: 0, expiry: 0, recovery: 0, wipedOut: 0, largest: 0 };

    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 80), (adjacency, events) => {
        const result = driveBoth(adjacency, events, zoneId, {
          windowMs: WINDOW_MS,
          compactionIntervalMs: COMPACTION_INTERVAL_MS
        });
        expect(result.divergence).toBeNull();

        if (result.maxComponentSize >= 2) reach.multiZone++;
        if (result.splits > 0) reach.split++;
        if (result.expired > 0) reach.expiry++;
        if (result.recovered > 0) reach.recovery++;
        if (result.wipeouts > 0) reach.wipedOut++;
        reach.largest = Math.max(reach.largest, result.maxComponentSize);
      }),
      { numRuns: 1_000, seed: SEED }
    );

    // Thresholds are deliberately far below what the current generator produces: they are a
    // floor under the test's meaningfulness, not a snapshot of today's numbers.
    expect(reach.multiZone).toBeGreaterThan(800);
    expect(reach.split).toBeGreaterThan(200);
    expect(reach.expiry).toBeGreaterThan(800);
    expect(reach.recovery).toBeGreaterThan(200);
    expect(reach.wipedOut).toBeGreaterThan(50);
    expect(reach.largest).toBeGreaterThanOrEqual(6);
  });
});

describe('differential fuzz — over the real H3 neighbour graph', () => {
  /**
   * A 6x6 field at ~12 km spacing near 28.6N, which at resolution 5 (~8 km edge) puts some zones
   * in the same cell, some one ring apart, and some out of reach entirely.
   *
   * The random-graph fuzz above explores topologies far beyond anything H3 produces, which is the
   * point of it. This closes the other half: that the provider the service will actually pass
   * in — `NeighbourGraph`, built by WP1 — behaves the way both structures assume.
   */
  function h3Field(): NeighbourGraph {
    const graph = new NeighbourGraph({ resolution: 5, ringSize: 1 });
    const originLat = 28.6;
    const originLon = 77.2;
    const stepKm = 12;
    const degPerKmLat = 1 / 110.574;

    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        const latitude = originLat + row * stepKm * degPerKmLat;
        // Longitude degrees shrink with latitude; without the 1/cos(lat) correction the field
        // would be denser at its top than at its bottom (the same correction WP1's benchmark
        // needed).
        const longitude =
          originLon + (col * stepKm) / (111.32 * Math.cos((latitude * Math.PI) / 180));
        graph.addZone({ zoneId: zoneId(row * 6 + col), latitude, longitude });
      }
    }
    return graph;
  }

  it('produces a field that is neither disconnected nor one blob', () => {
    const graph = h3Field();
    const degrees = Array.from({ length: 36 }, (_, i) => graph.neighboursOf(zoneId(i)).length);

    expect(Math.max(...degrees)).toBeGreaterThan(0);
    expect(Math.min(...degrees)).toBeLessThan(35);
    expect(graph.stats().occupiedCells).toBeGreaterThan(1);
  });

  it('is symmetric, which is the contract both structures depend on', () => {
    // Stated on AdjacencyProvider and relied on by the incremental hot path, which only ever
    // unions a joining zone against its own neighbour list.
    const graph = h3Field();
    for (let i = 0; i < 36; i++) {
      const a = zoneId(i);
      for (const b of graph.neighboursOf(a)) {
        expect(graph.neighboursOf(b)).toContain(a);
      }
    }
  });

  it('agrees with NaiveConnectivity over H3 adjacency', () => {
    const graph = h3Field();
    fc.assert(
      fc.property(sequenceArb(36, 120), (events) => {
        const result = driveBoth(graph, events, zoneId, {
          windowMs: WINDOW_MS,
          compactionIntervalMs: COMPACTION_INTERVAL_MS
        });
        record(result);
        if (result.divergence !== null) {
          throw new Error(formatDivergence(result.divergence));
        }
      }),
      { numRuns: 1_000, seed: SEED }
    );

    expect(tally.divergences).toBe(0);
  });
});

afterAll(() => {
  // Rule 1 in CLAUDE.md: the "10,000 sequences, zero divergence" claim has to be traceable to
  // committed output, so the run prints its own tally. Captured in
  // benchmarks/results/wp2-differential-fuzz.txt.
  process.stdout.write(
    [
      '',
      'differential fuzz summary',
      `  seed                  ${SEED}`,
      `  sequences             ${group(tally.sequences)}`,
      `  events applied        ${group(tally.events)}`,
      `  partition comparisons ${group(tally.comparisons)}`,
      `  component splits      ${group(tally.splits)}`,
      `  zones expired         ${group(tally.expired)}`,
      `  zones recovered       ${group(tally.recovered)}`,
      `  full teardowns        ${group(tally.wipeouts)}`,
      `  largest component     ${tally.largestComponent}`,
      `  divergences           ${tally.divergences}`,
      ''
    ].join('\n')
  );
});
