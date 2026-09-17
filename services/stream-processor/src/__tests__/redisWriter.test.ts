import { RedisWriter } from '../redisWriter';
import { cellsFor, H3_RESOLUTION, H3_COARSE_RESOLUTION } from '../spatial';
import { TimeWindowManager } from '../timeWindowManager';
import { ZoneStateData } from '../types';
import { cellToParent, getResolution } from 'h3-js';

/**
 * Minimal in-memory Redis covering the commands RedisWriter uses, including MULTI. Records
 * the command order so the tests can assert the registry write and the hash write go out in
 * the same transaction.
 */
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const geo = new Map<string, { longitude: number; latitude: number }>();
  const calls: string[] = [];

  const ops = {
    sAdd(key: string, member: string | string[]) {
      calls.push('sAdd');
      const set = sets.get(key) ?? new Set<string>();
      for (const m of Array.isArray(member) ? member : [member]) set.add(m);
      sets.set(key, set);
    },
    hSet(key: string, fields: Record<string, string>) {
      calls.push('hSet');
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields });
    },
    geoAdd(key: string, entry: { longitude: number; latitude: number; member: string }) {
      calls.push('geoAdd');
      geo.set(entry.member, { longitude: entry.longitude, latitude: entry.latitude });
    }
  };

  const multi = () => {
    const queued: (() => void)[] = [];
    const chain: any = {
      sAdd: (k: string, m: any) => (queued.push(() => ops.sAdd(k, m)), chain),
      hSet: (k: string, f: any) => (queued.push(() => ops.hSet(k, f)), chain),
      geoAdd: (k: string, e: any) => (queued.push(() => ops.geoAdd(k, e)), chain),
      exec: async () => {
        queued.forEach((fn) => fn());
        calls.push('exec');
        return [];
      }
    };
    return chain;
  };

  const client: any = {
    multi,
    sAdd: async (k: string, m: any) => ops.sAdd(k, m),
    sMembers: async (k: string) => Array.from(sets.get(k) ?? []),
    hGetAll: async (k: string) => hashes.get(k) ?? {},
    scan: jest.fn()
  };

  return { client, sets, hashes, geo, calls };
}

const T0 = 1_700_000_000_000;

const stateData = (): ZoneStateData => {
  const window1m = TimeWindowManager.createWindow();
  const window5m = TimeWindowManager.createWindow();
  TimeWindowManager.addEvent(window1m, 1_700_000_000_000, 0.9, TimeWindowManager.WINDOW_1M_SECONDS);
  TimeWindowManager.addEvent(window5m, 1_700_000_000_000, 0.8, TimeWindowManager.WINDOW_5M_SECONDS);
  return {
    currentState: 'CRITICAL',
    window1m,
    window5m,
    stressedSince: null,
    criticalSince: 1_700_000_000_000,
    lastAlertTimestamp: null
  };
};

describe('spatial cells', () => {
  it('produces cells at the configured detection and partition resolutions', () => {
    const cells = cellsFor(28.6139, 77.209);
    expect(getResolution(cells.h3Cell)).toBe(H3_RESOLUTION);
    expect(getResolution(cells.h3CoarseCell)).toBe(H3_COARSE_RESOLUTION);
  });

  it('nests the fine cell inside the coarse cell, which is what makes the coarse cell a valid partition key', () => {
    const cells = cellsFor(-33.8688, 151.2093);
    expect(cellToParent(cells.h3Cell, H3_COARSE_RESOLUTION)).toBe(cells.h3CoarseCell);
  });

  it('is deterministic for the same coordinate', () => {
    expect(cellsFor(51.5074, -0.1278)).toEqual(cellsFor(51.5074, -0.1278));
  });

  it('places nearby coordinates in the same coarse cell and distant ones in different cells', () => {
    const delhi = cellsFor(28.6139, 77.209);
    const nearDelhi = cellsFor(28.62, 77.215);
    const sydney = cellsFor(-33.8688, 151.2093);

    expect(nearDelhi.h3CoarseCell).toBe(delhi.h3CoarseCell);
    expect(sydney.h3CoarseCell).not.toBe(delhi.h3CoarseCell);
  });
});

describe('RedisWriter registry', () => {
  it('registers a zone into zones:registry with its coordinates and H3 cells', async () => {
    const redis = fakeRedis();
    const writer = new RedisWriter(redis.client);

    const cells = await writer.registerZone('Z-0001', 28.6139, 77.209, T0);

    expect(Array.from(redis.sets.get('zones:registry')!)).toEqual(['Z-0001']);
    expect(redis.hashes.get('zone:Z-0001')).toMatchObject({
      zoneId: 'Z-0001',
      // A zone that has never transitioned is NORMAL, not stateless.
      state: 'NORMAL',
      avg1m: '0',
      avg5m: '0',
      latitude: '28.6139',
      longitude: '77.209',
      h3Cell: cells.h3Cell,
      h3CoarseCell: cells.h3CoarseCell,
      lastEventTime: String(T0)
    });
    expect(redis.geo.get('Z-0001')).toEqual({ latitude: 28.6139, longitude: 77.209 });
  });

  it('issues the registry, hash and geo writes as one transaction', async () => {
    const redis = fakeRedis();
    await new RedisWriter(redis.client).registerZone('Z-0002', 10, 20, T0);
    expect(redis.calls).toEqual(['sAdd', 'hSet', 'geoAdd', 'exec']);
  });

  it('is idempotent, so a zone reappearing after state eviction does not duplicate anything', async () => {
    const redis = fakeRedis();
    const writer = new RedisWriter(redis.client);

    await writer.registerZone('Z-0003', 1, 2, T0);
    await writer.registerZone('Z-0003', 1, 2, T0);

    expect(redis.sets.get('zones:registry')!.size).toBe(1);
  });

  it('writes state without dropping the registry fields, and records event time separately from wall clock', async () => {
    const redis = fakeRedis();
    const writer = new RedisWriter(redis.client);

    await writer.registerZone('Z-0004', 35.6762, 139.6503, T0);
    await writer.writeZoneState('Z-0004', stateData(), 35.6762, 139.6503, 1_700_000_000_000);

    const hash = redis.hashes.get('zone:Z-0004')!;
    expect(hash.state).toBe('CRITICAL');
    expect(hash.h3Cell).toBe(cellsFor(35.6762, 139.6503).h3Cell);
    expect(hash.lastEventTime).toBe('1700000000000');
    expect(hash.lastUpdated).not.toBe(hash.lastEventTime);
  });

  it('lists registered zones from the set rather than the keyspace', async () => {
    const redis = fakeRedis();
    const writer = new RedisWriter(redis.client);

    await writer.registerZone('Z-0009', 1, 1, T0);
    await writer.registerZone('Z-0002', 2, 2, T0);

    expect(await writer.getRegisteredZoneIds()).toEqual(['Z-0002', 'Z-0009']);
  });

  it('rebuilds the registry by SCAN when the set has been lost', async () => {
    const redis = fakeRedis();
    redis.client.scan
      .mockResolvedValueOnce({ cursor: '17', keys: ['zone:Z-0001', 'zone:Z-0002'] })
      .mockResolvedValueOnce({ cursor: '0', keys: ['zone:Z-0003'] });

    const writer = new RedisWriter(redis.client);
    const recovered = await writer.rebuildRegistryByScan();

    expect(recovered).toBe(3);
    expect(redis.client.scan).toHaveBeenCalledTimes(2);
    expect(Array.from(redis.sets.get('zones:registry')!).sort()).toEqual([
      'Z-0001',
      'Z-0002',
      'Z-0003'
    ]);
  });
});
