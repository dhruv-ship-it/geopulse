import { RedisClientType } from 'redis';

const REGISTRY_KEY = 'zones:registry';
const ZONE_KEY_PREFIX = 'zone:';

export interface Zone {
  zoneId: string;
  state: string;
  avg1m: string;
  avg5m: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  h3CoarseCell?: string;
  lastUpdated: string;
}

export interface ListZonesResult {
  zones: Zone[];
  /** 'registry' in steady state; 'scan' means the registry set was empty and we recovered. */
  source: 'registry' | 'scan';
}

/**
 * Reads zone state from Redis.
 *
 * Replaces `KEYS zone:Z-*`. KEYS walks the entire keyspace — every key, not just matching
 * ones — and Redis is single threaded, so for the whole O(N) walk no other client is served.
 * On a keyspace with unrelated keys the cost is unrelated to how many zones exist. It is the
 * canonical thing not to do in a request path.
 *
 * The replacement reads the zone ids from a SET that stream-processor maintains, then fetches
 * the hashes in one pipelined round trip.
 */
export class ZoneRepository {
  constructor(private client: RedisClientType) {}

  async listZones(state?: string): Promise<ListZonesResult> {
    let zoneIds = await this.client.sMembers(REGISTRY_KEY);
    let source: 'registry' | 'scan' = 'registry';

    if (zoneIds.length === 0) {
      // Registry empty: either genuinely no zones, or the set was lost. SCAN is O(N) too but
      // is cursor-based, so it yields between batches instead of blocking the server. This is
      // a recovery path, and it self-heals by repopulating the set.
      zoneIds = await this.scanZoneIds();
      source = 'scan';
      if (zoneIds.length > 0) {
        await this.client.sAdd(REGISTRY_KEY, zoneIds);
      }
    }

    const zones = await this.getZonesByIds(zoneIds);
    const filtered = state ? zones.filter((z) => z.state === state) : zones;
    filtered.sort((a, b) => a.zoneId.localeCompare(b.zoneId));

    return { zones: filtered, source };
  }

  /** One round trip for N hashes rather than N round trips. */
  async getZonesByIds(zoneIds: string[]): Promise<Zone[]> {
    if (zoneIds.length === 0) return [];

    const pipeline = this.client.multi();
    for (const zoneId of zoneIds) {
      pipeline.hGetAll(`${ZONE_KEY_PREFIX}${zoneId}`);
    }
    const replies = (await pipeline.exec()) as unknown as Record<string, string>[];

    const zones: Zone[] = [];
    replies.forEach((hash, index) => {
      // A registry entry whose hash is gone is stale, not an error; skip it.
      if (!hash || Object.keys(hash).length === 0) return;
      zones.push(toZone(hash, zoneIds[index]));
    });
    return zones;
  }

  async getZone(zoneId: string): Promise<Zone | null> {
    const hash = await this.client.hGetAll(`${ZONE_KEY_PREFIX}${zoneId}`);
    if (!hash || Object.keys(hash).length === 0) return null;
    return toZone(hash, zoneId);
  }

  /** RECOVERY PATH ONLY. See listZones. */
  private async scanZoneIds(): Promise<string[]> {
    let cursor = '0';
    const ids: string[] = [];
    do {
      const reply: any = await (this.client as any).scan(cursor, {
        MATCH: `${ZONE_KEY_PREFIX}Z-*`,
        COUNT: 500
      });
      cursor = String(reply.cursor);
      for (const key of reply.keys as string[]) {
        ids.push(key.slice(ZONE_KEY_PREFIX.length));
      }
    } while (cursor !== '0');
    return Array.from(new Set(ids));
  }
}

function toZone(hash: Record<string, string>, fallbackId: string): Zone {
  return {
    zoneId: hash.zoneId || fallbackId,
    state: hash.state,
    avg1m: hash.avg1m,
    avg5m: hash.avg5m,
    latitude: parseFloat(hash.latitude),
    longitude: parseFloat(hash.longitude),
    h3Cell: hash.h3Cell,
    h3CoarseCell: hash.h3CoarseCell,
    lastUpdated: hash.lastUpdated
  };
}
