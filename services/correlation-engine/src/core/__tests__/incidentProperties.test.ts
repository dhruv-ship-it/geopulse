import fc from 'fast-check';

import { FuzzEvent } from './support/driver';
import { LifecycleDriverOptions, driveLifecycle } from './support/lifecycleDriver';
import { StaticAdjacency, grid, zoneId } from './support/graphs';

/**
 * **Property-based tests for the incident lifecycle** — WP2 item 5.
 *
 * The differential fuzz proves the connectivity structure against an oracle. There is no oracle
 * for identity: "which incident is this" is a policy, not a computation, so a second
 * implementation would only agree with the first by sharing its assumptions. What can be stated
 * instead is what must be true of the answer whatever the policy decides, and then that can be
 * checked after every operation of every sequence:
 *
 * 1. **Every active zone is in exactly one component.**
 * 2. **Two zones share a component iff a path of active adjacent zones connects them** — checked
 *    against a plain BFS written independently of both connectivity implementations, so that a
 *    shared misconception between them cannot pass.
 * 3. **No OPEN incident is below `INCIDENT_MIN_ZONES`**, and no component at or above the
 *    minimum is without an incident. The second half matters: the first alone is satisfied by a
 *    lifecycle that never opens anything.
 * 4. **Replaying the same sequence produces byte-identical output** — the whole event stream,
 *    JSON-encoded, compared as text. Not "equivalent state": the same bytes, including ids.
 *
 * Seed pinned, for the reason given in `differentialFuzz.test.ts`: an unpinned fuzz failure gets
 * filed as flakiness instead of as the bug it found.
 */

const SEED = 42;
const INVARIANT_SEQUENCES = 2_000;
const REPLAY_SEQUENCES = 1_000;
const ZONE_UNIVERSE = 14;

const OPTIONS: LifecycleDriverOptions = {
  windowMs: 60_000,
  compactionIntervalMs: 5_000,
  minZones: 3,
  closeGraceMs: 20_000
};

const tally = {
  sequences: 0,
  steps: 0,
  checks: 0,
  violations: 0,
  opened: 0,
  grew: 0,
  shrank: 0,
  merged: 0,
  closed: 0,
  splitOpens: 0,
  supersededCloses: 0,
  graceCloses: 0,
  dissolvedCloses: 0,
  revivals: 0,
  largestIncident: 0,
  mostConcurrent: 0
};

function group(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function record(run: ReturnType<typeof driveLifecycle>): void {
  tally.sequences++;
  tally.steps += run.steps;
  tally.checks += run.checks;
  tally.violations += run.violations.length;
  tally.opened += run.opened;
  tally.grew += run.grew;
  tally.shrank += run.shrank;
  tally.merged += run.merged;
  tally.closed += run.closed;
  tally.splitOpens += run.splitOpens;
  tally.supersededCloses += run.supersededCloses;
  tally.graceCloses += run.graceCloses;
  tally.dissolvedCloses += run.dissolvedCloses;
  tally.revivals += run.revivals;
  tally.largestIncident = Math.max(tally.largestIncident, run.maxIncidentMembers);
  tally.mostConcurrent = Math.max(tally.mostConcurrent, run.maxConcurrentIncidents);
}

const deltaArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -2_000, max: 8_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: -OPTIONS.windowMs, max: OPTIONS.windowMs + 30_000 }) }
);

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

/** `size: 'max'`, or fast-check's small-array bias makes most sequences too short to correlate. */
function sequenceArb(zoneCount: number, maxLength: number): fc.Arbitrary<FuzzEvent[]> {
  return fc.array(eventArb(zoneCount), { minLength: 30, maxLength, size: 'max' });
}

/**
 * Denser than the connectivity fuzz's graph, on purpose. Incidents need components of three or
 * more before they exist at all, and a sparse field would spend most of its sequences below the
 * threshold — satisfying every invariant while exercising almost nothing.
 */
const adjacencyArb = fc
  .array(fc.tuple(fc.nat({ max: ZONE_UNIVERSE - 1 }), fc.nat({ max: ZONE_UNIVERSE - 1 })), {
    minLength: 12,
    maxLength: 34,
    size: 'max'
  })
  .map((pairs) => new StaticAdjacency(pairs.map(([a, b]) => [zoneId(a), zoneId(b)] as const)));

function report(run: ReturnType<typeof driveLifecycle>, adjacency: StaticAdjacency): void {
  if (run.violations.length === 0) {
    return;
  }
  throw new Error(
    [run.violations[0], `  edges: ${JSON.stringify(adjacency.edgeList())}`].join('\n')
  );
}

describe('incident lifecycle — structural invariants', () => {
  it(`holds every invariant across ${group(INVARIANT_SEQUENCES)} randomised sequences`, () => {
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 90), (adjacency, events) => {
        const run = driveLifecycle(adjacency, events, zoneId, OPTIONS);
        record(run);
        report(run, adjacency);
      }),
      { numRuns: INVARIANT_SEQUENCES, seed: SEED }
    );

    expect(tally.violations).toBe(0);
  });

  it('holds them over a lattice, where components are large and splits are common', () => {
    // A 5x4 grid is the closest fixture to a real zone field: every interior member is a bridge
    // between four others, so expiry fractures components constantly.
    const adjacency = grid(5, 4);
    fc.assert(
      fc.property(sequenceArb(20, 140), (events) => {
        const run = driveLifecycle(adjacency, events, zoneId, OPTIONS);
        record(run);
        report(run, adjacency);
      }),
      { numRuns: 500, seed: SEED }
    );

    expect(tally.violations).toBe(0);
  });

  it('holds them with the grace period at zero, where a dip below the minimum closes at once', () => {
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 90), (adjacency, events) => {
        const run = driveLifecycle(adjacency, events, zoneId, { ...OPTIONS, closeGraceMs: 0 });
        report(run, adjacency);
      }),
      { numRuns: 300, seed: SEED }
    );
  });

  it('holds them at minZones = 1, where every degraded zone is an incident', () => {
    // The degenerate configuration. Worth covering because it makes OPENED, MERGED and CLOSED
    // fire on nearly every event, which is where an off-by-one in the claim bookkeeping shows.
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 90), (adjacency, events) => {
        const run = driveLifecycle(adjacency, events, zoneId, { ...OPTIONS, minZones: 1 });
        report(run, adjacency);
      }),
      { numRuns: 300, seed: SEED }
    );
  });
});

describe('incident lifecycle — replay determinism', () => {
  it(`replays ${group(REPLAY_SEQUENCES)} sequences to a byte-identical event stream`, () => {
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 90), (adjacency, events) => {
        // Fresh structures each time, including a fresh adjacency, so nothing carries over except
        // the input itself. Identical bytes means identical ids, identical ordering, identical
        // payloads — which is what the eval harness needs to join incidents to ground truth
        // across two separate runs.
        const first = driveLifecycle(adjacency, events, zoneId, OPTIONS);
        const second = driveLifecycle(
          new StaticAdjacency(adjacency.edgeList()),
          events,
          zoneId,
          OPTIONS
        );

        expect(second.trace.join('\n')).toBe(first.trace.join('\n'));
      }),
      { numRuns: REPLAY_SEQUENCES, seed: SEED }
    );
  });

  it('is insensitive to the order components are handed over in', () => {
    // `reconcile` canonicalises its input, so a caller that iterates its components in a
    // different order — a different Map insertion order, a different partition assignment —
    // cannot change which incident is which.
    fc.assert(
      fc.property(adjacencyArb, sequenceArb(ZONE_UNIVERSE, 60), (adjacency, events) => {
        const forward = driveLifecycle(adjacency, events, zoneId, OPTIONS);
        const reversed = driveLifecycle(
          new ReversedAdjacency(adjacency),
          events,
          zoneId,
          OPTIONS
        );

        expect(reversed.trace.join('\n')).toBe(forward.trace.join('\n'));
      }),
      { numRuns: 300, seed: SEED }
    );
  });
});

describe('incident lifecycle — what the generator actually reaches', () => {
  it('opens, grows, shrinks, merges, splits, revives and closes incidents', () => {
    // The invariants above are satisfiable by doing nothing at all, so the sequence counts are
    // only worth something alongside evidence that the sequences reached the interesting states.
    // Floors sit well under current output: they are a guard against a future change gutting the
    // generator, not a snapshot.
    expect(tally.sequences).toBeGreaterThanOrEqual(INVARIANT_SEQUENCES);
    expect(tally.opened).toBeGreaterThan(2_000);
    expect(tally.grew).toBeGreaterThan(2_000);
    expect(tally.shrank).toBeGreaterThan(1_000);
    expect(tally.merged).toBeGreaterThan(200);
    expect(tally.splitOpens).toBeGreaterThan(50);
    expect(tally.supersededCloses).toBeGreaterThan(200);
    expect(tally.graceCloses).toBeGreaterThan(50);
    expect(tally.dissolvedCloses).toBeGreaterThan(200);
    expect(tally.revivals).toBeGreaterThan(50);
    expect(tally.largestIncident).toBeGreaterThanOrEqual(6);
    expect(tally.mostConcurrent).toBeGreaterThanOrEqual(2);
  });
});

/** The same graph with every neighbour list reversed. Same relation, opposite iteration order. */
class ReversedAdjacency extends StaticAdjacency {
  constructor(private readonly inner: StaticAdjacency) {
    super();
  }

  neighboursOf(zoneId: string): readonly string[] {
    return [...this.inner.neighboursOf(zoneId)].reverse();
  }
}

afterAll(() => {
  // CLAUDE.md rule 1: the claim has to be traceable to committed output. Captured in
  // benchmarks/results/wp2b-incident-properties.txt.
  process.stdout.write(
    [
      '',
      'incident lifecycle property summary',
      `  seed                   ${SEED}`,
      `  sequences              ${group(tally.sequences)}`,
      `  events applied         ${group(tally.steps)}`,
      `  invariant checks       ${group(tally.checks)}`,
      `  invariant violations   ${tally.violations}`,
      `  incidents opened       ${group(tally.opened)}`,
      `    of which from splits ${group(tally.splitOpens)}`,
      `  GREW / SHRANK          ${group(tally.grew)} / ${group(tally.shrank)}`,
      `  merges                 ${group(tally.merged)}`,
      `  closes                 ${group(tally.closed)}`,
      `    superseded           ${group(tally.supersededCloses)}`,
      `    grace expired        ${group(tally.graceCloses)}`,
      `    dissolved            ${group(tally.dissolvedCloses)}`,
      `  revivals from DRAINING ${group(tally.revivals)}`,
      `  largest incident       ${tally.largestIncident}`,
      `  most concurrent        ${tally.mostConcurrent}`,
      ''
    ].join('\n')
  );
});
