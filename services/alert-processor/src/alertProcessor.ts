import { RedisClientType } from 'redis';
import { ZoneAlert, ZoneAlertForZoneList } from './types';

const PER_ZONE_KEY_PREFIX = 'alerts:zone:';
const GLOBAL_KEY = 'alerts:global';
const PER_ZONE_LIMIT = parseInt(process.env.ALERT_HISTORY_LIMIT || '100', 10);
const GLOBAL_LIMIT = parseInt(process.env.ALERT_GLOBAL_LIMIT || '1000', 10);

export class AlertProcessor {
  private redis: RedisClientType;

  constructor(redisClient: RedisClientType) {
    this.redis = redisClient;
  }

  /**
   * Persist alert into per-zone and global lists (LPUSH + LTRIM)
   */
  async persistAlert(alert: ZoneAlert): Promise<void> {
    try {
      const zoneKey = `${PER_ZONE_KEY_PREFIX}${alert.zoneId}`;

      const zoneEntry: ZoneAlertForZoneList = {
        previousState: alert.previousState,
        currentState: alert.currentState,
        avg1m: alert.avg1m,
        avg5m: alert.avg5m,
        timestamp: alert.timestamp
      };

      // Push to per-zone list (newest first) and trim
      await this.redis.lPush(zoneKey, JSON.stringify(zoneEntry));
      await this.redis.lTrim(zoneKey, 0, PER_ZONE_LIMIT - 1);

      // Push to global list with zoneId included
      await this.redis.lPush(GLOBAL_KEY, JSON.stringify(alert));
      await this.redis.lTrim(GLOBAL_KEY, 0, GLOBAL_LIMIT - 1);

      console.log(`✅ Persisted alert for ${alert.zoneId} (prev=${alert.previousState} -> cur=${alert.currentState})`);
    } catch (err) {
      console.error('❌ Failed to persist alert to Redis:', err);
    }
  }
}
