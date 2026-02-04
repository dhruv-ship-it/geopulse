import { ZoneConfig } from './types';

/**
 * Generates deterministic zone configurations with realistic geographic distribution
 * Zones are distributed across a pseudo-world map with varying base load characteristics
 */
export class ZoneGenerator {
  private static readonly WORLD_MIN_LAT = -85;
  private static readonly WORLD_MAX_LAT = 85;
  private static readonly WORLD_MIN_LON = -180;
  private static readonly WORLD_MAX_LON = 180;

  /**
   * Generate deterministic zones based on zone count
   * Uses fibonacci spiral distribution for geographic spread
   */
  static generateZones(count: number): ZoneConfig[] {
    const zones: ZoneConfig[] = [];
    
    for (let i = 0; i < count; i++) {
      // Deterministic geographic positioning using golden ratio
      const lat = this.calculateLatitude(i, count);
      const lon = this.calculateLongitude(i, count);
      const baseLoad = this.calculateBaseLoad(i, count);
      
      zones.push({
        zoneId: `Z-${i + 1}`,
        latitude: parseFloat(lat.toFixed(6)),
        longitude: parseFloat(lon.toFixed(6)),
        baseLoad: parseFloat(baseLoad.toFixed(3))
      });
    }
    
    return zones;
  }

  /**
   * Calculate latitude using fibonacci spiral for even distribution
   */
  private static calculateLatitude(index: number, total: number): number {
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle
    const y = 1 - (index / (total - 1)) * 2; // y goes from 1 to -1
    const radius = Math.sqrt(1 - y * y); // radius at y
    
    // Convert to latitude (avoiding poles for realistic distribution)
    const latRad = Math.asin(y);
    const latDeg = (latRad * 180) / Math.PI;
    
    // Clamp to realistic range
    return Math.max(this.WORLD_MIN_LAT, Math.min(this.WORLD_MAX_LAT, latDeg));
  }

  /**
   * Calculate longitude using fibonacci spiral
   */
  private static calculateLongitude(index: number, total: number): number {
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle
    const lonRad = phi * index;
    const lonDeg = (lonRad * 180) / Math.PI;
    
    // Normalize to -180 to 180
    return ((lonDeg + 540) % 360) - 180;
  }

  /**
   * Calculate base load with deterministic variation
   * Creates realistic load patterns (urban vs rural, different regions)
   */
  private static calculateBaseLoad(index: number, total: number): number {
    // Use deterministic seed based on zone index
    const seed = (index * 137) % 1000;
    
    // Base load with regional variation
    let baseLoad = 0.2 + (seed % 300) / 1000; // 0.2 to 0.5 base
    
    // Add some regional patterns
    if (index % 7 === 0) baseLoad += 0.15; // Urban areas
    if (index % 11 === 0) baseLoad -= 0.1; // Rural areas
    if (index % 13 === 0) baseLoad += 0.25; // High activity zones
    
    // Ensure within bounds
    return Math.max(0.05, Math.min(0.95, baseLoad));
  }
}