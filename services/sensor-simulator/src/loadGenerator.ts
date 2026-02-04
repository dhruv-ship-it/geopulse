import { v4 as uuidv4 } from 'uuid';
import { SensorEvent, ZoneConfig, ScenarioType } from './types';

/**
 * Generates realistic load values for sensors based on scenario and time
 * Implements deterministic patterns with realistic noise
 */
export class LoadGenerator {
  private static readonly NOISE_FACTOR = 0.1; // 10% random noise
  private static readonly SPIKE_MULTIPLIER = 3.0;
  private static readonly DROP_MULTIPLIER = 0.2;
  
  /**
   * Generate a sensor event with realistic load value
   */
  private static zoneClocks = new Map<string, number>();
  
  static generateEvent(
    zone: ZoneConfig,
    scenario: ScenarioType,
    producedAt: number
  ): SensorEvent {
    // Simulate event timestamp with small offset from produced time
    // This creates realistic event-time semantics for Phase 2
    let eventTimestamp = this.zoneClocks.get(zone.zoneId) || producedAt;
    
    // Add small incremental delay (1-20ms) to simulate sensor processing time
    const processingDelay = 1 + (parseInt(zone.zoneId.replace('Z-', '')) % 20);
    eventTimestamp = Math.min(eventTimestamp + processingDelay, producedAt);
    
    // Update zone clock
    this.zoneClocks.set(zone.zoneId, eventTimestamp);
    
    const baseLoad = this.calculateLoadForScenario(zone.baseLoad, scenario, eventTimestamp);
    const realisticLoad = this.addRealisticVariation(baseLoad, zone.zoneId, eventTimestamp);
    
    return {
      eventId: uuidv4(),
      zoneId: zone.zoneId,
      latitude: zone.latitude,
      longitude: zone.longitude,
      load: parseFloat(realisticLoad.toFixed(3)),
      eventTimestamp,
      producedAt
    };
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
    
    // Add time-of-day variation (simulate daily patterns)
    const hourOfDay = new Date(timestamp).getHours();
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