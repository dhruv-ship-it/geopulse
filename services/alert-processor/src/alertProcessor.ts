import { RedisClientType } from 'redis';
import { ZoneAlert, ZoneAlertForZoneList } from './types';
import { PostgresClient, ZoneAlertRow } from './postgresClient';
import { logger } from './logger';
import { alertsPersistedTotal, redisAlertWriteLatencyMs, postgresAlertWriteLatencyMs } from './metrics';

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
   * Persist an alert to PostgreSQL (durable) and Redis (recent-alerts cache).
   *
   * Postgres goes first, deliberately. The Postgres write is the one that is allowed to fail
   * the whole message, and a failure means the consumer retries and eventually replays this
   * call. Writing Redis first would LPUSH a duplicate entry onto the recent-alerts lists on
   * every retry. Ordering it second means a retry never duplicates a Redis entry for a write
   * that never became durable.
   *
   * Redis stays best-effort: it is a cache of recent alerts, Postgres is the record.
   */
  async persistAlert(alert: ZoneAlert): Promise<void> {
    await this.persistToPostgres(alert);
    await this.persistToRedis(alert);
  }

  /**
   * Persist alert to Redis (per-zone and global lists)
   */
  private async persistToRedis(alert: ZoneAlert): Promise<void> {
    try {
      const start = Date.now();
      
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

      // Observe latency and increment counter
      redisAlertWriteLatencyMs.observe(Date.now() - start);
      alertsPersistedTotal.labels('redis').inc();

      logger.info({ zoneId: alert.zoneId, previousState: alert.previousState, currentState: alert.currentState, storage: 'redis' }, 'Alert persisted');
    } catch (err) {
      logger.error({ error: err, zoneId: alert.zoneId }, 'Failed to persist alert to Redis');
      // Log error but don't throw - Redis is best-effort for recent alerts
    }
  }

  /**
   * Persist alert to PostgreSQL for durable historical storage
   */
  private async persistToPostgres(alert: ZoneAlert): Promise<void> {
    try {
      const start = Date.now();
      
      const row: ZoneAlertRow = {
        zone_id: alert.zoneId,
        previous_state: alert.previousState,
        current_state: alert.currentState,
        avg1m: alert.avg1m,
        avg5m: alert.avg5m,
        timestamp: alert.timestamp
      };

      await this.postgres.insertAlert(row);
      
      // Observe latency and increment counter
      postgresAlertWriteLatencyMs.observe(Date.now() - start);
      alertsPersistedTotal.labels('postgres').inc();
      
      logger.info({ zoneId: alert.zoneId, storage: 'postgres' }, 'Alert persisted');
    } catch (err) {
      logger.error({ error: err, zoneId: alert.zoneId }, 'Failed to persist alert to PostgreSQL');
      // Rethrow. This propagates out of eachMessage, which is what stops kafkajs committing
      // the offset; the consumer then retries and, if that fails too, dead-letters the
      // message. See messageRecovery.ts.
      throw err;
    }
  }
}
