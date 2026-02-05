import { Counter, Histogram, Registry } from 'prom-client';

// Create service-specific registry
const register = new Registry();

// Counters
export const sensorEventsProcessedTotal = new Counter({
  name: 'sensor_events_processed_total',
  help: 'Total number of sensor events processed',
  labelNames: [],
  registers: [register]
});

export const stateTransitionsTotal = new Counter({
  name: 'state_transitions_total',
  help: 'Total number of state transitions',
  labelNames: ['from_state', 'to_state'],
  registers: [register]
});

export const alertsPublishedTotal = new Counter({
  name: 'alerts_published_total',
  help: 'Total number of alerts published to Kafka',
  labelNames: [],
  registers: [register]
});

// Histograms
export const alertPublishLatencyMs = new Histogram({
  name: 'alert_publish_latency_ms',
  help: 'Time taken to publish alert to Kafka in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

// Export registry
export { register };
