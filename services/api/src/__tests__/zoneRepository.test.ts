import { ZoneRepository } from '../zoneRepository';

/**
 * In-memory Redis covering the commands ZoneRepository uses. `keys` is deliberately defined
 * and deliberately made to throw: if anything in a request path reaches for KEYS again, these
 * tests fail rather than quietly regressing to the D2 behaviour.
 */
function fakeRedis(seed: { registry?: string[]; hashes?: Record<string, Record<string, string>> } = {}) {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  if (seed.registry) sets.set('zones:registry', new Set(seed.registry));
  for (const [k, v] of Object.entries(seed.hashes ?? {})) hashes.set(k, v);

  const stats = { pipelines: 0, hGetAllCalls: 0, scanCalls: 0 };

  const client: any = {
    keys: jest.fn(() => {
      throw new Error('KEYS must never be called from a request path');
    }),
    sMembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    sAdd: jest.fn(async (key: string, members: string | string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      for (const m of Array.isArray(members) ? members : [members]) set.add(m);
      sets.set(key, set);
      return 1;
    }),
    hGetAll: jest.fn(async (key: string) => {
      stats.hGetAllCalls++;
      return hashes.get(key) ?? {};
    }),
    scan: jest.fn(async () => {
      stats.scanCalls++;
      return { cursor: '0', keys: Array.from(hashes.keys()) };
    }),
    multi: () => {
      const queued: string[] = [];
      const chain: any = {
        hGetAll: (key: string) => {
          queued.push(key);
          return chain;
        },
        exec: async () => {
          stats.pipelines++;
          return queued.map((key) => hashes.get(key) ?? {});
        }
      };
      return chain;
    }
  };

  return { client, sets, hashes, stats };
}

const hash = (zoneId: string, state: string, lat = 1, lon = 2) => ({
  zoneId,
  state,
  avg1m: '0.5',
  avg5m: '0.6',
  latitude: String(lat),
  longitude: String(lon),
  h3Cell: '853da117fffffff',
  h3CoarseCell: '833da1fffffffff',
  lastUpdated: '1700000000000'
});

describe('ZoneRepository', () => {
  const seed = {
    registry: ['Z-0003', 'Z-0001', 'Z-0002'],
    hashes: {
      'zone:Z-0001': hash('Z-0001', 'NORMAL'),
      'zone:Z-0002': hash('Z-0002', 'CRITICAL'),
      'zone:Z-0003': hash('Z-0003', 'CRITICAL')
    }
  };

  it('lists zones from the registry set, never from KEYS', async () => {
    const redis = fakeRedis(seed);
    const result = await new ZoneRepository(redis.client).listZones();

    expect(result.source).toBe('registry');
    expect(result.zones.map((z) => z.zoneId)).toEqual(['Z-0001', 'Z-0002', 'Z-0003']);
    expect(redis.client.keys).not.toHaveBeenCalled();
    expect(redis.client.sMembers).toHaveBeenCalledWith('zones:registry');
  });

  it('fetches all hashes in a single pipeline rather than one round trip per zone', async () => {
    const redis = fakeRedis(seed);
    await new ZoneRepository(redis.client).listZones();

    expect(redis.stats.pipelines).toBe(1);
    expect(redis.stats.hGetAllCalls).toBe(0);
  });

  it('filters by state', async () => {
    const redis = fakeRedis(seed);
    const result = await new ZoneRepository(redis.client).listZones('CRITICAL');
    expect(result.zones.map((z) => z.zoneId)).toEqual(['Z-0002', 'Z-0003']);
  });

  it('surfaces the H3 cells the registry now carries', async () => {
    const redis = fakeRedis(seed);
    const zone = await new ZoneRepository(redis.client).getZone('Z-0001');
    expect(zone).toMatchObject({ h3Cell: '853da117fffffff', h3CoarseCell: '833da1fffffffff' });
  });

  it('skips a registry entry whose hash has gone, rather than emitting a null zone', async () => {
    const redis = fakeRedis({ ...seed, registry: [...seed.registry, 'Z-GONE'] });
    const result = await new ZoneRepository(redis.client).listZones();
    expect(result.zones.map((z) => z.zoneId)).toEqual(['Z-0001', 'Z-0002', 'Z-0003']);
  });

  it('falls back to SCAN and repopulates the registry when the set is missing', async () => {
    const redis = fakeRedis({ hashes: seed.hashes });
    const result = await new ZoneRepository(redis.client).listZones();

    expect(result.source).toBe('scan');
    expect(redis.stats.scanCalls).toBe(1);
    expect(redis.client.keys).not.toHaveBeenCalled();
    expect(result.zones).toHaveLength(3);
    // Self-healing: the next request takes the registry path.
    expect(Array.from(redis.sets.get('zones:registry')!).sort()).toEqual([
      'Z-0001',
      'Z-0002',
      'Z-0003'
    ]);
  });

  it('returns an empty list, and no pipeline, when there are no zones at all', async () => {
    const redis = fakeRedis();
    const result = await new ZoneRepository(redis.client).listZones();
    expect(result.zones).toEqual([]);
    expect(redis.stats.pipelines).toBe(0);
  });

  it('returns null for an unknown zone', async () => {
    const redis = fakeRedis(seed);
    expect(await new ZoneRepository(redis.client).getZone('Z-NOPE')).toBeNull();
  });

  it('resolves a list of ids in one pipeline for the geo-radius path', async () => {
    const redis = fakeRedis(seed);
    const zones = await new ZoneRepository(redis.client).getZonesByIds(['Z-0002', 'Z-0001']);

    expect(zones.map((z) => z.zoneId)).toEqual(['Z-0002', 'Z-0001']);
    expect(redis.stats.pipelines).toBe(1);
  });
});
