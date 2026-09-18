import { Counter, Gauge, Histogram, Registry } from 'prom-client';

// Create service-specific registry
const register = new Registry();

// --- the WP3 §7 set --------------------------------------------------------------------------

export const incidentsOpenedTotal = new Counter({
  name: 'incidents_opened_total',
  help: 'Incidents opened. Labelled by origin: a fresh component, or a fragment of a split',
  labelNames: ['origin'],
  registers: [register]
});

export const incidentsMergedTotal = new Counter({
  name: 'incidents_merged_total',
  help: 'Merge events emitted — one per surviving incident that absorbed at least one other',
  labelNames: [],
  registers: [register]
});

export const incidentsClosedTotal = new Counter({
  name: 'incidents_closed_total',
  help: 'Incidents closed, by reason: SUPERSEDED, DISSOLVED or GRACE_EXPIRED',
  labelNames: ['reason'],
  registers: [register]
});

/**
 * Member count at the moment of each emitted incident event. The distribution is the project's
 * headline claim in histogram form: if the bulk of incidents sit at 1-2 members then nothing has
 * been collapsed and the thesis is false.
 */
export const incidentMemberCount = new Histogram({
  name: 'incident_member_count',
  help: 'Member zones per incident, sampled on every emitted incident event',
  labelNames: [],
  buckets: [1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  registers: [register]
});

/**
 * Event-time elapsed between a zone first degrading and the incident event that reports it as a
 * member — measured entirely in event time, on both ends.
 *
 * It is deliberately **not** `Date.now() - degradation.eventTime`. That subtraction mixes two
 * clocks, and mixing them is exactly the mistake that cost this project defect D10 (ADR-007):
 * the simulator produces at a fixed historical epoch, so a wall-clock-minus-event-time reading
 * would report about 245 days and be taken seriously by nobody. It is also not what the question
 * is about. "How long after a zone started degrading did we say it was part of something?" is a
 * property of the correlation geometry — window length, minimum size, compaction cadence — and
 * it composes with the 256 s detection floor the state machine already costs (WP6a). Wall-clock
 * processing cost is a different question, answered by `compaction_duration_ms` and by the
 * consumer lag the broker already reports.
 */
export const correlationLatencyMs = new Histogram({
  name: 'correlation_latency_ms',
  help: 'Event-time ms from a zone first degrading to the incident event that adds it',
  labelNames: [],
  buckets: [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000],
  registers: [register]
});

export const activeIncidents = new Gauge({
  name: 'active_incidents',
  help: 'Incidents currently live, OPEN and DRAINING together',
  labelNames: [],
  registers: [register]
});

export const activeMembers = new Gauge({
  name: 'active_members',
  help: 'Zones currently inside the correlation window',
  labelNames: [],
  registers: [register]
});

/**
 * Wall clock, and legitimately so: this is a *duration* of work done in one process, not a
 * comparison between two clocks. It is the number that decides whether the linear sweep in
 * `CorrelationWindow.sweep` ever needs to become a deadline-ordered heap.
 */
export const compactionDurationMs = new Histogram({
  name: 'compaction_duration_ms',
  help: 'Wall-clock ms to sweep the correlation window, compact connectivity and reconcile',
  labelNames: [],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250],
  registers: [register]
});

// --- what the above cannot answer ------------------------------------------------------------
//
// Each of these exists because a specific claim in the docs would otherwise be unfalsifiable in
// production. They are not padding: the rule in CLAUDE.md is that a dependency (or a metric)
// earns its place with a stated reason, and the reason is on each one.

export const degradationsConsumedTotal = new Counter({
  name: 'degradations_consumed_total',
  help: 'Messages consumed from zone.degradations, split by degradation vs recovery',
  labelNames: ['kind'],
  registers: [register]
});

/**
 * The denominator of the headline metric. Degradations in, incident events out — the ratio
 * between this counter and `incident_events_published_total` is the collapse factor the whole
 * project is about, computed live rather than at analysis time.
 */
export const incidentEventsPublishedTotal = new Counter({
  name: 'incident_events_published_total',
  help: 'Incident lifecycle events published to zone.incidents, by type',
  labelNames: ['type'],
  registers: [register]
});

/**
 * The metric that changed a design decision, and the reason this file is full of comments like
 * this one.
 *
 * It was added to falsify a claim: the README argued that a regional event arrives as a burst and
 * that `eachBatch` therefore consolidates it, and this histogram was the check — *if it sits at 1
 * during a storm, the claim is false and the complexity is not being paid for.*
 *
 * It sat at 1. The first end-to-end run measured 70 messages across 68 batches, because
 * degradations are rare and the pipeline keeps up. Reconciling per batch had quietly become
 * reconciling per message exactly when the system was healthy. The lifecycle now reconciles on an
 * event-time grid instead (ADR-004 amendment), which consolidates the same way whether the
 * consumer is caught up or behind — and this histogram stays, because it is still the honest
 * answer to "how much does a batch actually contain".
 */
export const degradationBatchSize = new Histogram({
  name: 'degradation_batch_size',
  help: 'Messages per eachBatch call',
  labelNames: [],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

/**
 * Degradations the correlation window refused because their whole window already lay behind the
 * watermark. Non-zero means data is arriving more than CORRELATION_WINDOW_MS late, which is a
 * pipeline problem wearing a correlation problem's clothes.
 */
export const degradationsStaleTotal = new Counter({
  name: 'degradations_stale_total',
  help: 'Degradations refused by the correlation window as older than the window itself',
  labelNames: [],
  registers: [register]
});

export const degradationsRejectedTotal = new Counter({
  name: 'degradations_rejected_total',
  help: 'Messages skipped as unusable, by reason',
  labelNames: ['reason'],
  registers: [register]
});

export const zonesKnown = new Gauge({
  name: 'zones_known',
  help: 'Zones in the neighbour graph, from the registry and from runtime discovery',
  labelNames: [],
  registers: [register]
});

/**
 * ADR-002 rests on an assumption it states plainly: components are small relative to the active
 * set, so tearing one down and rebuilding it by BFS on expiry is cheap. These three are the
 * instruments that keep that assumption measurable rather than asserted — `rebuiltMembers /
 * rebuilds` is the average component size being paid for on the expiry path, and `maxRank` must
 * stay near log2(members) or union by rank has stopped working.
 *
 * Gauges rather than counters because the core owns the underlying totals; this process mirrors
 * them on each batch rather than double-counting them here.
 */
export const connectivityRebuilds = new Gauge({
  name: 'connectivity_rebuilds',
  help: 'Component rebuilds run since startup (mirrored from the core)',
  labelNames: [],
  registers: [register]
});

export const connectivityRebuiltMembers = new Gauge({
  name: 'connectivity_rebuilt_members',
  help: 'Members visited by rebuild BFS since startup (mirrored from the core)',
  labelNames: [],
  registers: [register]
});

export const connectivityMaxRank = new Gauge({
  name: 'connectivity_max_rank',
  help: 'Highest union-find rank among roots — the bound on how far a find can walk',
  labelNames: [],
  registers: [register]
});

export const redisIncidentWriteLatencyMs = new Histogram({
  name: 'redis_incident_write_latency_ms',
  help: 'Time taken to write an incident batch to Redis in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

export const incidentPublishLatencyMs = new Histogram({
  name: 'incident_publish_latency_ms',
  help: 'Time taken to publish an incident batch to Kafka in milliseconds',
  labelNames: [],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register]
});

// Export registry
export { register };

/**
 * Reconcile boundaries crossed, and boundaries the fast-forward skipped.
 *
 * The grid reconciles at every multiple of `RECONCILE_TICK_MS` a batch spans, which over a quiet
 * four-hour replay would be 2,880 reconciles of an empty window. When the window is empty *and*
 * no incident is live, a reconcile is provably a no-op and the grid jumps straight to the
 * boundary before the next message.
 *
 * Both halves are counted because an optimisation whose whole claim is "this has no observable
 * effect" should be the one thing in the system you can observe. A `skipped` count that climbs
 * while incidents are open would mean the precondition is wrong and lifecycle events are being
 * silently dropped.
 */
export const reconcileTicksTotal = new Counter({
  name: 'reconcile_ticks_total',
  help: 'Event-time grid boundaries actually reconciled',
  labelNames: [],
  registers: [register]
});

export const reconcileTicksSkippedTotal = new Counter({
  name: 'reconcile_ticks_skipped_total',
  help: 'Grid boundaries skipped by the empty-state fast-forward',
  labelNames: [],
  registers: [register]
});
