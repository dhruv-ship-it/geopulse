/**
 * Every knob this service reads from the environment, resolved once, in one place.
 *
 * Config is read here rather than at the point of use for two reasons. The engine's behaviour
 * is a function of these numbers — `CORRELATION_WINDOW_MS` and `INCIDENT_MIN_ZONES` decide
 * whether the project's central claim is true or false — so a benchmark has to be able to log
 * exactly what it ran with, and `describeConfig` exists to be printed at startup and pasted
 * into `benchmarks/results/`. And a module that reads `process.env` at import time is a module
 * that cannot be tested at two different settings in one jest run.
 *
 * The three core modules keep their own env defaults (`CORRELATION_WINDOW_MS` and friends are
 * also read in `src/core`) because the core must stand alone for the property tests. This
 * service always passes its resolved values in explicitly, so the core's defaults never apply
 * in production and the two cannot drift apart unnoticed.
 */

export interface CorrelationEngineConfig {
  kafkaBroker: string;
  degradationsTopic: string;
  incidentsTopic: string;
  consumerGroup: string;
  /**
   * Whether to read the degradations topic from its start. True mirrors the other services and
   * is what the eval harness wants — a run is reproducible only if it sees the same messages.
   * False is what a long-lived deployment wants, since replaying months of degradations through
   * a 120-second window re-derives and re-publishes every incident that ever happened.
   */
  fromBeginning: boolean;
  /** Upper bound on messages kafkajs hands to one `eachBatch` call. See the README on batching. */
  maxBatchSize: number;

  redisHost: string;
  redisPort: string;
  redisPassword: string;

  /** How long a zone stays an active member after its most recent degradation. */
  correlationWindowMs: number;
  /** Event-time cadence on which the window sweeps. */
  compactionIntervalMs: number;
  /**
   * Event-time grid the lifecycle reconciles on. Defaults to `compactionIntervalMs`.
   *
   * This is the resolution at which the system is willing to describe change, and it is what
   * makes incident ids independent of Kafka batching: `openedAt` is in the id preimage (ADR-003)
   * and now always lands on a multiple of this. Raising it consolidates more aggressively and
   * loses components that form and dissolve inside one tick; lowering it does the reverse.
   * Changing it changes every incident id and invalidates measured numbers taken before it.
   */
  reconcileTickMs: number;
  /** Members a component needs before it is an incident at all. */
  incidentMinZones: number;
  /** How long an incident may sit below the minimum before it closes. */
  incidentCloseGraceMs: number;

  /** How often to re-read `zones:registry` for zones discovered since startup. */
  zoneRefreshIntervalMs: number;
  /** TTL applied to `incident:<id>` once the incident closes. 0 disables expiry. */
  closedIncidentTtlSeconds: number;

  metricsPort: number;
}

/** The compaction interval when it is a usable cadence, and the standalone default when not. */
function reconcileDefault(env: NodeJS.ProcessEnv): number {
  const compaction = intFromEnv(env, 'COMPACTION_INTERVAL_MS', 5000);
  return compaction > 0 ? compaction : 5000;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CorrelationEngineConfig {
  const config: CorrelationEngineConfig = {
    kafkaBroker: env.KAFKA_BROKER || 'localhost:9092',
    degradationsTopic: env.DEGRADATIONS_TOPIC || 'zone.degradations',
    incidentsTopic: env.INCIDENTS_TOPIC || 'zone.incidents',
    consumerGroup: env.CORRELATION_CONSUMER_GROUP || 'correlation-engine',
    fromBeginning: boolFromEnv(env, 'CORRELATION_FROM_BEGINNING', true),
    maxBatchSize: intFromEnv(env, 'CORRELATION_MAX_BATCH_SIZE', 1000),

    redisHost: env.REDIS_HOST || 'localhost',
    redisPort: env.REDIS_PORT || '6390',
    redisPassword: env.REDIS_PASSWORD || 'geopulse-dev',

    correlationWindowMs: intFromEnv(env, 'CORRELATION_WINDOW_MS', 120000),
    compactionIntervalMs: intFromEnv(env, 'COMPACTION_INTERVAL_MS', 5000),
    // Defaults to the compaction interval, except that a compaction interval of 0 is a legal
    // and meaningful setting — "sweep on every batch, exact expiry" — and is not a statement
    // about how often to *announce* anything. A grid of 0 would not be a cadence at all, so the
    // standalone default applies there.
    reconcileTickMs: intFromEnv(env, 'RECONCILE_TICK_MS', reconcileDefault(env)),
    incidentMinZones: intFromEnv(env, 'INCIDENT_MIN_ZONES', 3),
    incidentCloseGraceMs: intFromEnv(env, 'INCIDENT_CLOSE_GRACE_MS', 60000),

    zoneRefreshIntervalMs: intFromEnv(env, 'ZONE_REFRESH_INTERVAL_MS', 60000),
    closedIncidentTtlSeconds: intFromEnv(env, 'CLOSED_INCIDENT_TTL_SECONDS', 3600),

    metricsPort: intFromEnv(env, 'METRICS_PORT', 9093)
  };
  validate(config);
  return config;
}

function validate(config: CorrelationEngineConfig): void {
  if (config.correlationWindowMs <= 0) {
    throw new Error(`CORRELATION_WINDOW_MS must be positive, got ${config.correlationWindowMs}`);
  }
  if (config.compactionIntervalMs < 0) {
    throw new Error(
      `COMPACTION_INTERVAL_MS must be non-negative, got ${config.compactionIntervalMs}`
    );
  }
  // The window is swept on the compaction cadence, so a member can outlive its deadline by up
  // to one interval. An interval at or above the window makes that slop the same size as the
  // thing being measured, and the correlation window stops meaning what its name says.
  if (config.compactionIntervalMs >= config.correlationWindowMs) {
    throw new Error(
      `COMPACTION_INTERVAL_MS (${config.compactionIntervalMs}) must be below ` +
        `CORRELATION_WINDOW_MS (${config.correlationWindowMs})`
    );
  }
  if (config.reconcileTickMs <= 0) {
    throw new Error(`RECONCILE_TICK_MS must be positive, got ${config.reconcileTickMs}`);
  }
  // Same argument as the compaction interval, one level up: a reconcile grid as coarse as the
  // window means an incident can be born and expire without ever being described.
  if (config.reconcileTickMs >= config.correlationWindowMs) {
    throw new Error(
      `RECONCILE_TICK_MS (${config.reconcileTickMs}) must be below ` +
        `CORRELATION_WINDOW_MS (${config.correlationWindowMs})`
    );
  }
  if (config.incidentMinZones < 1) {
    throw new Error(`INCIDENT_MIN_ZONES must be at least 1, got ${config.incidentMinZones}`);
  }
  if (config.incidentCloseGraceMs < 0) {
    throw new Error(
      `INCIDENT_CLOSE_GRACE_MS must be non-negative, got ${config.incidentCloseGraceMs}`
    );
  }
  if (config.maxBatchSize < 1) {
    throw new Error(`CORRELATION_MAX_BATCH_SIZE must be at least 1, got ${config.maxBatchSize}`);
  }
  if (config.zoneRefreshIntervalMs < 0) {
    throw new Error(
      `ZONE_REFRESH_INTERVAL_MS must be non-negative, got ${config.zoneRefreshIntervalMs}`
    );
  }
  if (config.closedIncidentTtlSeconds < 0) {
    throw new Error(
      `CLOSED_INCIDENT_TTL_SECONDS must be non-negative, got ${config.closedIncidentTtlSeconds}`
    );
  }
}

/**
 * The correlation geometry, as one line, for the startup log and for benchmark headers. Rule 1
 * in `CLAUDE.md`: a number that could reach the resume has to be traceable to the configuration
 * that produced it, and the cheapest way to guarantee that is to print it next to the number.
 */
export function describeConfig(config: CorrelationEngineConfig): string {
  return (
    `window=${config.correlationWindowMs}ms compaction=${config.compactionIntervalMs}ms ` +
    `reconcileTick=${config.reconcileTickMs}ms ` +
    `minZones=${config.incidentMinZones} closeGrace=${config.incidentCloseGraceMs}ms ` +
    `maxBatch=${config.maxBatchSize}`
  );
}
