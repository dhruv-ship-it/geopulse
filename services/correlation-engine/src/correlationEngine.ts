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
  reconcileTicksSkippedTotal,
  reconcileTicksTotal,
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
  /**
   * Event-time grid the lifecycle reconciles on. Defaults to `compactionIntervalMs`, which is
   * what `config.ts` has always claimed this cadence is. See `applyBatch`.
   */
  reconcileTickMs?: number;
}

export interface CorrelationEngineStats {
  batches: number;
  /** Reconciles run, which is a count of event-time ticks crossed, not of batches. */
  ticks: number;
  /** Ticks fast-forwarded because there was provably nothing to reconcile. See `applyBatch`. */
  ticksSkipped: number;
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
 * Then, whenever the message stream crosses a boundary of the reconcile grid: tick the window,
 * compact the expiries into connectivity, and reconcile the resulting partition into incidents.
 *
 * This is the same call sequence as `src/core/__tests__/support/lifecycleDriver.ts`, which is
 * the sequence 2,500 property-test sequences and 156,773 invariant checks were run against. The
 * one difference is the reconcile cadence: the driver reconciles after *every* event, which is
 * the harshest schedule, and this reconciles on a fixed event-time grid.
 *
 * ## The reconcile grid, and the two things it fixes
 *
 * Reconciles happen at multiples of `reconcileTickMs` of **event time** — not once per Kafka
 * batch, which is what this did until the first end-to-end run. A boundary `B` is reconciled
 * when the first message with `eventTime > B` arrives, so it sees exactly the messages at or
 * before `B` and no others, whatever the broker did with fetch sizes.
 *
 * **It removes a caveat on determinism.** Incident ids are `SHA-256(scheme | openedAt | seed
 * members)` (ADR-003), and `openedAt` is the watermark of the reconcile that opened the incident.
 * Under a per-batch cadence that watermark was wherever Kafka happened to draw a batch boundary,
 * so two live runs over the same stream could name the same incident differently — output was
 * byte-identical only for a *fixed batching*, which is not a property of the data. On the grid,
 * `openedAt` is always a multiple of `reconcileTickMs` and the id is a function of the message
 * stream alone. `CLAUDE.md` rule 3 treats determinism as load-bearing, and this is what it costs
 * to actually have it.
 *
 * **It also delivers the consolidation `eachBatch` was chosen for, which the per-batch cadence
 * did not.** The argument for batching (ADR-004, and the README) is that a regional fault is a
 * burst of sixty-two degradations and should produce one `OPENED` with sixty-two members rather
 * than an `OPENED` and sixty-one `GREW`s. That argument silently assumed the consumer was
 * *behind*. Measured on the live stack it is not: the first end-to-end run reported **70 messages
 * across 68 batches** — about one message per batch — because degradations are rare enough that
 * kafkajs hands them over as they arrive. Per-batch reconciling therefore degenerated to
 * per-message reconciling exactly when the system was healthy, and consolidated unboundedly only
 * when it was lagging. A fixed event-time grid consolidates the same way in both cases.
 *
 * What the grid costs is that a component forming and dissolving entirely inside one tick is
 * never seen. That is the same trade as before, but now it is a stated interval rather than a
 * broker artefact: `reconcileTickMs` is the resolution at which this system is willing to
 * describe change, and at 5 s against a 120 s window it is two orders of magnitude finer than
 * the thing being measured.
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

  private readonly reconcileTickMs: number;

  /**
   * The next grid boundary that can be reconciled, or null before the first message.
   *
   * Always a multiple of `reconcileTickMs`, and advanced only by message event times — never by
   * a batch boundary and never by a clock. This one field is what makes incident ids a function
   * of the stream rather than of the broker's fetch behaviour.
   */
  private pendingTickAt: number | null = null;

  /**
   * Whether any message has been folded since the last reconcile.
   *
   * Makes `flush()` idempotent: with nothing folded there is nothing to close, so a second flush
   * does not invent another tick's worth of event time. Without this, repeated flushes on a quiet
   * stream would march the watermark forward on their own — a clock by the back door, which is
   * exactly what rule 3 forbids.
   */
  private foldedSinceTick = false;

  private batches = 0;
  private ticks = 0;
  private ticksSkipped = 0;
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

    // Defaults to the compaction cadence, which is what `config.ts` has always described this
    // number as: "the event-time cadence on which the window sweeps and the lifecycle
    // reconciles". Only the first half of that was ever true. Separable via RECONCILE_TICK_MS
    // because a deployment might want to sweep more often than it announces, but one knob is the
    // honest default for two halves of the same decision.
    this.reconcileTickMs = options.reconcileTickMs ?? options.compactionIntervalMs;
    if (!Number.isFinite(this.reconcileTickMs) || this.reconcileTickMs <= 0) {
      throw new Error(`reconcileTickMs must be positive, got ${this.reconcileTickMs}`);
    }
  }

  /**
   * Fold one batch of degradations in and return the incident events the grid boundaries it
   * crossed produced.
   *
   * An empty batch returns nothing and changes nothing: with no message there is no event time,
   * so nothing can have crossed a boundary.
   *
   * Note what this deliberately does **not** do: reconcile at the end. A batch that arrives
   * entirely inside one tick produces no events at all, and its effects are announced by whichever
   * later batch carries the stream past the boundary. That is the whole point — the output is a
   * function of the messages, not of where the fetch happened to stop.
   */
  applyBatch(messages: readonly ZoneDegradation[]): IncidentWireEvent[] {
    if (messages.length === 0) {
      return [];
    }

    this.batches++;
    degradationBatchSize.observe(messages.length);

    const events: IncidentEvent[] = [];

    for (const message of messages) {
      if (!this.isUsable(message)) {
        continue;
      }

      // Complete every grid boundary this message lies past, BEFORE folding it in, so that the
      // reconcile at boundary B sees exactly the messages at or before B and no others.
      this.advanceTo(message.eventTime, events);

      this.foldedSinceTick = true;
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

    this.syncGauges();
    return this.toWire(events);
  }

  /**
   * Reconcile every grid boundary up to the current watermark, and return what that produced.
   *
   * For the end of a bounded stream: an offline replay, or a graceful shutdown. Live, the next
   * message completes a boundary; at the end of a run there is no next message, so the last
   * boundaries would never complete and the final `CLOSED` events would never be emitted.
   *
   * It reconciles at grid boundaries only — never at the watermark itself. Reconciling at an
   * arbitrary instant would put a non-grid value into an incident id preimage and reintroduce, at
   * the end of every run, exactly the non-determinism the grid removes. So after catching up to
   * the watermark it runs **one** further tick, at the boundary that closes the interval the last
   * message fell in. That boundary is a multiple of the tick and is a function of the stream's
   * own last event time, so two replays agree on it.
   *
   * The price is a few milliseconds of invented event time: that final boundary can be up to one
   * tick past the last message, so a member whose window expires inside that gap is expired
   * without data saying so. At the end of a stream that has already stopped, calling a member
   * expired slightly early is the correct reading of "there is no more evidence" — and leaving
   * the incident open forever, which is the alternative, is not.
   */
  flush(): IncidentWireEvent[] {
    if (this.pendingTickAt === null) {
      return [];
    }
    const events: IncidentEvent[] = [];
    this.runTicksUpTo(this.window.watermark, events);

    if (this.pendingTickAt !== null && this.foldedSinceTick) {
      const at = this.pendingTickAt;
      this.pendingTickAt = at + this.reconcileTickMs;
      this.runTick(at, events);
    }

    this.syncGauges();
    return this.toWire(events);
  }

  /**
   * Complete every boundary strictly before `eventTime`, then arm the next one.
   *
   * On the very first message the grid is anchored at `ceil(eventTime / tick)` — the boundary
   * closing the interval that message falls in. Anchoring on a *multiple of the tick* rather than
   * on the first message's own timestamp is what makes two runs that start at different points —
   * a replay from the beginning and a consumer joining mid-stream — agree about where the
   * boundaries are, and therefore agree about incident ids.
   */
  private advanceTo(eventTime: number, into: IncidentEvent[]): void {
    if (this.pendingTickAt === null) {
      this.pendingTickAt = Math.ceil(eventTime / this.reconcileTickMs) * this.reconcileTickMs;
      return;
    }
    // Strictly before: a message landing exactly on a boundary belongs to that boundary's
    // interval, so the boundary is not complete until something after it arrives.
    this.runTicksUpTo(eventTime - 1, into);
  }

  /** Reconcile every armed boundary at or before `limit`. */
  private runTicksUpTo(limit: number, into: IncidentEvent[]): void {
    while (this.pendingTickAt !== null && this.pendingTickAt <= limit) {
      // Nothing active and nothing open means every intervening reconcile would emit nothing and
      // change nothing, so the grid can be fast-forwarded. An optimisation with no observable
      // effect — it is only sound because a reconcile over an empty partition with no live
      // incidents is provably a no-op — and it is what keeps a four-hour quiet stretch from
      // costing 2,880 empty reconciles on a replay.
      if (this.window.size === 0 && this.lifecycle.size === 0) {
        const target = Math.floor(limit / this.reconcileTickMs) * this.reconcileTickMs;
        if (target > this.pendingTickAt) {
          const skipped = (target - this.pendingTickAt) / this.reconcileTickMs;
          this.ticksSkipped += skipped;
          reconcileTicksSkippedTotal.inc(skipped);
          this.pendingTickAt = target;
        }
      }

      const at = this.pendingTickAt;
      this.pendingTickAt = at + this.reconcileTickMs;
      this.runTick(at, into);
    }
  }

  private runTick(at: number, into: IncidentEvent[]): void {
    // The only wall-clock read in the engine, and it decides nothing: it is a stopwatch around
    // the compaction, and its value reaches a histogram and nowhere else. Rule 3 in CLAUDE.md
    // forbids a clock *deciding* anything on this path; `replays byte-identically` in
    // `correlationEngine.test.ts` is the guard that it does not.
    const startedAt = Date.now();
    const expired = this.window.tick(at);
    if (expired.length > 0) {
      this.connectivity.compact(expired);
      for (const zoneId of expired) {
        this.observations.delete(zoneId);
      }
    }
    for (const event of this.lifecycle.reconcile(this.connectivity.components(), at)) {
      into.push(event);
    }
    compactionDurationMs.observe(Date.now() - startedAt);
    this.foldedSinceTick = false;
    this.ticks++;
    reconcileTicksTotal.inc();
  }

  private toWire(events: readonly IncidentEvent[]): IncidentWireEvent[] {
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
      ticks: this.ticks,
      ticksSkipped: this.ticksSkipped,
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
