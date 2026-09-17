/**
 * Which zones count as *currently degraded*, and for how long.
 *
 * This is the "temporal" half of spatiotemporal correlation. The spatial half
 * (`@geopulse/spatial`) answers "which zones are next to each other"; this answers "which zones
 * are unhealthy at the same time". An incident is a connected component of the intersection.
 *
 * The model is a sliding per-zone deadline rather than a fixed tumbling window. A zone becomes
 * an active member the moment a degradation arrives and stays one until `windowMs` after its
 * *most recent* degradation. A zone that keeps degrading keeps renewing; a zone that goes quiet
 * falls out on its own. That matters because a tumbling window would slice a long-running
 * regional fault into a new incident every W milliseconds, which is exactly the alert storm this
 * project exists to collapse.
 *
 * Everything here runs on event time (CLAUDE.md rule 3). There is no `Date.now()` in this file
 * and there must never be one: the same event sequence has to produce the same membership at the
 * same instants whether it is replayed at 1x, at 60x, or paused halfway through. A wall-clock
 * version would expire nothing during a fast replay and everything during a slow one.
 */

const DEFAULT_WINDOW_MS = parseInt(process.env.CORRELATION_WINDOW_MS || '120000', 10);
const DEFAULT_COMPACTION_INTERVAL_MS = parseInt(process.env.COMPACTION_INTERVAL_MS || '5000', 10);

export interface CorrelationWindowOptions {
  /**
   * How long a zone stays an active member after its most recent degradation.
   * Too short and a genuinely regional fault never has enough simultaneous members to be seen
   * as one thing; too long and unrelated faults minutes apart get glued together.
   */
  windowMs?: number;
  /**
   * Minimum event time between compaction ticks. `tick()` is a no-op until this much event time
   * has passed since the last one, so a caller may safely call it on every message.
   */
  compactionIntervalMs?: number;
}

export interface WindowMember {
  zoneId: string;
  /** Event time of the degradation that first made this zone active in its current spell. */
  firstDegradedAt: number;
  /** Event time of its most recent degradation. */
  lastDegradedAt: number;
  /** `lastDegradedAt + windowMs`. The zone leaves the window once time passes this. */
  expiresAt: number;
  /** How many degradations have landed in this spell, including the one that opened it. */
  degradations: number;
}

export interface CorrelationWindowStats {
  /** Zones currently active. */
  members: number;
  /** Degradations that made a zone newly active. */
  admissions: number;
  /** Degradations for a zone that was already active. */
  refreshes: number;
  /** Members dropped by an explicit recovery event. */
  releases: number;
  /** Members dropped because their deadline passed. */
  expirations: number;
  /**
   * Degradations rejected because the whole window they would have opened already lies behind
   * the watermark. Non-zero means data is arriving more than `windowMs` late — see `admit`.
   */
  staleAdmissions: number;
  /** Compaction ticks that actually swept, as opposed to calls to `tick()`. */
  sweeps: number;
  /** Highest event time this window has been shown. Never moves backwards. */
  watermark: number;
}

/**
 * The set of zones that are degraded *right now*, in event time.
 *
 * Deliberately knows nothing about geography, components or incidents. It is driven by the
 * correlation engine, which turns its three answers — admitted, released, expired — into
 * membership changes in the connectivity structure. Keeping the two apart is what lets the
 * differential fuzz test drive two connectivity implementations from one identical call
 * sequence: if the window were baked into each of them, a divergence could come from either
 * half and the test would prove less.
 */
export class CorrelationWindow {
  private readonly windowMs: number;
  private readonly compactionIntervalMs: number;

  private readonly members = new Map<string, WindowMember>();

  /**
   * Highest event time seen, monotonic. Expiry is judged against this rather than against the
   * timestamp of whatever message happened to arrive last, so a single out-of-order event
   * cannot drag the window backwards and resurrect members that have already left.
   */
  private highWatermark = 0;

  private lastSweepAt = 0;

  private admissions = 0;
  private refreshes = 0;
  private releases = 0;
  private expirations = 0;
  private staleAdmissions = 0;
  private sweeps = 0;

  constructor(options: CorrelationWindowOptions = {}) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const compactionIntervalMs = options.compactionIntervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS;

    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs must be a positive finite number, got ${windowMs}`);
    }
    if (!Number.isFinite(compactionIntervalMs) || compactionIntervalMs < 0) {
      throw new Error(
        `compactionIntervalMs must be a non-negative finite number, got ${compactionIntervalMs}`
      );
    }

    this.windowMs = windowMs;
    this.compactionIntervalMs = compactionIntervalMs;
  }

  /**
   * Record a degradation for `zoneId` at `eventTime`. Returns true if this made the zone newly
   * active — the caller adds it to the connectivity structure on true, and on false it was
   * already a member and only its deadline moved.
   *
   * **Out-of-order arrival never shortens a window.** Both the last-degraded stamp and the
   * deadline take the maximum of the stored and incoming values, so an event that overtook an
   * older one in the pipeline cannot pull a member's expiry forward. Partitions are drained
   * independently and sensors carry a per-zone lag offset (ADR-005), so out-of-order arrival is
   * the normal case, not an exotic one.
   *
   * **A degradation whose entire window lies behind the watermark is refused**, and counted in
   * `staleAdmissions`. Admitting it would make the zone a member of a component for the length
   * of one compaction interval on the strength of evidence that was already stale when it
   * arrived — a phantom incident, born already expired. Refusing is the same late-data decision
   * the rest of the pipeline makes, and the counter is what makes it visible rather than silent.
   */
  admit(zoneId: string, eventTime: number): boolean {
    if (!Number.isFinite(eventTime)) {
      throw new Error(`eventTime must be a finite number, got ${eventTime}`);
    }

    const expiresAt = eventTime + this.windowMs;

    const existing = this.members.get(zoneId);
    if (existing === undefined) {
      if (expiresAt <= this.highWatermark) {
        this.staleAdmissions++;
        this.advanceWatermark(eventTime);
        return false;
      }
      this.members.set(zoneId, {
        zoneId,
        firstDegradedAt: eventTime,
        lastDegradedAt: eventTime,
        expiresAt,
        degradations: 1
      });
      this.admissions++;
      this.advanceWatermark(eventTime);
      return true;
    }

    existing.lastDegradedAt = Math.max(existing.lastDegradedAt, eventTime);
    existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
    existing.firstDegradedAt = Math.min(existing.firstDegradedAt, eventTime);
    existing.degradations++;
    this.refreshes++;
    this.advanceWatermark(eventTime);
    return false;
  }

  /**
   * Drop `zoneId` because it recovered (`currentState: NORMAL`). Returns true if it was a
   * member.
   *
   * Recovery is immediate rather than waiting for the deadline: the zone has told us it is
   * healthy, and keeping it in the component for up to `windowMs` longer would hold an incident
   * open over zones that are fine. `eventTime` is optional and only advances the watermark;
   * membership is not conditional on it, because a recovery is a statement about the zone that
   * does not become less true for having arrived late.
   */
  release(zoneId: string, eventTime?: number): boolean {
    if (eventTime !== undefined) {
      if (!Number.isFinite(eventTime)) {
        throw new Error(`eventTime must be a finite number, got ${eventTime}`);
      }
      this.advanceWatermark(eventTime);
    }

    const removed = this.members.delete(zoneId);
    if (removed) {
      this.releases++;
    }
    return removed;
  }

  /**
   * Advance event time and, if a compaction tick is due, evict every member past its deadline.
   * Returns the evicted zone ids, sorted; empty when nothing was due or nothing had expired.
   *
   * Safe to call on every message: the `compactionIntervalMs` gate means the scan runs on a
   * fixed event-time cadence rather than once per event. That cadence is the price of the
   * design — a member can outlive its deadline by up to one interval — and it is the reason
   * `COMPACTION_INTERVAL_MS` (5s) is two orders of magnitude below `CORRELATION_WINDOW_MS`
   * (120s). Dropping it to zero makes expiry exact and turns every event into a full scan.
   */
  tick(asOfEventTime: number): string[] {
    if (!Number.isFinite(asOfEventTime)) {
      throw new Error(`asOfEventTime must be a finite number, got ${asOfEventTime}`);
    }
    this.advanceWatermark(asOfEventTime);

    if (this.highWatermark - this.lastSweepAt < this.compactionIntervalMs) {
      return [];
    }
    return this.sweep(this.highWatermark);
  }

  /**
   * Evict everything past its deadline as of `asOfEventTime`, ignoring the tick schedule.
   *
   * The scan is linear in the number of *active members*, not in the fleet — a 100k-zone
   * deployment with forty degraded zones scans forty entries. A deadline-ordered heap with lazy
   * deletion would make it output-sensitive, and is the upgrade to make if active membership
   * ever gets large enough for a 5-second scan to show up in `compaction_duration_ms`. It is
   * not that today, and a linear scan over a Map is much harder to get wrong than a heap whose
   * stale entries have to be reasoned about.
   */
  sweep(asOfEventTime: number): string[] {
    if (!Number.isFinite(asOfEventTime)) {
      throw new Error(`asOfEventTime must be a finite number, got ${asOfEventTime}`);
    }
    this.advanceWatermark(asOfEventTime);
    this.lastSweepAt = this.highWatermark;
    this.sweeps++;

    const expired: string[] = [];
    for (const member of this.members.values()) {
      if (member.expiresAt <= this.highWatermark) {
        expired.push(member.zoneId);
      }
    }
    if (expired.length === 0) {
      return expired;
    }

    // Sorted, so the eviction batch handed to the connectivity structure does not depend on Map
    // insertion order. Replay stability is load-bearing: WP2b derives incident ids from member
    // sets and emits lifecycle events in the order members leave.
    expired.sort();
    for (const zoneId of expired) {
      this.members.delete(zoneId);
    }
    this.expirations += expired.length;
    return expired;
  }

  isActive(zoneId: string): boolean {
    return this.members.has(zoneId);
  }

  /** The stored record for an active member, or undefined. Not a copy — treat it as read-only. */
  memberOf(zoneId: string): WindowMember | undefined {
    return this.members.get(zoneId);
  }

  /** Every active member, sorted by zone id. */
  activeMembers(): string[] {
    return [...this.members.keys()].sort();
  }

  get size(): number {
    return this.members.size;
  }

  /** Highest event time this window has been shown. */
  get watermark(): number {
    return this.highWatermark;
  }

  /** The window length this instance is working to. */
  get geometry(): { windowMs: number; compactionIntervalMs: number } {
    return { windowMs: this.windowMs, compactionIntervalMs: this.compactionIntervalMs };
  }

  stats(): CorrelationWindowStats {
    return {
      members: this.members.size,
      admissions: this.admissions,
      refreshes: this.refreshes,
      releases: this.releases,
      expirations: this.expirations,
      staleAdmissions: this.staleAdmissions,
      sweeps: this.sweeps,
      watermark: this.highWatermark
    };
  }

  private advanceWatermark(eventTime: number): void {
    if (eventTime > this.highWatermark) {
      this.highWatermark = eventTime;
    }
  }
}
