import { Pool } from 'pg';

import { IncidentRepository } from '../incidentRepository';
import { IncidentWireEvent } from '../incidentTypes';

/**
 * Drives the real repository against a fake pool that records SQL.
 *
 * What is being tested is the *shape* of the writes — which statements run, in which order,
 * inside a transaction, with which parameters — because that is where the at-least-once
 * reasoning lives. Whether Postgres honours `ON CONFLICT DO NOTHING` is Postgres's problem and
 * is not worth a container per test; whether this code asks for it is entirely this code's
 * problem, and it is the difference between a replay being a no-op and a duplicated timeline.
 *
 * The live version of the same claim runs in `incidentFlow.int.test.ts` against a real database.
 */
interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(overrides: { failOn?: RegExp; rowsFor?: (sql: string) => any } = {}) {
  const queries: RecordedQuery[] = [];
  let released = 0;

  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (overrides.failOn?.test(sql)) {
        throw new Error('insert failed');
      }
      return overrides.rowsFor?.(sql) ?? { rows: [], rowCount: 0 };
    }),
    release: jest.fn(() => {
      released++;
    })
  };

  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn()
  } as unknown as Pool;

  return {
    pool,
    queries,
    client,
    get released() {
      return released;
    },
    sqlMatching(pattern: RegExp): RecordedQuery[] {
      return queries.filter((q) => pattern.test(q.sql));
    }
  };
}

const OPENED: IncidentWireEvent = {
  incidentId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
  eventType: 'OPENED',
  status: 'OPEN',
  lifecycleStatus: 'OPEN',
  memberZones: ['Z-0001', 'Z-0002', 'Z-0003'],
  memberCount: 3,
  peakSeverity: 0.91,
  severity: 0.91,
  footprint: {
    h3Cells: ['85283473fffffff'],
    centroid: { latitude: 37.7749, longitude: -122.4194 },
    radiusKm: 12.5
  },
  propagation: null,
  mergedFrom: null,
  supersededBy: null,
  splitFrom: null,
  closeReason: null,
  openedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  closedAt: null,
  h3CoarseCell: '83283ffffffffff'
};

describe('IncidentRepository', () => {
  it('writes all three tables inside one transaction', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    const order = fake.queries.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(order[0]).toBe('BEGIN');
    expect(order[order.length - 1]).toBe('COMMIT');
    expect(fake.sqlMatching(/INSERT INTO incidents/)).toHaveLength(1);
    expect(fake.sqlMatching(/INSERT INTO incident_members/)).toHaveLength(1);
    expect(fake.sqlMatching(/INSERT INTO incident_events/)).toHaveLength(1);
  });

  it('upserts the incident rather than inserting a second row for a redelivery', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    const sql = fake.sqlMatching(/INSERT INTO incidents/)[0].sql;
    expect(sql).toMatch(/ON CONFLICT \(incident_id\) DO UPDATE/);
  });

  /**
   * `opened_at` is in the incident id preimage (ADR-003), so an update that moved it would be
   * describing a different incident under the same key.
   */
  it('never updates opened_at on conflict', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    const sql = fake.sqlMatching(/INSERT INTO incidents/)[0].sql;
    const onConflict = sql.slice(sql.indexOf('DO UPDATE'));
    expect(onConflict).not.toMatch(/opened_at/);
  });

  it('keeps peak severity as a maximum, so a quieter later event cannot lower it', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    expect(fake.sqlMatching(/INSERT INTO incidents/)[0].sql).toMatch(
      /peak_severity\s*=\s*GREATEST\(incidents\.peak_severity, EXCLUDED\.peak_severity\)/
    );
  });

  it('makes a replayed timeline entry a no-op instead of a duplicate row', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    expect(fake.sqlMatching(/INSERT INTO incident_events/)[0].sql).toMatch(
      /ON CONFLICT \(incident_id, event_type, event_time\) DO NOTHING/
    );
  });

  it('writes one membership row per member, with the event time as joined_at', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    const members = fake.sqlMatching(/INSERT INTO incident_members/)[0];
    expect(members.params).toEqual([
      OPENED.incidentId,
      OPENED.updatedAt,
      'Z-0001',
      'Z-0002',
      'Z-0003'
    ]);
    // Three value tuples, one per member.
    expect(members.sql.match(/\(\$1, \$\d+, \$2, NULL\)/g)).toHaveLength(3);
  });

  it('marks members that left, scoped to rows that are still open', async () => {
    const fake = fakePool();
    const shrank: IncidentWireEvent = {
      ...OPENED,
      eventType: 'SHRANK',
      memberZones: ['Z-0001', 'Z-0002'],
      memberCount: 2,
      updatedAt: 1_700_000_060_000
    };

    await new IncidentRepository(fake.pool).persist(shrank);

    const departures = fake.sqlMatching(/UPDATE incident_members/)[0];
    expect(departures.sql).toMatch(/left_at IS NULL/);
    expect(departures.params).toEqual([shrank.incidentId, shrank.updatedAt, ['Z-0001', 'Z-0002']]);
  });

  /**
   * A closed incident with a zone still marked present would answer "which incidents was this
   * zone in" with an interval that never ends.
   */
  it('ends every remaining membership on CLOSED, whatever the member list says', async () => {
    const fake = fakePool();
    const closed: IncidentWireEvent = {
      ...OPENED,
      eventType: 'CLOSED',
      status: 'CLOSED',
      lifecycleStatus: 'CLOSED',
      closeReason: 'DISSOLVED',
      memberZones: ['Z-0001'],
      memberCount: 1,
      updatedAt: 1_700_000_120_000,
      closedAt: 1_700_000_120_000
    };

    await new IncidentRepository(fake.pool).persist(closed);

    // No membership insert at all, and the departure update is unscoped.
    expect(fake.sqlMatching(/INSERT INTO incident_members/)).toHaveLength(0);
    const departures = fake.sqlMatching(/UPDATE incident_members/)[0];
    expect(departures.params).toEqual([closed.incidentId, closed.closedAt, null]);
  });

  it('records the merge survivor on the incident that lost', async () => {
    const fake = fakePool();
    const superseded: IncidentWireEvent = {
      ...OPENED,
      eventType: 'CLOSED',
      status: 'CLOSED',
      lifecycleStatus: 'CLOSED',
      closeReason: 'SUPERSEDED',
      supersededBy: 'beefbeefbeefbeefbeefbeefbeefbeef',
      closedAt: 1_700_000_120_000
    };

    await new IncidentRepository(fake.pool).persist(superseded);

    const incident = fake.sqlMatching(/INSERT INTO incidents/)[0];
    expect(incident.params[12]).toBe('beefbeefbeefbeefbeefbeefbeefbeef');
    // And it is not cleared by a later event that has nothing to say about it.
    expect(incident.sql).toMatch(/superseded_by\s*=\s*COALESCE/);
  });

  it('writes null geometry rather than latitude 0 for an incident with no members left', async () => {
    const fake = fakePool();
    const dissolved: IncidentWireEvent = {
      ...OPENED,
      eventType: 'CLOSED',
      status: 'CLOSED',
      lifecycleStatus: 'CLOSED',
      closeReason: 'DISSOLVED',
      memberZones: [],
      memberCount: 0,
      closedAt: 1_700_000_120_000
    };

    await new IncidentRepository(fake.pool).persist(dissolved);

    const params = fake.sqlMatching(/INSERT INTO incidents/)[0].params;
    expect(params[7]).toBeNull(); // centroid_lat
    expect(params[8]).toBeNull(); // centroid_lon
    expect(params[9]).toBeNull(); // radius_km
  });

  it('writes a null propagation vector until WP4 supplies one', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist(OPENED);

    const params = fake.sqlMatching(/INSERT INTO incidents/)[0].params;
    expect(params[10]).toBeNull(); // bearing_deg
    expect(params[11]).toBeNull(); // speed_kmh
  });

  it('carries a propagation vector through once there is one', async () => {
    const fake = fakePool();
    await new IncidentRepository(fake.pool).persist({
      ...OPENED,
      propagation: { bearingDeg: 135, speedKmh: 42.5, rSquared: 0.91 }
    });

    const params = fake.sqlMatching(/INSERT INTO incidents/)[0].params;
    expect(params[10]).toBe(135);
    expect(params[11]).toBe(42.5);
  });

  it('rolls back and rethrows when a write fails, so the consumer does not commit', async () => {
    const fake = fakePool({ failOn: /INSERT INTO incident_events/ });

    await expect(new IncidentRepository(fake.pool).persist(OPENED)).rejects.toThrow(
      'insert failed'
    );

    expect(fake.sqlMatching(/ROLLBACK/)).toHaveLength(1);
    expect(fake.sqlMatching(/COMMIT/)).toHaveLength(0);
  });

  /**
   * A connection not released is one permanently removed from a pool of five, and five of those
   * is a service that has silently stopped writing anything.
   */
  it('releases its pooled connection on both paths', async () => {
    const ok = fakePool();
    await new IncidentRepository(ok.pool).persist(OPENED);
    expect(ok.released).toBe(1);

    const bad = fakePool({ failOn: /INSERT INTO incidents/ });
    await expect(new IncidentRepository(bad.pool).persist(OPENED)).rejects.toThrow();
    expect(bad.released).toBe(1);
  });

  it('counts joins and departures separately', async () => {
    const fake = fakePool({
      rowsFor: (sql) =>
        /INSERT INTO incident_members/.test(sql)
          ? { rows: [{ inserted: true }, { inserted: true }, { inserted: false }], rowCount: 3 }
          : /UPDATE incident_members/.test(sql)
            ? { rows: [], rowCount: 2 }
            : { rows: [], rowCount: 0 }
    });

    const repository = new IncidentRepository(fake.pool);
    await repository.persist(OPENED);

    expect(repository.stats()).toEqual({ events: 1, memberJoins: 2, memberDepartures: 2 });
  });
});
