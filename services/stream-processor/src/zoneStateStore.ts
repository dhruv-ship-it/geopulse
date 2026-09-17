import { ZoneStateData } from './types';

export interface ZoneEntry {
  state: ZoneStateData;
  coordinates: { latitude: number; longitude: number };
  /** Event-time of the most recent event for this zone. */
  lastEventTime: number;
  /** Whether this zone has been written to the Redis zone registry yet. */
  registered: boolean;
}

export interface ZoneStateStoreOptions {
  /**
   * How long a zone may go without an event before its in-memory state is dropped.
   * Must be comfortably larger than the widest window (5m) — evicting a zone that still
   * has a live window would silently reset its averages and its state machine.
   */
  idleTtlMs?: number;
  /** How much event-time must pass between sweeps. */
  sweepIntervalMs?: number;
}

const DEFAULT_IDLE_TTL_MS = parseInt(process.env.ZONE_STATE_IDLE_TTL_MS || '900000', 10);
const DEFAULT_SWEEP_INTERVAL_MS = parseInt(process.env.ZONE_STATE_SWEEP_INTERVAL_MS || '60000', 10);

/**
 * Zone state, bounded.
 *
 * D5: streamProcessor held `zoneStates` and `zoneCoordinates` maps that only ever grew. Every
 * zone that ever emitted an event kept two windows' worth of buckets alive forever, including
 * zones that were decommissioned an hour ago. At 10k zones that is a benchmark that measures
 * the leak rather than the pipeline.
 *
 * Eviction is driven by EVENT TIME, not Date.now(). A watermark tracks the highest event-time
 * seen (it never moves backwards, so an out-of-order event cannot trigger a sweep), and a
 * zone is evicted when the watermark has moved more than idleTtlMs past its last event. That
 * keeps the whole thing deterministic: replaying the same event sequence evicts exactly the
 * same zones at exactly the same points, which is load-bearing for measurement and replay.
 *
 * Note the consequence of a wall-clock alternative: a 10x-speed replay would evict nothing,
 * and a paused replay would evict everything. Neither is a useful definition of "idle".
 *
 * Eviction drops in-memory state only. The Redis zone registry is a catalogue of zones that
 * exist, and a zone that stopped reporting still exists; the correlation engine needs it in
 * the neighbour graph either way.
 */
export class ZoneStateStore {
  private zones = new Map<string, ZoneEntry>();
  private watermark = 0;
  private lastSweepAt = 0;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private evictedCount = 0;

  constructor(options: ZoneStateStoreOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  get size(): number {
    return this.zones.size;
  }

  get evicted(): number {
    return this.evictedCount;
  }

  get currentWatermark(): number {
    return this.watermark;
  }

  has(zoneId: string): boolean {
    return this.zones.has(zoneId);
  }

  get(zoneId: string): ZoneEntry | undefined {
    return this.zones.get(zoneId);
  }

  entries(): IterableIterator<[string, ZoneEntry]> {
    return this.zones.entries();
  }

  /**
   * Record an event for a zone, creating its state on first sight. Advances the watermark.
   */
  observe(
    zoneId: string,
    latitude: number,
    longitude: number,
    eventTime: number,
    createState: () => ZoneStateData
  ): ZoneEntry {
    if (eventTime > this.watermark) {
      this.watermark = eventTime;
      if (this.lastSweepAt === 0) this.lastSweepAt = eventTime;
    }

    let entry = this.zones.get(zoneId);
    if (!entry) {
      entry = {
        state: createState(),
        coordinates: { latitude, longitude },
        lastEventTime: eventTime,
        registered: false
      };
      this.zones.set(zoneId, entry);
      return entry;
    }

    // Keep the newest event-time; an out-of-order event must not make a zone look staler.
    if (eventTime > entry.lastEventTime) entry.lastEventTime = eventTime;
    return entry;
  }

  /**
   * Evict idle zones if enough event-time has passed since the last sweep.
   * Returns the evicted zone ids (empty when no sweep was due).
   */
  sweep(): string[] {
    if (this.watermark - this.lastSweepAt < this.sweepIntervalMs) return [];
    this.lastSweepAt = this.watermark;
    return this.evictIdle();
  }

  /** Unconditional sweep, exposed for tests and for shutdown accounting. */
  evictIdle(): string[] {
    const cutoff = this.watermark - this.idleTtlMs;
    const evicted: string[] = [];
    for (const [zoneId, entry] of this.zones) {
      if (entry.lastEventTime < cutoff) {
        this.zones.delete(zoneId);
        evicted.push(zoneId);
      }
    }
    this.evictedCount += evicted.length;
    return evicted;
  }
}
