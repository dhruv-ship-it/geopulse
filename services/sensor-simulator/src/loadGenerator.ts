import { v5 as uuidv5 } from 'uuid';
import { SensorEvent, ZoneConfig, ScenarioType } from './types';

/**
 * Generates load values for sensors from simulated time.
 *
 * Every value here is a pure function of (zone, scenario, simulated time). There is no mutable
 * state, no `Math.random()` and no wall-clock read: rerunning a simulated span reproduces the
 * same events byte for byte, which is what makes replays comparable and every benchmark number
 * re-derivable (CLAUDE.md rule 3).
 */
export class LoadGenerator {
  private static readonly NOISE_FACTOR = 0.1; // 10% deterministic "noise"
  private static readonly SPIKE_MULTIPLIER = 3.0;
  private static readonly DROP_MULTIPLIER = 0.2;

  /**
   * Upper bound on per-zone sensor lag. Real sensors do not report in lockstep, and the
   * consumer should face out-of-order arrival across zones — but the lag is an OFFSET from the
   * shared clock, not a rate. Zones therefore stay within this many milliseconds of each other
   * forever, however long the run. Defect D8 was exactly the opposite: the offset accumulated
   * per event, at a different rate per zone.
   */
  static readonly MAX_SENSOR_LAG_MS = 20;

  /** Namespace for deterministic event ids. A fixed UUID, generated once, never changed. */
  private static readonly EVENT_ID_NAMESPACE = '6f0a4b0c-1c8e-4d9a-9a8b-2f5d3c7e1a44';

  /**
   * How far behind the shared clock this zone's sensor reports, in [0, MAX_SENSOR_LAG_MS].
   * Derived by hashing the zone id, so it is stable across runs and processes but carries no
   * systematic relationship to the zone number (the old `zoneNumber % 20` delay meant lag and
   * geography were correlated, which would have biased correlation measurements).
   */
  static sensorLagMs(zoneId: string): number {
    return this.hashString(zoneId) % (this.MAX_SENSOR_LAG_MS + 1);
  }

  /**
   * Generate one sensor event at the given simulated instant.
   *
   * `simNowMs` comes from the shared VirtualClock. Both timestamps on the record derive from
   * it: `producedAt` is the instant itself, `eventTimestamp` is that instant minus this zone's
   * bounded sensor lag. Neither is a wall-clock read. If real ingest lag is ever worth
   * measuring, that is a separate field stamped by the consumer on receipt.
   */
  static generateEvent(
    zone: ZoneConfig,
    scenario: ScenarioType,
    simNowMs: number
  ): SensorEvent {
    const producedAt = simNowMs;
    const eventTimestamp = simNowMs - this.sensorLagMs(zone.zoneId);

    const baseLoad = this.calculateLoadForScenario(zone.baseLoad, scenario, eventTimestamp);
    const realisticLoad = this.addRealisticVariation(baseLoad, zone.zoneId, eventTimestamp);

    return {
      eventId: this.eventId(zone.zoneId, eventTimestamp),
      zoneId: zone.zoneId,
      latitude: zone.latitude,
      longitude: zone.longitude,
      load: parseFloat(realisticLoad.toFixed(3)),
      eventTimestamp,
      producedAt
    };
  }

  /**
   * Deterministic event id. A v4 UUID would have made two runs of the same scenario differ,
   * so the id is a v5 (name-based) UUID over zone and event time: still a UUID to every
   * consumer, but reproducible, and a natural idempotency key.
   */
  private static eventId(zoneId: string, eventTimestamp: number): string {
    return uuidv5(`${zoneId}:${eventTimestamp}`, this.EVENT_ID_NAMESPACE);
  }

  /**
   * Calculate base load based on scenario type
   */
  private static calculateLoadForScenario(
    baseLoad: number,
    scenario: ScenarioType,
    timestamp: number
  ): number {
    switch (scenario) {
      case 'normal':
        return baseLoad;
      
      case 'spike':
        // In spike scenario, significantly increase load for more transitions
        return Math.min(1.0, baseLoad + 0.5); // Add 0.5 to base load to trigger transitions faster
      
      case 'drop':
        // In drop scenario, significantly decrease load for more transitions
        return Math.max(0.0, baseLoad - 0.4); // Subtract 0.4 from base load to trigger transitions faster
      
      default:
        return baseLoad;
    }
  }

  /**
   * Add realistic time-based variation to load values
   * Creates deterministic but realistic patterns
   */
  private static addRealisticVariation(
    baseLoad: number,
    zoneId: string,
    timestamp: number
  ): number {
    // Deterministic seed based on zone and time
    const zoneSeed = parseInt(zoneId.replace('Z-', '')) * 137;
    const timeSeed = Math.floor(timestamp / 1000);
    const combinedSeed = (zoneSeed + timeSeed) % 10000;
    
    // Generate deterministic pseudo-random value
    const randomFactor = this.pseudoRandom(combinedSeed);
    
    // Add time-of-day variation (simulate daily patterns).
    // UTC, not local time: getHours() reads the host timezone, so the same event timestamp
    // would produce a different load on a machine in a different timezone — or on the same
    // machine either side of a DST change. Determinism is load-bearing for replay and for
    // every measurement taken against this simulator.
    const hourOfDay = new Date(timestamp).getUTCHours();
    const dailyPattern = this.getDailyPattern(hourOfDay);
    
    // Add some noise for realism
    const noise = (randomFactor - 0.5) * this.NOISE_FACTOR;
    
    let finalLoad = baseLoad * (1 + dailyPattern + noise);
    
    // Ensure load stays within valid range
    return Math.max(0.0, Math.min(1.0, finalLoad));
  }

  /**
   * Generate deterministic pseudo-random value (0-1)
   */
  private static pseudoRandom(seed: number): number {
    // Simple deterministic hash-based random
    let hash = seed;
    hash = ((hash >> 16) ^ hash) * 0x45d9f3b;
    hash = ((hash >> 16) ^ hash) * 0x45d9f3b;
    hash = (hash >> 16) ^ hash;
    return (hash >>> 0) / 0xFFFFFFFF;
  }

  /**
   * FNV-1a over the zone id. Deterministic across processes and platforms — unlike a hash of
   * object identity or insertion order.
   */
  private static hashString(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /**
   * Get daily pattern factor based on hour
   * Simulates realistic usage patterns (business hours, night time, etc.)
   */
  private static getDailyPattern(hour: number): number {
    if (hour >= 9 && hour <= 17) {
      // Business hours - slightly higher load
      return 0.15;
    } else if (hour >= 18 && hour <= 22) {
      // Evening hours - moderate load
      return 0.05;
    } else if (hour >= 23 || hour <= 5) {
      // Night time - lower load
      return -0.2;
    } else {
      // Early morning - gradually increasing
      return -0.1;
    }
  }
}
