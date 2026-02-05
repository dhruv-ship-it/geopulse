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
