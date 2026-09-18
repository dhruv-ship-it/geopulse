import { Counter, Histogram, Registry } from 'prom-client';

// Create service-specific registry
const register = new Registry();

// Counters
export const alertsConsumedTotal = new Counter({
  name: 'alerts_consumed_total',
  help: 'Total number of alerts consumed from Kafka',
  labelNames: [],
  registers: [register]
});

export const alertsPersistedTotal = new Counter({
  name: 'alerts_persisted_total',
  help: 'Total number of alerts persisted to storage',
  labelNames: ['storage'],
  registers: [register]
});

export const alertsDeadLetteredTotal = new Counter({
  name: 'alerts_dead_lettered_total',
  help: 'Alerts routed to the dead letter queue after recovery was exhausted',
  labelNames: ['reason'],
  registers: [register]
});

export const alertRetriesTotal = new Counter({
  name: 'alert_retries_total',
  help: 'Retry attempts made after a failed alert persistence',
  labelNames: [],
  registers: [register]
});

// Histograms
export const redisAlertWriteLatencyMs = new Histogram({
  name: 'redis_alert_write_latency_ms',
  help: 'Time taken to write alert to Redis in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

export const postgresAlertWriteLatencyMs = new Histogram({
  name: 'postgres_alert_write_latency_ms',
  help: 'Time taken to write alert to PostgreSQL in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

// Export registry
export { register };

// ------------------------------------------------------------------- incidents
//
// The second consumer's metrics. Kept in this registry rather than a separate one because the
// two consumers are one process with one /metrics endpoint, and separating them would mean a
// scrape that could show one half of the service's health.

export const incidentsConsumedTotal = new Counter({
  name: 'incidents_consumed_total',
  help: 'Incident lifecycle events consumed from zone.incidents',
  labelNames: [],
  registers: [register]
});

export const incidentEventsPersistedTotal = new Counter({
  name: 'incident_events_persisted_total',
  help: 'Incident events written to Postgres, by lifecycle event type',
  labelNames: ['event_type'],
  registers: [register]
});

/**
 * Membership rows written, split by direction.
 *
 * Joins without departures is the signature of the recovery path being broken — the same thing
 * `degradations_published_total{direction}` catches one service upstream, visible here as
 * incidents that only ever grow.
 */
export const incidentMemberRowsWrittenTotal = new Counter({
  name: 'incident_member_rows_written_total',
  help: 'incident_members rows written, by direction',
  labelNames: ['direction'],
  registers: [register]
});

export const incidentsDeadLetteredTotal = new Counter({
  name: 'incidents_dead_lettered_total',
  help: 'Incident events routed to the dead letter queue after recovery was exhausted',
  labelNames: ['reason'],
  registers: [register]
});

export const incidentRetriesTotal = new Counter({
  name: 'incident_retries_total',
  help: 'Retry attempts made after a failed incident persistence',
  labelNames: [],
  registers: [register]
});

export const postgresIncidentWriteLatencyMs = new Histogram({
  name: 'postgres_incident_write_latency_ms',
  help: 'Time taken to persist one incident event to PostgreSQL in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});
