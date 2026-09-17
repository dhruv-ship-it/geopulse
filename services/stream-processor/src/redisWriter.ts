import { RedisClientType } from 'redis';
import { ZoneStateData } from './types';
import { TimeWindowManager } from './timeWindowManager';
import { ZoneCells, cellsFor } from '@geopulse/spatial';

const GEO_INDEX_KEY = 'zones:geo';
const REGISTRY_KEY = 'zones:registry';

export interface ZoneRegistryEntry {
  zoneId: string;
  latitude: number;
  longitude: number;
  h3Cell: string;
  h3CoarseCell: string;
}

/**
 * Writes zone state and the zone registry to Redis.
 *
 * The registry is `zones:registry` (a SET of zone ids) alongside the existing `zone:<id>`
 * HASH, which now also carries the zone's H3 cells. Two things depend on it:
 *
 *   - the API, which previously enumerated zones with `KEYS zone:Z-*`. KEYS is O(N) over the
 *     entire keyspace and blocks the Redis event loop for the duration.
 *   - the correlation engine (WP1+), which needs every zone's cell to build the neighbour
 *     graph, including zones that have never left NORMAL and so have never emitted a state
 *     change.
 *
 * That second point is why registration is separate from writeZoneState: state is written on
 * transition, registration happens the first time a zone is seen.
 */
export class RedisWriter {
  private client: RedisClientType;

  constructor(redisClient: RedisClientType) {
    this.client = redisClient;
  }

  /**
   * Record a zone's identity and location. Idempotent — safe to call again when a zone
   * reappears after its in-memory state was evicted.
   */
  async registerZone(
    zoneId: string,
    latitude: number,
    longitude: number,
    eventTime: number
  ): Promise<ZoneCells> {
    const cells = cellsFor(latitude, longitude);
    const zoneKey = `zone:${zoneId}`;

    // Seed the state fields as well as identity. A zone only gets a writeZoneState on a
    // transition, so without this a zone that has never left NORMAL would be listed by the
    // API with no state at all — and 'no state' is not the same claim as NORMAL. NORMAL is
    // what the state machine actually believes on first sight, and it is also what it
    // believes about a zone that reappears after eviction, so re-registering stays truthful.
    await this.client
      .multi()
      .sAdd(REGISTRY_KEY, zoneId)
      .hSet(zoneKey, {
        zoneId,
        state: 'NORMAL',
        avg1m: '0',
        avg5m: '0',
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        h3Cell: cells.h3Cell,
        h3CoarseCell: cells.h3CoarseCell,
        lastEventTime: eventTime.toString(),
        lastUpdated: Date.now().toString()
      })
      .geoAdd(GEO_INDEX_KEY, { longitude, latitude, member: zoneId })
      .exec();

    return cells;
  }

  /**
   * Write zone state to Redis when state changes.
   *
   * `lastEventTime` is the event-time of the event that caused the transition. `lastUpdated`
   * stays wall-clock because the API surfaces it as "when did this row last change"; the two
   * are different questions and conflating them is how event-time claims stop being true.
   */
  async writeZoneState(
    zoneId: string,
    stateData: ZoneStateData,
    latitude: number,
    longitude: number,
    eventTime: number
  ): Promise<void> {
    try {
      const avg1m = TimeWindowManager.calculateAverage(stateData.window1m);
      const avg5m = TimeWindowManager.calculateAverage(stateData.window5m);
      const cells = cellsFor(latitude, longitude);

      const zoneKey = `zone:${zoneId}`;

      await this.client
        .multi()
        .sAdd(REGISTRY_KEY, zoneId)
        .hSet(zoneKey, {
          zoneId,
          state: stateData.currentState,
          avg1m: avg1m.toString(),
          avg5m: avg5m.toString(),
          latitude: latitude.toString(),
          longitude: longitude.toString(),
          h3Cell: cells.h3Cell,
          h3CoarseCell: cells.h3CoarseCell,
          lastEventTime: eventTime.toString(),
          lastUpdated: Date.now().toString()
        })
        .geoAdd(GEO_INDEX_KEY, { longitude, latitude, member: zoneId })
        .exec();
    } catch (error) {
      console.error(`Failed to write zone state for ${zoneId}:`, error);
      throw error;
    }
  }

  /**
   * All known zone ids, from the registry set. O(N) in the number of zones, not in the size
   * of the whole keyspace.
   */
  async getRegisteredZoneIds(): Promise<string[]> {
    const ids = await this.client.sMembers(REGISTRY_KEY);
    return ids.sort();
  }

  /**
   * RECOVERY PATH ONLY — not for request handling.
   *
   * Rebuilds `zones:registry` by scanning the keyspace, for the case where the set was lost
   * (flushed, or zones written by a build that predates the registry). SCAN is cursor-based
   * and each call touches a bounded number of keys, so it does not block the server the way
   * KEYS does. The tradeoff: SCAN guarantees every key present for the whole scan is returned
   * at least once, but makes no guarantee about keys added or removed mid-scan, and may
   * return duplicates. For a rebuild into a SET, both are harmless.
   */
  async rebuildRegistryByScan(): Promise<number> {
    let cursor = '0';
    const found: string[] = [];

    do {
      const reply: any = await (this.client as any).scan(cursor, {
        MATCH: 'zone:Z-*',
        COUNT: 500
      });
      cursor = String(reply.cursor);
      for (const key of reply.keys as string[]) {
        found.push(key.slice('zone:'.length));
      }
    } while (cursor !== '0');

    if (found.length > 0) {
      await this.client.sAdd(REGISTRY_KEY, found);
    }
    return found.length;
  }

  /**
   * Get zone data by ID
   */
  async getZoneData(zoneId: string): Promise<any> {
    try {
      const zoneKey = `zone:${zoneId}`;
      const data = await this.client.hGetAll(zoneKey);
      return Object.keys(data).length > 0 ? data : null;
    } catch (error) {
      console.error(`Failed to get zone data for ${zoneId}:`, error);
      return null;
    }
  }
}
