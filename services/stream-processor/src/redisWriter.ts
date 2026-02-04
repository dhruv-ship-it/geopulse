import { RedisClientType } from 'redis';
import { ZoneStateData } from './types';
import { TimeWindowManager } from './timeWindowManager';

const GEO_INDEX_KEY = 'zones:geo';

/**
 * Redis writer for GeoPulse stream processor
 * Handles writing zone state data to Redis with GEO indexing
 */
export class RedisWriter {
  private client: RedisClientType;

  constructor(redisClient: RedisClientType) {
    this.client = redisClient;
  }

  /**
   * Write zone state to Redis when state changes
   */
  async writeZoneState(
    zoneId: string,
    stateData: ZoneStateData,
    latitude: number,
    longitude: number
  ): Promise<void> {
    try {
      const avg1m = TimeWindowManager.calculateAverage(stateData.window1m);
      const avg5m = TimeWindowManager.calculateAverage(stateData.window5m);
      const lastUpdated = Date.now().toString();

      const zoneKey = `zone:${zoneId}`;
      
      // Write HASH data
      await this.client.hSet(zoneKey, {
        zoneId,
        state: stateData.currentState,
        avg1m: avg1m.toString(),
        avg5m: avg5m.toString(),
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        lastUpdated
      });

      // Update GEO index
      await this.client.geoAdd(GEO_INDEX_KEY, {
        longitude,
        latitude,
        member: zoneId
      });

      console.log(`[REDIS WRITE] ${zoneKey} -> ${stateData.currentState}`);
      console.log(`  avg1m: ${avg1m.toFixed(3)}, avg5m: ${avg5m.toFixed(3)}`);
      console.log(`  GEO: ${latitude}, ${longitude}`);

    } catch (error) {
      console.error(`Failed to write zone state for ${zoneId}:`, error);
      throw error;
    }
  }

  /**
   * Get all zone keys from Redis
   */
  async getAllZoneKeys(): Promise<string[]> {
    try {
      const keys = await this.client.keys('zone:Z-*');
      return keys.sort();
    } catch (error) {
      console.error('Failed to get zone keys:', error);
      return [];
    }
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