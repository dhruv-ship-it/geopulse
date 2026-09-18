import { RedisClientType } from 'redis';
import { NeighbourGraph, ZoneLocation } from '@geopulse/spatial';

import { logger } from './logger';
import { zonesKnown } from './metrics';
import { ZoneDegradation } from './types';

const REGISTRY_KEY = 'zones:registry';
const ZONE_KEY_PREFIX = 'zone:';

export interface ZoneRegistryStats {
  /** Zones in the graph. */
  zones: number;
  /** Full loads run — one at startup, plus any manual reload. */
  loads: number;
  /** Background refreshes that actually queried Redis. */
  refreshes: number;
  /** Zones added by a refresh. */
  discoveredByRefresh: number;
  /** Zones added from a degradation message for a zone the registry had not yet mentioned. */
  discoveredInline: number;
  /** Zones whose coordinates moved after they were first placed. */
  relocated: number;
}

/**
 * Keeps the neighbour graph in step with the fleet.
 *
 * `stream-processor` registers a zone in `zones:registry` (a SET) plus a `zone:<id>` HASH the
 * first time it sees an event from it, which is the only reason this service can know where a
 * zone is at all. Two things follow from that being a *different process on a different
 * stream*:
 *
 * **The graph is never authoritative, only current.** A degradation can arrive for a zone whose
 * registration this process has not read yet — the two travel on different topics with different
 * consumer lag. `NeighbourGraph.neighboursOf` answers empty for an unknown zone rather than
 * throwing, which is the truthful answer at that instant, and it changes as soon as the zone is
 * placed. The cost is a missed merge, never an invented one, and it heals on the zone's next
 * degradation — at most one sample interval away for a zone that is actively degrading.
 *
 * **Discovery has to be cheap.** Three mechanisms, in increasing cost and decreasing frequency:
 *
 * 1. `observe()` — the degradation message itself carries `zoneId`, `latitude`, `longitude` and
 *    `h3Cell`, which is everything `ZoneLocation` needs. A zone that degrades therefore places
 *    itself, with no I/O at all. This is the path that matters, because a zone that never
 *    degrades cannot be in anybody's component and its absence from the graph costs nothing.
 * 2. `refresh()` — re-reads the registry SET on a timer and fetches hashes only for ids it has
 *    not seen. One `SMEMBERS` plus one pipelined `HGETALL` per new zone. This exists for the
 *    zone that is registered but silent, so that the graph is complete before it first degrades
 *    rather than one sample afterwards.
 * 3. `load()` — the full startup read.
 *
 * Redis keyspace notifications or a pub/sub channel published by `stream-processor` would make
 * (2) event-driven instead of polled, and that is the obvious next move. It is not made here
 * because it requires a change on the producing side, which is WP3 item 8, and because a
 * 60-second poll over a SET of a few thousand ids is not a cost worth a new coupling yet.
 */
export class ZoneRegistry {
  private readonly known = new Set<string>();

  private loads = 0;
  private refreshes = 0;
  private discoveredByRefresh = 0;
  private discoveredInline = 0;
  private relocated = 0;

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: RedisClientType,
    private readonly graph: NeighbourGraph
  ) {}

  /**
   * Read every registered zone and build the graph from scratch.
   *
   * An empty registry is logged as a warning and is not an error: a stack whose
   * `stream-processor` has not yet seen an event has an empty registry and nothing is wrong
   * with it. Inline discovery will fill the graph as degradations arrive. Failing hard here
   * would make the correlation engine unable to start before the rest of the pipeline has,
   * which is an ordering constraint with no justification behind it.
   */
  async load(): Promise<number> {
    const zoneIds = await this.client.sMembers(REGISTRY_KEY);
    this.loads++;

    if (zoneIds.length === 0) {
      logger.warn(
        { registryKey: REGISTRY_KEY },
        'Zone registry is empty; the graph will fill from degradation messages as they arrive'
      );
      this.syncGauge();
      return 0;
    }

    const zones = await this.fetchZones(zoneIds);
    this.graph.build(zones);
    this.known.clear();
    for (const zone of zones) {
      this.known.add(zone.zoneId);
    }

    const stats = this.graph.stats();
    logger.info(
      {
        registered: zoneIds.length,
        placed: zones.length,
        occupiedCells: stats.occupiedCells,
        recomputedCells: stats.recomputedCells,
        geometry: this.graph.geometry
      },
      'Zone registry loaded'
    );
    // Non-zero means some producer computed cells at a different resolution than this process
    // reads them at — which is silent by construction, so it is said out loud here.
    if (stats.recomputedCells > 0) {
      logger.warn(
        { recomputedCells: stats.recomputedCells, geometry: this.graph.geometry },
        'Some stored h3Cell values were at the wrong resolution and were recomputed'
      );
    }

    this.syncGauge();
    return zones.length;
  }

  /** Read the registry and place any zone the graph has not seen. Returns how many were added. */
  async refresh(): Promise<number> {
    const zoneIds = await this.client.sMembers(REGISTRY_KEY);
    this.refreshes++;

    const missing = zoneIds.filter((zoneId) => !this.known.has(zoneId));
    if (missing.length === 0) {
      return 0;
    }

    const zones = await this.fetchZones(missing);
    for (const zone of zones) {
      this.graph.addZone(zone);
      this.known.add(zone.zoneId);
    }
    this.discoveredByRefresh += zones.length;

    logger.info({ discovered: zones.length, zones: this.known.size }, 'Zone registry refreshed');
    this.syncGauge();
    return zones.length;
  }

  /**
   * Place the zone a degradation came from, from the message's own coordinates. No I/O.
   *
   * Also handles a zone that moved. A moved zone is not a normal event for fixed sensors, but
   * `NeighbourGraph.addZone` supports it and silently keeping a stale cell would put a zone in
   * a component it is no longer anywhere near. Counted, because it should be rare enough that a
   * non-zero count is worth a look.
   */
  observe(degradation: ZoneDegradation): void {
    const location: ZoneLocation = {
      zoneId: degradation.zoneId,
      latitude: degradation.latitude,
      longitude: degradation.longitude,
      h3Cell: degradation.h3Cell
    };

    const previousCell = this.graph.cellOf(degradation.zoneId);
    const cell = this.graph.addZone(location);

    if (previousCell === undefined) {
      if (!this.known.has(degradation.zoneId)) {
        this.known.add(degradation.zoneId);
        this.discoveredInline++;
        this.syncGauge();
      }
    } else if (previousCell !== cell) {
      this.relocated++;
      logger.warn(
        { zoneId: degradation.zoneId, from: previousCell, to: cell },
        'Zone moved to a different H3 cell'
      );
    }
  }

  /**
   * Start the background refresh. `unref` so a pending timer cannot hold the process open
   * during shutdown — the loop is a convenience, not something worth delaying an exit for.
   */
  startBackgroundRefresh(intervalMs: number): void {
    if (this.timer !== null || intervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      this.refresh().catch((error) => {
        // Swallowed deliberately: a failed refresh is recoverable — the next tick retries, and
        // inline discovery keeps working meanwhile. Letting it reject unhandled would take the
        // process down over a transient Redis blip, which is a worse outcome than a stale graph.
        logger.error({ error }, 'Zone registry refresh failed; will retry on the next interval');
      });
    }, intervalMs);
    this.timer.unref();
    logger.info({ intervalMs }, 'Zone registry background refresh started');
  }

  stopBackgroundRefresh(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  has(zoneId: string): boolean {
    return this.known.has(zoneId);
  }

  stats(): ZoneRegistryStats {
    return {
      zones: this.known.size,
      loads: this.loads,
      refreshes: this.refreshes,
      discoveredByRefresh: this.discoveredByRefresh,
      discoveredInline: this.discoveredInline,
      relocated: this.relocated
    };
  }

  /** One pipelined round trip for N hashes, not N round trips. Same shape as the API's reader. */
  private async fetchZones(zoneIds: readonly string[]): Promise<ZoneLocation[]> {
    if (zoneIds.length === 0) {
      return [];
    }

    const pipeline = this.client.multi();
    for (const zoneId of zoneIds) {
      pipeline.hGetAll(`${ZONE_KEY_PREFIX}${zoneId}`);
    }
    const replies = (await pipeline.exec()) as unknown as Record<string, string>[];

    const zones: ZoneLocation[] = [];
    replies.forEach((hash, index) => {
      const zoneId = zoneIds[index];
      // A registry entry whose hash is gone is stale, not an error.
      if (!hash || Object.keys(hash).length === 0) {
        return;
      }
      const latitude = Number(hash.latitude);
      const longitude = Number(hash.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        logger.warn({ zoneId, latitude: hash.latitude, longitude: hash.longitude },
          'Registry entry has unusable coordinates; skipping');
        return;
      }
      zones.push({
        zoneId,
        latitude,
        longitude,
        h3Cell: hash.h3Cell || undefined
      });
    });
    return zones;
  }

  private syncGauge(): void {
    zonesKnown.set(this.known.size);
  }
}
