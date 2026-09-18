import {
  AdjacencyProvider,
  CorrelationWindow,
  IncidentEvent,
  IncidentLifecycle,
  TimeAwareConnectivity
} from './core';
import { footprintOf } from './footprint';
import { logger } from './logger';
import {
  activeIncidents,
  activeMembers,
  compactionDurationMs,
  connectivityMaxRank,
  connectivityRebuilds,
  connectivityRebuiltMembers,
  correlationLatencyMs,
  degradationBatchSize,
  degradationsConsumedTotal,
  degradationsRejectedTotal,
  degradationsStaleTotal,
  incidentMemberCount,
  incidentsClosedTotal,
  incidentsMergedTotal,
  incidentsOpenedTotal
} from './metrics';
import { IncidentFootprint, IncidentWireEvent, ZoneDegradation } from './types';

/** Placing a zone in the neighbour graph. `ZoneRegistry` satisfies this structurally. */
export interface ZonePlacer {
  observe(degradation: ZoneDegradation): void;
}

export interface CorrelationEngineOptions {
  windowMs: number;
  compactionIntervalMs: number;
  minZones: number;
  closeGraceMs: number;
}

export interface CorrelationEngineStats {
  batches: number;
  degradations: number;
  recoveries: number;
  rejected: number;
  stale: number;
  emitted: number;
  watermark: number;
  window: ReturnType<CorrelationWindow['stats']>;
  connectivity: ReturnType<TimeAwareConnectivity['stats']>;
  incidents: ReturnType<IncidentLifecycle['stats']>;
}

/** What the engine remembers about a zone between batches. Exactly one entry per window member. */
interface ZoneObservation {
  zoneId: string;
  latitude: number;
  longitude: number;
  h3Cell: string;
  h3CoarseCell: string;
  severity: number;
}

/**
 * Per-incident enrichment that the core does not carry, because the core does not know what a
 * kilometre is.
 */
interface IncidentEnrichment {
  /** Fixed at OPEN and never changed. See `coarseCellFor`. */
  h3CoarseCell: string;
  peakSeverity: number;
  /** The last non-empty footprint, kept for the CLOSED event of a dissolved incident. */
  lastFootprint: IncidentFootprint;
  lastSeverity: number;
}

const EMPTY_FOOTPRINT: IncidentFootprint = {
  h3Cells: [],
  centroid: { latitude: 0, longitude: 0 },
  radiusKm: 0
};

/**
 * The whole of WP3's logic, with no I/O in it.
 *
 * `src/core` is the correlation algorithm and is proved against an oracle and a set of
 * invariants. This class is the layer that turns a Kafka batch into calls on it and its answers
 * back into the product's event schema, and it is deliberately still free of Kafka, Redis and
 * HTTP so that a test can push a hand-written batch through the exact code the service runs.
 *
 * ## The fold
 *
 * Per message, in offset order: place the zone, then either admit it to the correlation window
 * (a degradation) or release it (a recovery), mirroring that into the connectivity structure.
 * Once per batch: tick the window — which sweeps on its own event-time cadence — compact the
 * expiries into connectivity, and reconcile the resulting partition into incidents.
 *
 * This is the same call sequence as `src/core/__tests__/support/lifecycleDriver.ts`, which is
 * the sequence 2,500 property-test sequences and 156,773 invariant checks were run against. The
 * one difference is the reconcile cadence: the driver reconciles after *every* event, which is
 * the harshest schedule, and this reconciles once per batch.
 *
 * ## What batching costs, stated plainly
 *
 * Reconciling per batch rather than per message is why `eachBatch` is used at all (see the
 * README), and it is not free. Incident ids are `SHA-256(scheme | openedAt | seed members)`
 * (ADR-003), and `openedAt` is the watermark of the reconcile that opened the incident. A
 * coarser reconcile cadence therefore changes *which* watermark an incident opens at, and can
 * change its seed set — a component that formed and dissolved entirely inside one batch is never
 * seen at all, and one that grew from three to five members inside a batch opens with five. So:
 *
 * - Given a fixed message order **and a fixed batching**, the output is byte-identical. That is
 *   what `correlationEngine.test.ts` asserts, and it is what the eval harness replays.
 * - Two live runs over the same stream can differ in incident ids, because batch boundaries are
 *   a broker fetch artefact. The set of incidents, their membership and their lifecycle do not
 *   differ in kind; the names do.
 *
 * That trade is the right one for a product whose output is meant for a human — one consolidated
 * update per burst beats sixty — and it is stated here rather than discovered later, because
 * "why do the ids differ between runs" is otherwise a genuinely alarming question.
 *
 * ## Event time only
 *
 * The engine holds no clock. Event time advances because messages carry it, which has one
 * consequence worth knowing: on a *completely silent* stream, an incident sitting in `DRAINING`
 * does not close, because nothing has told the engine that its grace period elapsed. That is
 * correct rather than a bug — closing it would require inventing a fact about the world from the
 * local wall clock — and it is invisible in practice, since any other zone's degradation
 * anywhere on the partition moves the watermark.
 */
export class CorrelationEngine {
  private readonly window: CorrelationWindow;
  private readonly connectivity: TimeAwareConnectivity;
  private readonly lifecycle: IncidentLifecycle;

  private readonly observations = new Map<string, ZoneObservation>();
  private readonly enrichment = new Map<string, IncidentEnrichment>();

  private batches = 0;
  private degradations = 0;
  private recoveries = 0;
  private rejected = 0;
  private stale = 0;
  private emitted = 0;

  constructor(
    adjacency: AdjacencyProvider,
    private readonly placer: ZonePlacer,
    private readonly options: CorrelationEngineOptions
  ) {
    this.window = new CorrelationWindow({
      windowMs: options.windowMs,
      compactionIntervalMs: options.compactionIntervalMs
    });
    this.connectivity = new TimeAwareConnectivity(adjacency);
    this.lifecycle = new IncidentLifecycle({
      minZones: options.minZones,
      closeGraceMs: options.closeGraceMs
    });
  }

  /**
   * Fold one batch of degradations in and return the incident events it produced.
   *
   * An empty batch returns nothing and changes nothing: with no message there is no event time,
   * and reconciling at the old watermark would be a no-op anyway.
   */
  applyBatch(messages: readonly ZoneDegradation[]): IncidentWireEvent[] {
    if (messages.length === 0) {
      return [];
    }

    this.batches++;
    degradationBatchSize.observe(messages.length);

    let watermark = this.window.watermark;
    let sawMessage = false;

    for (const message of messages) {
      if (!this.isUsable(message)) {
        continue;
      }
      sawMessage = true;
      watermark = Math.max(watermark, message.eventTime);

      this.placer.observe(message);

      if (message.currentState === 'NORMAL') {
        this.recoveries++;
        degradationsConsumedTotal.labels('recovery').inc();
        // A recovery is a statement about the zone, so it is honoured whenever it arrives. The
        // window drops the member immediately rather than holding an incident open over a zone
        // that has told us it is healthy.
        this.window.release(message.zoneId, message.eventTime);
        this.connectivity.deactivate(message.zoneId);
        this.observations.delete(message.zoneId);
        continue;
      }

      this.degradations++;
      degradationsConsumedTotal.labels('degradation').inc();
      this.rememberObservation(message);
      this.window.admit(message.zoneId, message.eventTime);

      if (this.window.isActive(message.zoneId)) {
        // Deliberately not conditional on admit() having returned true. Re-activating an
        // existing member re-runs its unions, which is how an edge the neighbour graph only
        // learned after the zone first degraded gets picked up (see `Connectivity.activate`).
        this.connectivity.activate(message.zoneId);
      } else {
        // Refused: the whole window this degradation would have opened already lies behind the
        // watermark. Admitting it would mint a component member that was stale on arrival.
        this.stale++;
        degradationsStaleTotal.inc();
        this.observations.delete(message.zoneId);
      }
    }

    if (!sawMessage) {
      return [];
    }

    // The only wall-clock read in the engine, and it decides nothing: it is a stopwatch around
    // the compaction, and its value reaches a histogram and nowhere else. Rule 3 in CLAUDE.md
    // forbids a clock *deciding* anything on this path; `replays byte-identically` in
    // `correlationEngine.test.ts` is the guard that it does not.
    const startedAt = Date.now();
    const expired = this.window.tick(watermark);
    if (expired.length > 0) {
      this.connectivity.compact(expired);
      for (const zoneId of expired) {
        this.observations.delete(zoneId);
      }
    }
    const events = this.lifecycle.reconcile(this.connectivity.components(), watermark);
    compactionDurationMs.observe(Date.now() - startedAt);

    this.syncGauges();

    const wire = events.map((event) => this.toWireEvent(event));
    this.emitted += wire.length;
    return wire;
  }

  /** The incident currently claiming a zone, for diagnostics and for the API to come. */
  incidentOf(zoneId: string): string | undefined {
    return this.lifecycle.incidentOf(zoneId);
  }

  get watermark(): number {
    return this.window.watermark;
  }

  stats(): CorrelationEngineStats {
    return {
      batches: this.batches,
      degradations: this.degradations,
      recoveries: this.recoveries,
      rejected: this.rejected,
      stale: this.stale,
      emitted: this.emitted,
      watermark: this.window.watermark,
      window: this.window.stats(),
      connectivity: this.connectivity.stats(),
      incidents: this.lifecycle.stats()
    };
  }

  /**
   * A message that cannot be used is skipped and counted, not retried and not dead-lettered.
   *
   * This is a different call from the one `alert-processor` makes (ADR-000), and deliberately so.
   * There, a lost alert is a lost fact — nothing else in the system carries it — so the cost of
   * dropping one justifies retry, a DLQ and the offset discipline around both. Here, a
   * degradation is one sample of a signal that is re-sampled every second: a zone that is
   * genuinely degrading says so again almost immediately, and a malformed message that stalls
   * the partition costs every *other* zone's correlation for as long as it sits there. Skipping
   * is the cheaper failure. `degradations_rejected_total` is what makes it visible; a rate that
   * is anything but zero means a producer is emitting garbage, and that is a bug to fix at the
   * producer rather than to absorb here.
   */
  private isUsable(message: ZoneDegradation): boolean {
    const reason = rejectionReason(message);
    if (reason === null) {
      return true;
    }
    this.rejected++;
    degradationsRejectedTotal.labels(reason).inc();
    logger.warn({ reason, message }, 'Skipping unusable degradation');
    return false;
  }

  private rememberObservation(message: ZoneDegradation): void {
    this.observations.set(message.zoneId, {
      zoneId: message.zoneId,
      latitude: message.latitude,
      longitude: message.longitude,
      h3Cell: message.h3Cell,
      h3CoarseCell: message.h3CoarseCell,
      severity: message.severity
    });
  }

  private toWireEvent(event: IncidentEvent): IncidentWireEvent {
    const positions: ZoneObservation[] = [];
    let severity = 0;
    for (const zoneId of event.members) {
      const observation = this.observations.get(zoneId);
      if (observation === undefined) {
        continue;
      }
      positions.push(observation);
      severity = Math.max(severity, observation.severity);
    }

    const enrichment = this.enrichmentFor(event, positions);
    const footprint = positions.length > 0 ? footprintOf(positions) : enrichment.lastFootprint;

    if (positions.length > 0) {
      enrichment.lastFootprint = footprint;
      enrichment.lastSeverity = severity;
      enrichment.peakSeverity = Math.max(enrichment.peakSeverity, severity);
    } else {
      // A dissolved incident's members are all gone, so there is nothing left to measure. The
      // last thing we knew is the truest thing available, and it is more useful to a consumer
      // drawing a timeline than a zeroed footprint at latitude 0.
      severity = enrichment.lastSeverity;
    }

    this.recordEventMetrics(event);

    const closed = event.type === 'CLOSED';
    const wire: IncidentWireEvent = {
      incidentId: event.incidentId,
      eventType: event.type,
      status: closed ? 'CLOSED' : 'OPEN',
      lifecycleStatus: event.status,
      memberZones: event.members,
      memberCount: event.memberCount,
      peakSeverity: enrichment.peakSeverity,
      severity,
      footprint,
      // WP4. Emitting a best-fit vector from two members with the same join time would be a
      // number nobody should act on, and the spec is explicit that refusing to report one is the
      // quality signal. Null until the regression exists.
      propagation: null,
      mergedFrom: event.mergedFrom ?? null,
      supersededBy: event.supersededBy ?? null,
      splitFrom: event.splitFrom ?? null,
      closeReason: event.closeReason ?? null,
      openedAt: event.openedAt,
      updatedAt: event.eventTime,
      closedAt: closed ? event.eventTime : null,
      h3CoarseCell: enrichment.h3CoarseCell
    };

    if (closed) {
      this.enrichment.delete(event.incidentId);
    }
    return wire;
  }

  private enrichmentFor(event: IncidentEvent, positions: readonly ZoneObservation[]): IncidentEnrichment {
    const existing = this.enrichment.get(event.incidentId);
    if (existing !== undefined) {
      return existing;
    }
    const created: IncidentEnrichment = {
      h3CoarseCell: this.coarseCellFor(event, positions),
      peakSeverity: 0,
      lastFootprint: EMPTY_FOOTPRINT,
      lastSeverity: 0
    };
    this.enrichment.set(event.incidentId, created);
    return created;
  }

  /**
   * The partition key for every event this incident will ever emit, fixed at its first event.
   *
   * It has to be fixed. `zone.incidents` is keyed by coarse cell so that a consumer rebuilding
   * one region's state reads one partition; if the key moved as an incident grew across a cell
   * boundary, that incident's own events would scatter across partitions and lose their
   * ordering relative to each other, which is the one guarantee a lifecycle stream needs.
   *
   * The choice of *which* cell is the lexicographically smallest among the members present at
   * the incident's first event — a rule, so that it is reproducible, rather than "whichever
   * member happened to be first". An incident straddling two coarse cells is therefore filed
   * under one of them. That is the boundary limitation `01-ARCHITECTURE.md` §6 names and defers:
   * the fix is the two-level scheme, where a local incident touching its cell boundary is
   * republished under the parent cell for a second correlation stage to merge.
   *
   * Empty only if every member's observation has already been pruned, which cannot happen at an
   * incident's first event — the first event always has live members.
   */
  private coarseCellFor(event: IncidentEvent, positions: readonly ZoneObservation[]): string {
    let smallest = '';
    for (const position of positions) {
      if (position.h3CoarseCell && (smallest === '' || position.h3CoarseCell < smallest)) {
        smallest = position.h3CoarseCell;
      }
    }
    if (smallest === '') {
      logger.warn(
        { incidentId: event.incidentId, type: event.type },
        'Incident has no coarse cell among its members; keying by incident id instead'
      );
      return event.incidentId;
    }
    return smallest;
  }

  private recordEventMetrics(event: IncidentEvent): void {
    incidentMemberCount.observe(event.memberCount);

    switch (event.type) {
      case 'OPENED':
        incidentsOpenedTotal.labels(event.splitFrom === undefined ? 'component' : 'split').inc();
        break;
      case 'MERGED':
        incidentsMergedTotal.inc();
        break;
      case 'CLOSED':
        incidentsClosedTotal.labels(event.closeReason ?? 'UNKNOWN').inc();
        break;
      default:
        break;
    }

    // Event-time on both ends: how long after a zone started degrading it was reported as part
    // of something. See the note on the metric itself for why this is not a wall-clock reading.
    for (const zoneId of event.added) {
      const member = this.window.memberOf(zoneId);
      if (member !== undefined) {
        correlationLatencyMs.observe(Math.max(0, event.eventTime - member.firstDegradedAt));
      }
    }
  }

  private syncGauges(): void {
    const connectivity = this.connectivity.stats();
    activeMembers.set(this.window.size);
    activeIncidents.set(this.lifecycle.size);
    connectivityRebuilds.set(connectivity.rebuilds);
    connectivityRebuiltMembers.set(connectivity.rebuiltMembers);
    connectivityMaxRank.set(connectivity.maxRank);
  }
}

/** Why a message is unusable, or null if it is fine. Exported so the tests can pin the reasons. */
export function rejectionReason(message: unknown): string | null {
  if (message === null || typeof message !== 'object') {
    return 'not-an-object';
  }
  const candidate = message as Partial<ZoneDegradation>;

  if (typeof candidate.zoneId !== 'string' || candidate.zoneId.length === 0) {
    return 'missing-zone-id';
  }
  if (!Number.isFinite(candidate.eventTime)) {
    return 'missing-event-time';
  }
  if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) {
    return 'missing-position';
  }
  if (
    Math.abs(candidate.latitude as number) > 90 ||
    Math.abs(candidate.longitude as number) > 180
  ) {
    return 'position-out-of-range';
  }
  if (
    candidate.currentState !== 'NORMAL' &&
    candidate.currentState !== 'STRESSED' &&
    candidate.currentState !== 'CRITICAL'
  ) {
    return 'unknown-state';
  }
  if (!Number.isFinite(candidate.severity)) {
    return 'missing-severity';
  }
  return null;
}
