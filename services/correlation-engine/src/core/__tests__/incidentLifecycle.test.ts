import { CorrelationWindow } from '../correlationWindow';
import { IncidentEvent, IncidentLifecycle } from '../incidentLifecycle';
import { TimeAwareConnectivity } from '../timeAwareConnectivity';
import { StaticAdjacency, zoneId } from './support/graphs';

/** The simulator's fixed epoch (ADR-005), so these timestamps look like the real ones. */
const T0 = 1768478400000;

const MIN_ZONES = 3;
const GRACE_MS = 60000;

function lifecycle(overrides: { minZones?: number; closeGraceMs?: number } = {}): IncidentLifecycle {
  return new IncidentLifecycle({ minZones: MIN_ZONES, closeGraceMs: GRACE_MS, ...overrides });
}

/** `type:incidentId` for each event, so an expectation reads as the timeline it is asserting. */
function shape(events: readonly IncidentEvent[]): string[] {
  return events.map((event) => `${event.type}:${event.incidentId}`);
}

describe('IncidentLifecycle — OPENED', () => {
  it('ignores a component below the minimum', () => {
    const incidents = lifecycle();

    expect(incidents.reconcile([['A', 'B']], T0)).toEqual([]);
    expect(incidents.size).toBe(0);
    expect(incidents.incidentOf('A')).toBeUndefined();
  });

  it('opens when a component reaches the minimum', () => {
    const incidents = lifecycle();

    const events = incidents.reconcile([['A', 'B', 'C']], T0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'OPENED',
      status: 'OPEN',
      eventTime: T0,
      openedAt: T0,
      members: ['A', 'B', 'C'],
      memberCount: 3,
      added: ['A', 'B', 'C'],
      removed: []
    });
    expect(events[0].incidentId).toMatch(/^INC-[0-9a-f]{16}$/);
    expect(events[0].splitFrom).toBeUndefined();
    expect(incidents.incidentOf('B')).toBe(events[0].incidentId);
  });

  it('opens one incident per component, in canonical order', () => {
    const incidents = lifecycle();

    const events = incidents.reconcile(
      [
        ['X', 'Y', 'Z'],
        ['A', 'B', 'C']
      ],
      T0
    );

    expect(events.map((event) => event.members)).toEqual([
      ['A', 'B', 'C'],
      ['X', 'Y', 'Z']
    ]);
    expect(incidents.size).toBe(2);
  });

  it('carries a snapshot that survives the members changing', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    incidents.reconcile([['A', 'B', 'C', 'D']], T0 + 1000);
    incidents.reconcile([['A', 'B', 'C']], T0 + 2000);

    expect(incidents.snapshot(id)).toEqual({
      incidentId: id,
      status: 'OPEN',
      openedAt: T0,
      updatedAt: T0 + 2000,
      closedAt: null,
      members: ['A', 'B', 'C'],
      memberCount: 3,
      peakMemberCount: 4,
      seedMembers: ['A', 'B', 'C'],
      belowMinSince: null,
      supersededBy: null,
      splitFrom: null
    });
  });
});

describe('IncidentLifecycle — incident identity', () => {
  it('derives the id from the seed members and the opening event time alone', () => {
    const first = lifecycle().reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    const second = lifecycle().reconcile([['A', 'B', 'C']], T0)[0].incidentId;

    // Two independent instances, no shared state: the id is a function of the facts, which is
    // the whole reason it is a hash and not a counter.
    expect(second).toBe(first);
  });

  it('is insensitive to the order the component members arrive in', () => {
    const sorted = lifecycle().reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    const shuffled = lifecycle().reconcile([['C', 'A', 'B']], T0)[0].incidentId;

    expect(shuffled).toBe(sorted);
  });

  it('changes with the opening time and with the seed set', () => {
    const base = lifecycle().reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    const laterOpen = lifecycle().reconcile([['A', 'B', 'C']], T0 + 1)[0].incidentId;
    const otherSeed = lifecycle().reconcile([['A', 'B', 'D']], T0)[0].incidentId;

    expect(laterOpen).not.toBe(base);
    expect(otherSeed).not.toBe(base);
  });

  it('is pinned to a known value, so a change to the scheme is a deliberate one', () => {
    // SHA-256 of `geopulse-incident-v1|1768478400000|A,B,C`, first 16 hex characters. Ids are
    // written to Postgres and to Redis keys; silently re-deriving them would orphan every row.
    expect(lifecycle().reconcile([['A', 'B', 'C']], T0)[0].incidentId).toBe('INC-74d25f2447a59f5d');
  });

  it('does not change when the incident grows, shrinks or regrows', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;

    for (const [members, at] of [
      [['A', 'B', 'C', 'D', 'E'], T0 + 1000],
      [['A', 'B'], T0 + 2000],
      [['A', 'B', 'C', 'D'], T0 + 3000]
    ] as Array<[string[], number]>) {
      expect(incidents.reconcile([members], at)[0].incidentId).toBe(id);
    }
    expect(incidents.snapshot(id)!.seedMembers).toEqual(['A', 'B', 'C']);
    expect(incidents.stats().idCollisions).toBe(0);
  });
});

describe('IncidentLifecycle — GREW and SHRANK', () => {
  it('emits nothing when the partition is unchanged', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0);

    expect(incidents.reconcile([['A', 'B', 'C']], T0 + 5000)).toEqual([]);
  });

  it('emits one GREW for a whole batch of new members', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0);

    const [event] = incidents.reconcile([['A', 'B', 'C', 'D', 'E', 'F']], T0 + 5000);

    // One event, not three. Collapsing a burst into a single update is the point of consuming a
    // batch of degradations as a unit.
    expect(event).toMatchObject({
      type: 'GREW',
      status: 'OPEN',
      added: ['D', 'E', 'F'],
      removed: [],
      memberCount: 6
    });
  });

  it('emits SHRANK while the incident stays above the minimum', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C', 'D']], T0);

    const [event] = incidents.reconcile([['A', 'B', 'C']], T0 + 5000);

    expect(event).toMatchObject({ type: 'SHRANK', status: 'OPEN', added: [], removed: ['D'] });
  });

  it('names the transition by what joined, and carries both directions when a batch does both', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0);

    const [event] = incidents.reconcile([['B', 'C', 'D']], T0 + 5000);

    expect(event.type).toBe('GREW');
    expect(event.added).toEqual(['D']);
    expect(event.removed).toEqual(['A']);
  });

  it('goes DRAINING below the minimum and back to OPEN when it regrows', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;

    const [shrank] = incidents.reconcile([['A', 'B']], T0 + 10000);
    expect(shrank).toMatchObject({ type: 'SHRANK', status: 'DRAINING', incidentId: id });
    expect(incidents.snapshot(id)!.belowMinSince).toBe(T0 + 10000);

    const [grew] = incidents.reconcile([['A', 'B', 'C']], T0 + 20000);
    expect(grew).toMatchObject({ type: 'GREW', status: 'OPEN', incidentId: id });
    expect(incidents.snapshot(id)!.belowMinSince).toBeNull();
    expect(incidents.stats().opened).toBe(1);
  });
});

describe('IncidentLifecycle — CLOSED', () => {
  it('holds a draining incident open for the whole grace period, then closes it', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    incidents.reconcile([['A', 'B']], T0 + 10000);

    expect(incidents.reconcile([['A', 'B']], T0 + 10000 + GRACE_MS - 1)).toEqual([]);

    const [closed] = incidents.reconcile([['A', 'B']], T0 + 10000 + GRACE_MS);
    expect(closed).toMatchObject({
      type: 'CLOSED',
      incidentId: id,
      status: 'CLOSED',
      closeReason: 'GRACE_EXPIRED',
      members: ['A', 'B'],
      removed: []
    });
    expect(closed.supersededBy).toBeUndefined();
    expect(incidents.size).toBe(0);
    expect(incidents.incidentOf('A')).toBeUndefined();
  });

  it('restarts nothing: an incident that regrows inside the grace period does not close later', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0);
    incidents.reconcile([['A', 'B']], T0 + 10000);
    incidents.reconcile([['A', 'B', 'C']], T0 + 20000);

    expect(incidents.reconcile([['A', 'B', 'C']], T0 + 10000 + GRACE_MS)).toEqual([]);
    expect(incidents.size).toBe(1);
  });

  it('closes immediately when every member has gone, without waiting out the grace period', () => {
    // There is nothing left to carry the identity forward — no zone that could re-degrade and
    // reclaim the incident — so the grace period would only delay a certain close. ADR-003.
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;

    const [closed] = incidents.reconcile([], T0 + 1000);

    expect(closed).toMatchObject({
      type: 'CLOSED',
      incidentId: id,
      closeReason: 'DISSOLVED',
      members: [],
      memberCount: 0,
      removed: ['A', 'B', 'C']
    });
    expect(incidents.size).toBe(0);
  });

  it('shrinks and closes in one reconcile when the grace period is zero', () => {
    const incidents = lifecycle({ closeGraceMs: 0 });
    const id = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;

    const events = incidents.reconcile([['A', 'B']], T0 + 1000);

    expect(shape(events)).toEqual([`SHRANK:${id}`, `CLOSED:${id}`]);
    expect(events[1].closeReason).toBe('GRACE_EXPIRED');
  });

  it('closes several incidents in id order within one reconcile', () => {
    const incidents = lifecycle();
    const opened = incidents.reconcile(
      [
        ['A', 'B', 'C'],
        ['X', 'Y', 'Z']
      ],
      T0
    );

    const closed = incidents.reconcile([], T0 + 1000).map((event) => event.incidentId);

    expect(closed).toEqual([...opened.map((event) => event.incidentId)].sort());
  });
});

describe('IncidentLifecycle — MERGED', () => {
  it('keeps the older incident and supersedes the younger', () => {
    const incidents = lifecycle();
    const older = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    const younger = incidents.reconcile([['A', 'B', 'C'], ['X', 'Y', 'Z']], T0 + 30000)[0]
      .incidentId;

    const events = incidents.reconcile([['A', 'B', 'C', 'M', 'X', 'Y', 'Z']], T0 + 60000);

    expect(shape(events)).toEqual([`MERGED:${older}`, `CLOSED:${younger}`]);
    expect(events[0]).toMatchObject({
      status: 'OPEN',
      openedAt: T0,
      added: ['M', 'X', 'Y', 'Z'],
      removed: [],
      mergedFrom: [younger],
      memberCount: 7
    });
    expect(events[1]).toMatchObject({
      closeReason: 'SUPERSEDED',
      supersededBy: older,
      members: ['X', 'Y', 'Z'],
      removed: []
    });
    expect(incidents.incidentOf('Y')).toBe(older);
    expect(incidents.size).toBe(1);
  });

  it('breaks a tie on openedAt lexicographically, not by iteration order', () => {
    const incidents = lifecycle();
    const opened = incidents.reconcile(
      [
        ['A', 'B', 'C'],
        ['X', 'Y', 'Z']
      ],
      T0
    );
    const [expectedSurvivor, expectedLoser] = opened.map((event) => event.incidentId).sort();

    const events = incidents.reconcile([['A', 'B', 'C', 'M', 'X', 'Y', 'Z']], T0 + 1000);

    expect(shape(events)).toEqual([`MERGED:${expectedSurvivor}`, `CLOSED:${expectedLoser}`]);
  });

  it('absorbs several incidents at once, listing them sorted in mergedFrom', () => {
    const incidents = lifecycle();
    const first = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    const others = incidents
      .reconcile([['A', 'B', 'C'], ['P', 'Q', 'R'], ['X', 'Y', 'Z']], T0 + 1000)
      .map((event) => event.incidentId);

    const events = incidents.reconcile(
      [['A', 'B', 'C', 'M', 'P', 'Q', 'R', 'X', 'Y', 'Z']],
      T0 + 2000
    );

    expect(events[0].mergedFrom).toEqual([...others].sort());
    expect(shape(events.slice(1))).toEqual([...others].sort().map((id) => `CLOSED:${id}`));
    expect(incidents.stats()).toMatchObject({ merged: 1, superseded: 2, closed: 2 });
  });

  it('a merge that lands below the minimum leaves the survivor draining', () => {
    const incidents = lifecycle();
    const older = incidents.reconcile([['A', 'B', 'C']], T0)[0].incidentId;
    incidents.reconcile([['A', 'B', 'C'], ['X', 'Y', 'Z']], T0 + 1000);

    // Both incidents lost members in the same batch that bridged what was left of them. A merge
    // is not automatically a promotion: the union is still under the threshold.
    const events = incidents.reconcile([['A', 'X']], T0 + 2000);

    expect(events[0]).toMatchObject({
      type: 'MERGED',
      incidentId: older,
      status: 'DRAINING',
      added: ['X'],
      removed: ['B', 'C']
    });
    expect(incidents.snapshot(older)!.belowMinSince).toBe(T0 + 2000);
  });
});

describe('IncidentLifecycle — splits', () => {
  it('gives the id to the fragment that kept most of the incident', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C', 'D', 'E', 'F', 'G']], T0)[0].incidentId;

    // E was the bridge; it expired. A–D on one side, F–G on the other.
    const events = incidents.reconcile(
      [
        ['A', 'B', 'C', 'D'],
        ['F', 'G']
      ],
      T0 + 10000
    );

    expect(shape(events)).toEqual([`SHRANK:${id}`]);
    expect(events[0]).toMatchObject({ status: 'OPEN', removed: ['E', 'F', 'G'] });
    // F and G are still degraded, but two zones are not an incident.
    expect(incidents.incidentOf('F')).toBeUndefined();
    expect(incidents.stats()).toMatchObject({ splits: 1, splitFragments: 1 });
  });

  it('opens the losing fragment fresh, with splitFrom pointing at where it came from', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C', 'D', 'E', 'F', 'G']], T0)[0].incidentId;

    const events = incidents.reconcile(
      [
        ['A', 'B', 'C'],
        ['E', 'F', 'G']
      ],
      T0 + 10000
    );

    // Equal inheritance and equal size: canonical order decides, so A–C keeps the id. The rule
    // has to be total, or replays of the same split would disagree about which half continues.
    expect(events.map((event) => event.type)).toEqual(['SHRANK', 'OPENED']);
    expect(events[0].incidentId).toBe(id);
    expect(events[1]).toMatchObject({
      status: 'OPEN',
      openedAt: T0 + 10000,
      members: ['E', 'F', 'G'],
      splitFrom: id
    });
    expect(events[1].incidentId).not.toBe(id);
    expect(incidents.snapshot(events[1].incidentId)!.splitFrom).toBe(id);
  });

  it('prefers inherited members over raw fragment size', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C', 'D', 'E']], T0)[0].incidentId;

    // A–B kept two of the incident's members; E kept one but picked up three new zones. The id
    // follows continuity with what was there before, not whichever blob is momentarily biggest.
    const events = incidents.reconcile(
      [
        ['A', 'B'],
        ['E', 'W', 'X', 'Y']
      ],
      T0 + 10000
    );

    expect(events.filter((event) => event.incidentId === id)).toHaveLength(1);
    expect(incidents.incidentOf('A')).toBe(id);
    expect(incidents.incidentOf('E')).not.toBe(id);
  });

  it('falls back to fragment size when inheritance ties', () => {
    const incidents = lifecycle();
    const id = incidents.reconcile([['A', 'B', 'C', 'D']], T0)[0].incidentId;

    const events = incidents.reconcile(
      [
        ['A', 'B'],
        ['C', 'D', 'W', 'X']
      ],
      T0 + 10000
    );

    expect(shape(events)).toEqual([`GREW:${id}`]);
    expect(incidents.incidentOf('C')).toBe(id);
    expect(incidents.incidentOf('A')).toBeUndefined();
  });

  it('handles a split and a merge in the same reconcile', () => {
    const incidents = lifecycle();
    const split = incidents.reconcile([['A', 'B', 'C', 'D', 'E']], T0)[0].incidentId;
    const neighbour = incidents.reconcile([['A', 'B', 'C', 'D', 'E'], ['X', 'Y', 'Z']], T0 + 1000)[0]
      .incidentId;

    // C expired, splitting the first incident; W arrived and bridged its larger half into the
    // second incident. Both things are true of the same partition.
    const events = incidents.reconcile(
      [
        ['A', 'B', 'B2'],
        ['D', 'E', 'W', 'X', 'Y', 'Z']
      ],
      T0 + 2000
    );

    expect(events.map((event) => event.type)).toEqual(['OPENED', 'MERGED', 'CLOSED']);
    expect(events[0]).toMatchObject({ members: ['A', 'B', 'B2'], splitFrom: split });
    expect(events[1]).toMatchObject({
      incidentId: split,
      // `added` is relative to the survivor: W is genuinely new, X-Z arrive with the incident
      // being absorbed, and A-C left with the fragment that was carved off.
      added: ['W', 'X', 'Y', 'Z'],
      removed: ['A', 'B', 'C'],
      mergedFrom: [neighbour]
    });
    expect(events[2]).toMatchObject({ incidentId: neighbour, supersededBy: split });
  });
});

describe('IncidentLifecycle — event time and input validation', () => {
  it('treats event time as a monotonic watermark', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0 + 60000);

    // A late batch cannot pull incident clocks backwards — which is what keeps `openedAt`
    // strictly increasing, and so keeps minted ids distinct without a registry.
    const [opened] = incidents.reconcile([['A', 'B', 'C'], ['X', 'Y', 'Z']], T0);

    expect(opened.openedAt).toBe(T0 + 60000);
    expect(incidents.watermark).toBe(T0 + 60000);
  });

  it('rejects a partition that is not one', () => {
    const incidents = lifecycle();

    expect(() => incidents.reconcile([['A', 'B'], ['B', 'C']], T0)).toThrow(/more than one/);
    expect(() => incidents.reconcile([[]], T0)).toThrow(/empty component/);
    expect(() => incidents.reconcile([['A']], NaN)).toThrow(/finite/);
  });

  it('defaults to the documented INCIDENT_MIN_ZONES and INCIDENT_CLOSE_GRACE_MS', () => {
    // The table in `01-ARCHITECTURE.md` section 7 is the contract; pinning it here means a
    // changed default is a failing test rather than a silently different collapse ratio.
    expect(new IncidentLifecycle().geometry).toEqual({ minZones: 3, closeGraceMs: 60000 });
  });

  it('rejects nonsense configuration at construction', () => {
    expect(() => new IncidentLifecycle({ minZones: 0 })).toThrow(/minZones/);
    expect(() => new IncidentLifecycle({ minZones: 2.5 })).toThrow(/minZones/);
    expect(() => new IncidentLifecycle({ closeGraceMs: -1 })).toThrow(/closeGraceMs/);
    expect(() => new IncidentLifecycle({ idPrefix: '' })).toThrow(/idPrefix/);
  });

  it('reports its thresholds and its counters', () => {
    const incidents = lifecycle();
    incidents.reconcile([['A', 'B', 'C']], T0);
    incidents.reconcile([['A', 'B']], T0 + 1000);

    expect(incidents.geometry).toEqual({ minZones: MIN_ZONES, closeGraceMs: GRACE_MS });
    expect(incidents.activeIncidents().map((snapshot) => snapshot.status)).toEqual(['DRAINING']);
    expect(incidents.stats()).toMatchObject({
      reconciles: 2,
      membersReconciled: 5,
      opened: 1,
      shrank: 1,
      draining: 1,
      activeIncidents: 1,
      peakActiveIncidents: 1
    });
    expect(incidents.snapshot('INC-nope')).toBeUndefined();
  });
});

describe('IncidentLifecycle — driven by the real window and connectivity', () => {
  it('collapses a spreading regional fault into a single incident', () => {
    // A 4x4 grid of zones. A fault starts at one corner and spreads; every zone keeps degrading
    // until it recovers. This is the path the service takes in WP3, assembled by hand.
    const adjacency = grid4x4();
    const window = new CorrelationWindow({ windowMs: 60000, compactionIntervalMs: 5000 });
    const connectivity = new TimeAwareConnectivity(adjacency);
    const incidents = lifecycle();

    const events: IncidentEvent[] = [];
    const step = (degrading: string[], at: number) => {
      for (const zone of degrading) {
        if (window.admit(zone, at)) {
          connectivity.activate(zone);
        } else if (window.isActive(zone)) {
          connectivity.activate(zone);
        }
      }
      connectivity.compact(window.tick(at));
      events.push(...incidents.reconcile(connectivity.components(), at));
    };

    const spread = [
      [zoneId(0), zoneId(1)],
      [zoneId(0), zoneId(1), zoneId(4)],
      [zoneId(0), zoneId(1), zoneId(4), zoneId(5)],
      [zoneId(0), zoneId(1), zoneId(4), zoneId(5), zoneId(8)]
    ];
    spread.forEach((degrading, index) => step(degrading, T0 + index * 10000));

    expect(shape(events)).toEqual([
      `OPENED:${events[0].incidentId}`,
      `GREW:${events[0].incidentId}`,
      `GREW:${events[0].incidentId}`
    ]);
    expect(incidents.size).toBe(1);
    expect(incidents.activeIncidents()[0].memberCount).toBe(5);

    // Everything recovers. The window releases the members, the component disappears, and the
    // incident closes — one incident for a fault that produced five degrading zones.
    for (const zone of spread[spread.length - 1]) {
      window.release(zone, T0 + 40000);
      connectivity.deactivate(zone);
    }
    const closing = incidents.reconcile(connectivity.components(), T0 + 40000);

    expect(shape(closing)).toEqual([`CLOSED:${events[0].incidentId}`]);
    expect(closing[0].closeReason).toBe('DISSOLVED');
    expect(incidents.stats()).toMatchObject({ opened: 1, grew: 2, closed: 1, splits: 0 });
  });
});

/** A 4x4 lattice, zone `i` at row `i/4`, column `i%4`. Rook adjacency, like an H3 one-ring. */
function grid4x4(): StaticAdjacency {
  const edges: Array<[string, string]> = [];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column;
      if (column + 1 < 4) {
        edges.push([zoneId(index), zoneId(index + 1)]);
      }
      if (row + 1 < 4) {
        edges.push([zoneId(index), zoneId(index + 4)]);
      }
    }
  }
  return new StaticAdjacency(edges);
}
