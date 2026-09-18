import { RedisClientType } from 'redis';
import { ZoneDegradation, ZoneDegradationForZoneList } from './types';
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
   * Persist a degradation to PostgreSQL (durable) and Redis (recent-history cache).
   *
   * Postgres goes first, deliberately. The Postgres write is the one that is allowed to fail
   * the whole message, and a failure means the consumer retries and eventually replays this
   * call. Writing Redis first would LPUSH a duplicate entry onto the recent lists on every
   * retry. Ordering it second means a retry never duplicates a Redis entry for a write that
   * never became durable.
   *
   * Redis stays best-effort: it is a cache of recent transitions, Postgres is the record.
   */
  async persistAlert(degradation: ZoneDegradation): Promise<void> {
    await this.persistToPostgres(degradation);
    await this.persistToRedis(degradation);
  }

  /**
   * Persist to Redis (per-zone and global lists)
   */
  private async persistToRedis(degradation: ZoneDegradation): Promise<void> {
    try {
      const start = Date.now();

      const zoneKey = `${PER_ZONE_KEY_PREFIX}${degradation.zoneId}`;

      const zoneEntry: ZoneDegradationForZoneList = {
        previousState: degradation.previousState,
        currentState: degradation.currentState,
        severity: degradation.severity,
        avg1m: degradation.avg1m,
        avg5m: degradation.avg5m,
        eventTime: degradation.eventTime
      };

      // Push to per-zone list (newest first) and trim
      await this.redis.lPush(zoneKey, JSON.stringify(zoneEntry));
      await this.redis.lTrim(zoneKey, 0, PER_ZONE_LIMIT - 1);

      // Push to global list with zoneId included
      await this.redis.lPush(GLOBAL_KEY, JSON.stringify(degradation));
      await this.redis.lTrim(GLOBAL_KEY, 0, GLOBAL_LIMIT - 1);

      // Observe latency and increment counter
      redisAlertWriteLatencyMs.observe(Date.now() - start);
      alertsPersistedTotal.labels('redis').inc();

      logger.debug(
        {
          zoneId: degradation.zoneId,
          previousState: degradation.previousState,
          currentState: degradation.currentState,
          storage: 'redis'
        },
        'Degradation persisted'
      );
    } catch (err) {
      logger.error({ error: err, zoneId: degradation.zoneId }, 'Failed to persist degradation to Redis');
      // Log error but don't throw - Redis is best-effort for recent history
    }
  }

  /**
   * Persist to PostgreSQL for durable historical storage.
   *
   * The table is still called `zone_alerts` and its time column is still called `timestamp`.
   * That is a legacy name, flagged for WP7 rather than renamed here: a table rename is a
   * migration plus every query in `api`, and it buys nothing that the topic rename has not
   * already bought. The column it maps from is `eventTime`, and that is the name that matters,
   * because it is the one that says which clock the number came from (ADR-007).
   */
  private async persistToPostgres(degradation: ZoneDegradation): Promise<void> {
    try {
      const start = Date.now();

      const row: ZoneAlertRow = {
        zone_id: degradation.zoneId,
        previous_state: degradation.previousState,
        current_state: degradation.currentState,
        avg1m: degradation.avg1m,
        avg5m: degradation.avg5m,
        timestamp: degradation.eventTime
      };

      await this.postgres.insertAlert(row);

      // Observe latency and increment counter
      postgresAlertWriteLatencyMs.observe(Date.now() - start);
      alertsPersistedTotal.labels('postgres').inc();

      logger.debug({ zoneId: degradation.zoneId, storage: 'postgres' }, 'Degradation persisted');
    } catch (err) {
      logger.error(
        { error: err, zoneId: degradation.zoneId },
        'Failed to persist degradation to PostgreSQL'
      );
      // Rethrow. This propagates out of eachMessage, which is what stops kafkajs committing
      // the offset; the consumer then retries and, if that fails too, dead-letters the
      // message. See @geopulse/kafka-recovery.
      throw err;
    }
  }
}
