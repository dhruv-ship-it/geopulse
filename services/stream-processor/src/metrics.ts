import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// Create service-specific registry
const register = new Registry();

// Counters
export const sensorEventsProcessedTotal = new Counter({
  name: 'sensor_events_processed_total',
  help: 'Total number of sensor events processed',
  labelNames: [],
  registers: [register]
});

/**
 * Sensor events this service gave up on and discarded, by reason.
 *
 * The metric that makes the `'drop'` failure policy defensible rather than a re-run of defect
 * D1. Dropping a re-sampled signal is a considered trade (see `kafkaConsumer.ts` and ADR-000's
 * amendment); dropping it *invisibly* is the bug. A non-zero rate here means something
 * downstream of the fold is failing persistently, and it is readable from the metrics endpoint
 * rather than inferrable from the absence of alerts — which is exactly how D10 stayed hidden.
 */
export const sensorEventsDroppedTotal = new Counter({
  name: 'sensor_events_dropped_total',
  help: 'Sensor events discarded after in-process recovery was exhausted, by reason',
  labelNames: ['reason'],
  registers: [register]
});

export const sensorEventRetriesTotal = new Counter({
  name: 'sensor_event_retries_total',
  help: 'Retry attempts made after a failed sensor event handler',
  labelNames: [],
  registers: [register]
});

export const stateTransitionsTotal = new Counter({
  name: 'state_transitions_total',
  help: 'Total number of state transitions',
  labelNames: ['from_state', 'to_state'],
  registers: [register]
});

/**
 * Degradations published, split by direction.
 *
 * `degradation` and `recovery` are counted apart because they answer different questions and
 * because their ratio is the one number that says whether the recovery path is working at all.
 * A run that publishes 62 degradations and 0 recoveries looks healthy on a total-only counter
 * and means every incident in the system will be held open for a full correlation window past
 * the end of the fault.
 */
export const degradationsPublishedTotal = new Counter({
  name: 'degradations_published_total',
  help: 'Degradation observations published to zone.degradations, by direction',
  labelNames: ['direction'],
  registers: [register]
});

export const degradationsDeadLetteredTotal = new Counter({
  name: 'degradations_dead_lettered_total',
  help: 'Degradations routed to the dead letter queue after publish retries were exhausted',
  labelNames: [],
  registers: [register]
});

// Histograms
export const degradationPublishLatencyMs = new Histogram({
  name: 'degradation_publish_latency_ms',
  help: 'Time taken to publish a degradation to Kafka in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

// Export registry
export { register };

export const zonesTrackedGauge = new Gauge({
  name: 'zones_tracked',
  help: 'Zones currently held in the in-memory state store',
  labelNames: [],
  registers: [register]
});

export const zonesEvictedTotal = new Counter({
  name: 'zones_evicted_total',
  help: 'Zones whose in-memory state was evicted after going idle',
  labelNames: [],
  registers: [register]
});
