import {
  ACTIVE_INCIDENTS_KEY,
  INCIDENTS_GEO_KEY,
  INCIDENT_KEY_PREFIX,
  IncidentStore,
  toHash
} from '../incidentStore';
import { IncidentWireEvent } from '../types';

/** In-memory Redis covering the commands IncidentStore uses, including pipelining. */
function fakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const geo = new Map<string, Map<string, { latitude: number; longitude: number }>>();
  const ttls = new Map<string, number>();
  const stats = { pipelines: 0, execFails: 0 };
  let failNextExec = false;

  const apply = {
    hSet: (key: string, value: Record<string, string>) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...value });
    },
    sAdd: (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
    },
    sRem: (key: string, member: string) => {
      sets.get(key)?.delete(member);
    },
    geoAdd: (key: string, entry: { latitude: number; longitude: number; member: string }) => {
      const index = geo.get(key) ?? new Map();
      index.set(entry.member, { latitude: entry.latitude, longitude: entry.longitude });
      geo.set(key, index);
    },
    zRem: (key: string, member: string) => {
      geo.get(key)?.delete(member);
    },
    expire: (key: string, seconds: number) => {
      ttls.set(key, seconds);
    }
  };

  const client: any = {
    keys: jest.fn(() => {
      throw new Error('KEYS must never be called');
    }),
    sMembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    hGetAll: jest.fn(async (key: string) => hashes.get(key) ?? {}),
    multi: () => {
      const queued: Array<() => void> = [];
      const chain: any = {};
      for (const [name, fn] of Object.entries(apply)) {
        chain[name] = (...args: any[]) => {
          queued.push(() => (fn as any)(...args));
          return chain;
        };
      }
      chain.exec = async () => {
        stats.pipelines++;
        if (failNextExec) {
          failNextExec = false;
          stats.execFails++;
          throw new Error('redis is down');
        }
        for (const op of queued) op();
        return [];
      };
      return chain;
    }
  };

  return {
    client,
    hashes,
    sets,
    geo,
    ttls,
    stats,
    failNextExec: () => {
      failNextExec = true;
    }
  };
}

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
    h3Cells: ['cell-a', 'cell-b'],
    centroid: { latitude: 30.1234567, longitude: 70.7654321 },
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
  h3CoarseCell: 'coarse-a',
  ...overrides
});

describe('IncidentStore.apply', () => {
  it('writes the hash, the active set and the geo index in one round trip', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });

    await store.apply([event(), event({ incidentId: 'INC-aaaaaaaaaaaaaaaa' })]);

    expect(redis.stats.pipelines).toBe(1);
    expect(redis.hashes.get(`${INCIDENT_KEY_PREFIX}INC-0123456789abcdef`)).toBeDefined();
    expect(Array.from(redis.sets.get(ACTIVE_INCIDENTS_KEY)!).sort()).toEqual([
      'INC-0123456789abcdef',
      'INC-aaaaaaaaaaaaaaaa'
    ]);
    expect(redis.geo.get(INCIDENTS_GEO_KEY)!.get('INC-0123456789abcdef')).toEqual({
      latitude: 30.123457,
      longitude: 70.765432
    });
    expect(store.stats().opened).toBe(2);
  });

  it('does nothing at all for an empty batch', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });
    await store.apply([]);
    expect(redis.stats.pipelines).toBe(0);
  });

  it('removes a closed incident from the active set and the geo index, and expires its hash', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 900 });
    await store.apply([event()]);

    await store.apply([
      event({
        eventType: 'CLOSED',
        status: 'CLOSED',
        lifecycleStatus: 'CLOSED',
        closeReason: 'DISSOLVED',
        memberZones: [],
        memberCount: 0,
        closedAt: 1768478500000
      })
    ]);

    expect(redis.sets.get(ACTIVE_INCIDENTS_KEY)!.size).toBe(0);
    expect(redis.geo.get(INCIDENTS_GEO_KEY)!.has('INC-0123456789abcdef')).toBe(false);
    expect(redis.ttls.get(`${INCIDENT_KEY_PREFIX}INC-0123456789abcdef`)).toBe(900);
    // The hash is still readable until the TTL expires — an archive elsewhere, a cache here.
    expect(redis.hashes.get(`${INCIDENT_KEY_PREFIX}INC-0123456789abcdef`)!.status).toBe('CLOSED');
    expect(store.stats().closed).toBe(1);
  });

  it('keeps a closed incident forever when the TTL is disabled', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 0 });
    await store.apply([
      event({ eventType: 'CLOSED', status: 'CLOSED', lifecycleStatus: 'CLOSED' })
    ]);
    expect(redis.ttls.size).toBe(0);
  });

  it('is idempotent: applying the same event twice leaves the same state', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });

    await store.apply([event()]);
    const afterFirst = JSON.stringify(redis.hashes.get(`${INCIDENT_KEY_PREFIX}INC-0123456789abcdef`));
    await store.apply([event()]);
    const afterSecond = redis.hashes.get(`${INCIDENT_KEY_PREFIX}INC-0123456789abcdef`)!;

    // Everything but the wall-clock write stamp, which is the one field that is supposed to move.
    const strip = (hash: string) => {
      const parsed = JSON.parse(hash);
      delete parsed.lastWrittenAt;
      return parsed;
    };
    expect(strip(JSON.stringify(afterSecond))).toEqual(strip(afterFirst));
    expect(redis.sets.get(ACTIVE_INCIDENTS_KEY)!.size).toBe(1);
  });

  it('skips the geo entry for a live incident with no members, and says so', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });

    await store.apply([event({ eventType: 'SHRANK', memberZones: [], memberCount: 0 })]);

    expect(redis.geo.get(INCIDENTS_GEO_KEY)).toBeUndefined();
    expect(store.stats().withoutPosition).toBe(1);
  });

  it('propagates a pipeline failure rather than swallowing it', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });
    redis.failNextExec();

    await expect(store.apply([event()])).rejects.toThrow('redis is down');
    expect(store.stats().writes).toBe(0);
  });
});

describe('IncidentStore reads', () => {
  it('lists active incidents from the set, sorted, never by scanning keys', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });
    await store.apply([event({ incidentId: 'INC-b' }), event({ incidentId: 'INC-a' })]);

    expect(await store.activeIncidentIds()).toEqual(['INC-a', 'INC-b']);
    expect(redis.client.keys).not.toHaveBeenCalled();
  });

  it('returns null for an incident that is not there', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });
    expect(await store.getIncident('INC-missing')).toBeNull();
  });

  it('returns the hash for an incident that is', async () => {
    const redis = fakeRedis();
    const store = new IncidentStore(redis.client, { closedTtlSeconds: 3600 });
    await store.apply([event()]);
    const hash = await store.getIncident('INC-0123456789abcdef');
    expect(hash!.memberCount).toBe('3');
  });
});

describe('toHash', () => {
  it('stores member lists as JSON, not as a delimited string', () => {
    const hash = toHash(event({ memberZones: ['Z-1', 'Z,2'] }));
    expect(JSON.parse(hash.memberZones)).toEqual(['Z-1', 'Z,2']);
    expect(JSON.parse(hash.h3Cells)).toEqual(['cell-a', 'cell-b']);
  });

  it('writes an absent value as an empty string rather than omitting the field', () => {
    const hash = toHash(event());
    expect(hash).toHaveProperty('supersededBy', '');
    expect(hash).toHaveProperty('splitFrom', '');
    expect(hash).toHaveProperty('closeReason', '');
    expect(hash).toHaveProperty('closedAt', '');
    expect(hash).toHaveProperty('bearingDeg', '');
  });

  it('carries the merge pointers when they exist', () => {
    const hash = toHash(
      event({
        eventType: 'CLOSED',
        status: 'CLOSED',
        lifecycleStatus: 'CLOSED',
        closeReason: 'SUPERSEDED',
        supersededBy: 'INC-survivor',
        closedAt: 1768478500000
      })
    );
    expect(hash.supersededBy).toBe('INC-survivor');
    expect(hash.closeReason).toBe('SUPERSEDED');
    expect(hash.closedAt).toBe('1768478500000');
  });

  it('carries a propagation vector once WP4 fills one in', () => {
    const hash = toHash(
      event({ propagation: { bearingDeg: 47.5, speedKmh: 12.25, rSquared: 0.91 } })
    );
    expect(hash.bearingDeg).toBe('47.5');
    expect(hash.speedKmh).toBe('12.25');
    expect(hash.rSquared).toBe('0.91');
  });

  it('keeps event time and write time as separate fields', () => {
    const hash = toHash(event());
    expect(hash.updatedAt).toBe('1768478400000');
    // Wall clock, deliberately a different field. Conflating them is how event-time claims stop
    // being true (ADR-007).
    expect(Number(hash.lastWrittenAt)).toBeGreaterThan(Number(hash.updatedAt));
  });
});
