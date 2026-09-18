import { NeighbourGraph } from '@geopulse/spatial';

import { ZoneRegistry } from '../zoneRegistry';
import { ZoneDegradation } from '../types';

/**
 * In-memory Redis covering exactly the commands ZoneRegistry uses. `keys` is defined and made
 * to throw, the same guard the API's repository tests carry: the registry exists because
 * `KEYS zone:Z-*` was defect D2, and nothing here may quietly go back to it.
 */
function fakeRedis(seed: {
  registry?: string[];
  hashes?: Record<string, Record<string, string>>;
} = {}) {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  if (seed.registry) sets.set('zones:registry', new Set(seed.registry));
  for (const [key, value] of Object.entries(seed.hashes ?? {})) hashes.set(key, value);

  const stats = { pipelines: 0, hGetAllQueued: 0, sMembersCalls: 0 };

  const client: any = {
    keys: jest.fn(() => {
      throw new Error('KEYS must never be called');
    }),
    sMembers: jest.fn(async (key: string) => {
      stats.sMembersCalls++;
      return Array.from(sets.get(key) ?? []);
    }),
    multi: () => {
      const queued: string[] = [];
      const chain: any = {
        hGetAll: (key: string) => {
          queued.push(key);
          stats.hGetAllQueued++;
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

const zoneHash = (zoneId: string, latitude: number, longitude: number, h3Cell?: string) => ({
  zoneId,
  state: 'NORMAL',
  latitude: String(latitude),
  longitude: String(longitude),
  ...(h3Cell ? { h3Cell } : {})
});

const degradation = (
  zoneId: string,
  latitude: number,
  longitude: number
): ZoneDegradation => ({
  zoneId,
  h3Cell: '',
  h3CoarseCell: '',
  latitude,
  longitude,
  previousState: 'NORMAL',
  currentState: 'STRESSED',
  severity: 0.8,
  avg1m: 0.8,
  avg5m: 0.78,
  eventTime: 1768478400000
});

describe('ZoneRegistry.load', () => {
  it('builds the graph from the registry in one pipelined round trip', async () => {
    const redis = fakeRedis({
      registry: ['Z-1', 'Z-2', 'Z-3'],
      hashes: {
        'zone:Z-1': zoneHash('Z-1', 30.0, 70.0),
        'zone:Z-2': zoneHash('Z-2', 30.01, 70.01),
        'zone:Z-3': zoneHash('Z-3', 30.02, 70.02)
      }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);

    expect(await registry.load()).toBe(3);
    expect(graph.stats().zones).toBe(3);
    expect(redis.stats.pipelines).toBe(1);
    expect(registry.has('Z-2')).toBe(true);
    expect(registry.stats().loads).toBe(1);
  });

  it('treats an empty registry as a normal startup, not a failure', async () => {
    const redis = fakeRedis();
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);

    expect(await registry.load()).toBe(0);
    expect(graph.stats().zones).toBe(0);
    // No pipeline: nothing to fetch, so no round trip is wasted asking for it.
    expect(redis.stats.pipelines).toBe(0);
  });

  it('skips a registry entry whose hash has gone', async () => {
    const redis = fakeRedis({
      registry: ['Z-1', 'Z-ghost'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 10, 10) }
    });
    const registry = new ZoneRegistry(redis.client, new NeighbourGraph());

    expect(await registry.load()).toBe(1);
    expect(registry.has('Z-ghost')).toBe(false);
  });

  it('skips a registry entry with unusable coordinates', async () => {
    const redis = fakeRedis({
      registry: ['Z-1', 'Z-bad'],
      hashes: {
        'zone:Z-1': zoneHash('Z-1', 10, 10),
        'zone:Z-bad': { zoneId: 'Z-bad', latitude: 'north', longitude: '' }
      }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);

    expect(await registry.load()).toBe(1);
    expect(graph.has('Z-bad')).toBe(false);
  });

  it('replaces the previous contents rather than accumulating', async () => {
    const redis = fakeRedis({
      registry: ['Z-1'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 10, 10), 'zone:Z-2': zoneHash('Z-2', 11, 11) }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);
    await registry.load();

    redis.sets.get('zones:registry')!.delete('Z-1');
    redis.sets.get('zones:registry')!.add('Z-2');
    await registry.load();

    expect(graph.has('Z-1')).toBe(false);
    expect(graph.has('Z-2')).toBe(true);
    expect(registry.has('Z-1')).toBe(false);
  });
});

describe('ZoneRegistry.refresh', () => {
  it('fetches only the zones it has not seen', async () => {
    const redis = fakeRedis({
      registry: ['Z-1'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 10, 10), 'zone:Z-2': zoneHash('Z-2', 10.01, 10.01) }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);
    await registry.load();
    const queuedAfterLoad = redis.stats.hGetAllQueued;

    redis.sets.get('zones:registry')!.add('Z-2');
    expect(await registry.refresh()).toBe(1);

    expect(redis.stats.hGetAllQueued - queuedAfterLoad).toBe(1);
    expect(graph.has('Z-2')).toBe(true);
    expect(registry.stats().discoveredByRefresh).toBe(1);
  });

  it('does no pipeline at all when nothing is new', async () => {
    const redis = fakeRedis({
      registry: ['Z-1'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 10, 10) }
    });
    const registry = new ZoneRegistry(redis.client, new NeighbourGraph());
    await registry.load();
    const pipelines = redis.stats.pipelines;

    expect(await registry.refresh()).toBe(0);
    expect(redis.stats.pipelines).toBe(pipelines);
  });
});

describe('ZoneRegistry.observe', () => {
  it('places a zone from the degradation message alone, with no I/O', async () => {
    const redis = fakeRedis();
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);
    await registry.load();
    const calls = redis.stats.sMembersCalls;

    registry.observe(degradation('Z-9', 30.0, 70.0));

    expect(graph.has('Z-9')).toBe(true);
    expect(registry.has('Z-9')).toBe(true);
    expect(registry.stats().discoveredInline).toBe(1);
    expect(redis.stats.sMembersCalls).toBe(calls);
  });

  it('counts an inline discovery once, however many degradations follow', () => {
    const registry = new ZoneRegistry(fakeRedis().client, new NeighbourGraph());
    registry.observe(degradation('Z-9', 30.0, 70.0));
    registry.observe(degradation('Z-9', 30.0, 70.0));
    expect(registry.stats().discoveredInline).toBe(1);
  });

  it('notices a zone that moved to a different cell', () => {
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(fakeRedis().client, graph);

    registry.observe(degradation('Z-9', 30.0, 70.0));
    registry.observe(degradation('Z-9', 40.0, 80.0));

    expect(registry.stats().relocated).toBe(1);
    expect(graph.cellOf('Z-9')).toBeDefined();
  });

  it('does not count a zone that stayed put as relocated', () => {
    const registry = new ZoneRegistry(fakeRedis().client, new NeighbourGraph());
    registry.observe(degradation('Z-9', 30.0, 70.0));
    registry.observe(degradation('Z-9', 30.000001, 70.000001));
    expect(registry.stats().relocated).toBe(0);
  });

  it('makes a zone discovered inline adjacent to its registry neighbours', async () => {
    const redis = fakeRedis({
      registry: ['Z-1'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 30.0, 70.0) }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);
    await registry.load();

    registry.observe(degradation('Z-2', 30.001, 70.001));

    expect(graph.neighboursOf('Z-1')).toContain('Z-2');
    expect(graph.neighboursOf('Z-2')).toContain('Z-1');
  });
});

describe('ZoneRegistry background refresh', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('discovers zones on the interval', async () => {
    const redis = fakeRedis({
      registry: ['Z-1'],
      hashes: { 'zone:Z-1': zoneHash('Z-1', 10, 10), 'zone:Z-2': zoneHash('Z-2', 10.01, 10.01) }
    });
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redis.client, graph);
    await registry.load();

    registry.startBackgroundRefresh(1000);
    redis.sets.get('zones:registry')!.add('Z-2');

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(graph.has('Z-2')).toBe(true);
    registry.stopBackgroundRefresh();
  });

  it('survives a refresh that throws, and keeps the timer alive', async () => {
    const redis = fakeRedis({ registry: ['Z-1'] });
    const registry = new ZoneRegistry(redis.client, new NeighbourGraph());
    redis.client.sMembers = jest.fn(async () => {
      throw new Error('redis is down');
    });

    registry.startBackgroundRefresh(1000);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(redis.client.sMembers).toHaveBeenCalledTimes(2);
    registry.stopBackgroundRefresh();
  });

  it('starts at most one timer and stops cleanly when never started', () => {
    const registry = new ZoneRegistry(fakeRedis().client, new NeighbourGraph());
    registry.stopBackgroundRefresh();
    registry.startBackgroundRefresh(1000);
    registry.startBackgroundRefresh(1000);
    expect(jest.getTimerCount()).toBe(1);
    registry.stopBackgroundRefresh();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not start a timer for a non-positive interval', () => {
    const registry = new ZoneRegistry(fakeRedis().client, new NeighbourGraph());
    registry.startBackgroundRefresh(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
