import { RedisClientType } from 'redis';
import { ZoneAlert, ZoneAlertForZoneList } from './types';
import { PostgresClient, ZoneAlertRow } from './postgresClient';

const PER_ZONE_KEY_PREFIX = 'alerts:zone:';
const GLOBAL_KEY = 'alerts:global';
const PER_ZONE_LIMIT = parseInt(process.env.ALERT_HISTORY_LIMIT || '100', 10);
const GLOBAL_LIMIT = parseInt(process.env.ALERT_GLOBAL_LIMIT || '1000', 10);

export class AlertProcessor {
  private redis: RedisClientType;
  private postgres: PostgresClient;

  constructor(redisClient: RedisClientType, postgresClient: PostgresClient) {
    this.redis = redisClient;
    this.postgres = postgresClient;
  }

  /**
   * Persist alert into Redis (Phase 4) and PostgreSQL (Phase 5)
   * Dual-write pattern: both writes happen independently
   */
  async persistAlert(alert: ZoneAlert): Promise<void> {
    // Phase 4: Persist to Redis (unchanged behavior)
    await this.persistToRedis(alert);

    // Phase 5: Persist to PostgreSQL for historical analytics
    await this.persistToPostgres(alert);
  }

  /**
   * Persist alert to Redis (per-zone and global lists)
   */
  private async persistToRedis(alert: ZoneAlert): Promise<void> {
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

      console.log(`✅ Persisted alert to Redis for ${alert.zoneId} (prev=${alert.previousState} -> cur=${alert.currentState})`);
    } catch (err) {
      console.error('❌ Failed to persist alert to Redis:', err);
      // Log error but don't throw - Redis is best-effort for recent alerts
    }
  }

  /**
   * Persist alert to PostgreSQL for durable historical storage
   */
  private async persistToPostgres(alert: ZoneAlert): Promise<void> {
    try {
      const row: ZoneAlertRow = {
        zone_id: alert.zoneId,
        previous_state: alert.previousState,
        current_state: alert.currentState,
        avg1m: alert.avg1m,
        avg5m: alert.avg5m,
        timestamp: alert.timestamp
      };

      await this.postgres.insertAlert(row);
      console.log(`✅ Persisted alert to PostgreSQL for ${alert.zoneId}`);
    } catch (err) {
      console.error('❌ Failed to persist alert to PostgreSQL:', err);
      throw err; // Fail loudly for PostgreSQL - this is for compliance/audit
    }
  }
}
