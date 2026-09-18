import { createHash } from 'crypto';

import { canonicalise } from './connectivity';

/**
 * Components become incidents, and incidents acquire an identity that survives change.
 *
 * `TimeAwareConnectivity` answers "which zones are currently one connected blob". That is not yet
 * an incident. A blob has no name, no history, and no opinion about whether it is the same blob
 * it was thirty seconds ago — and every one of those is exactly what an on-call engineer needs.
 * This file supplies them: it maps the partition onto a set of long-lived incidents and emits the
 * five transitions a consumer can act on.
 *
 * | Event | When |
 * |---|---|
 * | `OPENED` | a component with no incident on it reaches `INCIDENT_MIN_ZONES` |
 * | `GREW` | at least one zone joined an existing incident |
 * | `SHRANK` | zones left and none joined |
 * | `MERGED` | one component now carries two or more existing incidents |
 * | `CLOSED` | superseded by a merge, dissolved, or below the minimum past the grace period |
 *
 * ## The two decisions that matter
 *
 * Both are recorded in `docs/adr/ADR-003-incident-identity.md`, because both are judgement calls
 * where the alternative is defensible and the choice has to be defended.
 *
 * **Merge.** When a bridging zone joins two incidents, the survivor is the one with the earlier
 * `openedAt`, ties broken by lexicographic `incidentId`. The survivor gets a `MERGED` carrying
 * `mergedFrom`; every loser gets a `CLOSED` carrying `supersededBy`, so a consumer already
 * holding a loser's id is told where it went rather than watching it fall silent.
 *
 * **Split.** When a bridging member expires, the component fractures. The largest surviving
 * fragment keeps the incident id; the others open fresh incidents carrying `splitFrom`. On-call
 * continuity beats set-theoretic purity: the alternative — close the original and open one new
 * incident per fragment — is arguably more honest about the fact that the original no longer
 * exists, and it also pages everyone again about a fault they have been working for ten minutes.
 *
 * ## Why there are three statuses and not two
 *
 * `CLOSED` is specified as "member count stayed below the minimum for `INCIDENT_CLOSE_GRACE_MS`",
 * and one of the invariants this module is held to is that **no `OPEN` incident is below the
 * minimum**. Those two only coexist if there is a state for "below the minimum, but not yet given
 * up on": that is `DRAINING`. An incident that regrows during the grace period returns to `OPEN`
 * with the same id, which is the whole point — a flapping regional fault produces one incident,
 * not one per flap.
 *
 * ## Determinism
 *
 * No clock, no randomness, no counters (CLAUDE.md rule 3). The incident id is a hash of its seed
 * member set and its opening event time; event time is taken as a monotonic watermark, so a
 * replay of the same sequence produces the same ids, the same events, in the same order, byte for
 * byte. `incidentProperties.test.ts` asserts exactly that.
 */

const DEFAULT_MIN_ZONES = parseInt(process.env.INCIDENT_MIN_ZONES || '3', 10);
const DEFAULT_CLOSE_GRACE_MS = parseInt(process.env.INCIDENT_CLOSE_GRACE_MS || '60000', 10);

/**
 * Versioned preimage prefix. The id scheme is a published contract — ids land in Postgres, in
 * Redis keys and in whatever a consumer stored — so a future change to how they are derived has
 * to be visibly a different scheme rather than a silent reinterpretation of the same 16 hex
 * characters.
 */
const ID_SCHEME = 'geopulse-incident-v1';

/** 16 hex characters = 64 bits of SHA-256. See `mintId` for why this is enough. */
const ID_HEX_LENGTH = 16;

export type IncidentStatus = 'OPEN' | 'DRAINING' | 'CLOSED';

export type IncidentEventType = 'OPENED' | 'GREW' | 'SHRANK' | 'MERGED' | 'CLOSED';

export type IncidentCloseReason =
  /** Absorbed by a merge. `supersededBy` names the survivor. */
  | 'SUPERSEDED'
  /** Every member left the correlation window. Nothing is left to carry the identity. */
  | 'DISSOLVED'
  /** Stayed below `minZones` for `closeGraceMs` of event time. */
  | 'GRACE_EXPIRED';

export interface IncidentLifecycleOptions {
  /**
   * Members a component needs before it is an incident at all. This is the threshold that makes
   * the project's thesis true or false: at 1, every lone flapping sensor is an incident and
   * nothing has been collapsed; too high and a small but real regional fault is invisible.
   */
  minZones?: number;
  /**
   * How long an incident may sit below `minZones` before it closes. Exists so that a fault
   * hovering around the threshold produces one incident rather than a stutter of open/close
   * pairs.
   */
  closeGraceMs?: number;
  /** Id prefix, for readability in logs and URLs. */
  idPrefix?: string;
}

export interface IncidentEvent {
  type: IncidentEventType;
  incidentId: string;
  /** Event time of the reconcile that produced this. Never wall clock. */
  eventTime: number;
  /** Status **after** the transition. */
  status: IncidentStatus;
  openedAt: number;
  /** Full member set after the transition, sorted. Consumers never have to reconstruct it. */
  members: string[];
  memberCount: number;
  /** Members gained in this transition, sorted. */
  added: string[];
  /**
   * Members lost in this transition, sorted. Empty on a `CLOSED` that was superseded or aged
   * out: those members did not leave, the incident did. Populated on a dissolved close, where
   * they genuinely all went.
   */
  removed: string[];
  /** `MERGED` only: the incidents absorbed, sorted. */
  mergedFrom?: string[];
  /** `CLOSED` with reason `SUPERSEDED`: where this incident's identity continues. */
  supersededBy?: string;
  /** `OPENED` only: the incident this fragment was carved out of, when it came from a split. */
  splitFrom?: string;
  /** `CLOSED` only. */
  closeReason?: IncidentCloseReason;
}

export interface IncidentSnapshot {
  incidentId: string;
  status: IncidentStatus;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
  members: string[];
  memberCount: number;
  /** Largest this incident has ever been. Survives shrinkage; useful for severity ranking. */
  peakMemberCount: number;
  /** The member set that produced the id. Immutable for the incident's life. */
  seedMembers: string[];
  /** Event time it last fell below `minZones`; null while `OPEN`. */
  belowMinSince: number | null;
  supersededBy: string | null;
  splitFrom: string | null;
}

export interface IncidentLifecycleStats {
  reconciles: number;
  /** Component members walked, summed over every reconcile. See the note on `reconcile` cost. */
  membersReconciled: number;
  opened: number;
  grew: number;
  shrank: number;
  merged: number;
  closed: number;
  /** Incidents absorbed by a merge. */
  superseded: number;
  /** Incidents that fractured into two or more components. */
  splits: number;
  /** Fragments that lost the id in a split and had to open fresh (or fold into a neighbour). */
  splitFragments: number;
  /**
   * Times a minted id was already taken and had to be disambiguated — see `mintId`. Non-zero
   * only when an incident closes and an identical seed set reopens at the very same event-time
   * instant, or on a genuine 64-bit SHA-256 collision.
   */
  idCollisions: number;
  activeIncidents: number;
  draining: number;
  peakActiveIncidents: number;
  /** Highest event time this lifecycle has been shown. Never moves backwards. */
  watermark: number;
}

/** Internal mutable record. `IncidentSnapshot` is the copy handed out. */
interface Incident {
  incidentId: string;
  status: IncidentStatus;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** Sorted, and kept in sync with `memberSet`. */
  members: string[];
  memberSet: Set<string>;
  peakMemberCount: number;
  seedMembers: string[];
  belowMinSince: number | null;
  supersededBy: string | null;
  splitFrom: string | null;
}

export class IncidentLifecycle {
  private readonly minZones: number;
  private readonly closeGraceMs: number;
  private readonly idPrefix: string;

  /** Live incidents only. A closed incident is dropped; its id is never reissued. */
  private readonly incidents = new Map<string, Incident>();

  /**
   * zone id → the incident currently claiming it. Rebuilt from the incidents at the end of every
   * reconcile rather than patched incrementally: the patching version has four places to forget
   * and this one has none, and it costs a walk over the active members we have just walked
   * anyway.
   */
  private readonly claims = new Map<string, string>();

  /**
   * Ids of incidents that closed at the current watermark instant, with the `openedAt` they were
   * minted from. Read by `mintId` so a closed id is never reissued, and pruned the moment event
   * time moves past it — at which point no future incident can hash to it anyway, because
   * `openedAt` is part of the preimage. So this holds at most the incidents that closed in one
   * instant, not a growing graveyard.
   */
  private readonly retired = new Map<string, number>();

  private highWatermark = 0;

  private reconciles = 0;
  private membersReconciled = 0;
  private opened = 0;
  private grew = 0;
  private shrank = 0;
  private mergedCount = 0;
  private closedCount = 0;
  private supersededCount = 0;
  private splits = 0;
  private splitFragments = 0;
  private idCollisions = 0;
  private peakActiveIncidents = 0;

  constructor(options: IncidentLifecycleOptions = {}) {
    const minZones = options.minZones ?? DEFAULT_MIN_ZONES;
    const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const idPrefix = options.idPrefix ?? 'INC';

    if (!Number.isInteger(minZones) || minZones < 1) {
      throw new Error(`minZones must be an integer >= 1, got ${minZones}`);
    }
    if (!Number.isFinite(closeGraceMs) || closeGraceMs < 0) {
      throw new Error(`closeGraceMs must be a non-negative finite number, got ${closeGraceMs}`);
    }
    if (idPrefix.length === 0) {
      throw new Error('idPrefix must be a non-empty string');
    }

    this.minZones = minZones;
    this.closeGraceMs = closeGraceMs;
    this.idPrefix = idPrefix;
  }

  /**
   * Fold the current component partition into the incident set and return the transitions.
   *
   * The whole partition is passed, not a delta. Cost is O(active members + live incidents) per
   * call, which for this workload is tens of zones out of a fleet of thousands — the expensive
   * structure is the connectivity one, and it is already incremental. Passing deltas would mean
   * the lifecycle trusting the caller to have described every consequence of a rebuild, and a
   * rebuild's consequences are precisely the splits this module exists to detect. `stats()`
   * reports `membersReconciled` so the assumption stays measurable rather than asserted.
   *
   * **Call this on the compaction cadence even when nothing changed.** A grace-period close is
   * driven by event time, not by an event: an incident that shrank below the minimum and then
   * went completely quiet closes on the first reconcile at or after its deadline, and if nothing
   * reconciles it stays `DRAINING` forever.
   *
   * `eventTime` is taken as a **monotonic watermark**. A batch that arrives out of order cannot
   * pull incident clocks backwards, which is what makes the uniqueness argument for `mintId`
   * hold and what stops a late message re-opening a grace period that has already expired.
   */
  reconcile(components: ReadonlyArray<readonly string[]>, eventTime: number): IncidentEvent[] {
    if (!Number.isFinite(eventTime)) {
      throw new Error(`eventTime must be a finite number, got ${eventTime}`);
    }
    if (eventTime > this.highWatermark) {
      this.highWatermark = eventTime;
    }
    const now = this.highWatermark;
    this.reconciles++;

    for (const [incidentId, openedAt] of this.retired) {
      if (openedAt < now) {
        this.retired.delete(incidentId);
      }
    }

    const partition = this.validate(components);

    // --- claims ------------------------------------------------------------------------------
    // Which live incidents each component carries, and how many of their members it inherited.
    const claimCounts: Array<Map<string, number>> = partition.map(() => new Map<string, number>());
    const fragmentsOf = new Map<string, number[]>();

    partition.forEach((component, index) => {
      const counts = claimCounts[index];
      for (const zoneId of component) {
        const incidentId = this.claims.get(zoneId);
        if (incidentId === undefined) {
          continue;
        }
        const seen = counts.get(incidentId);
        counts.set(incidentId, (seen ?? 0) + 1);
        if (seen === undefined) {
          const fragments = fragmentsOf.get(incidentId);
          if (fragments === undefined) {
            fragmentsOf.set(incidentId, [index]);
          } else {
            fragments.push(index);
          }
        }
      }
    });

    const splitOrigin = this.resolveSplits(partition, claimCounts, fragmentsOf);

    // --- component-driven transitions ---------------------------------------------------------
    const events: IncidentEvent[] = [];
    const touched = new Set<string>();

    partition.forEach((component, index) => {
      const claimIds = [...claimCounts[index].keys()].sort();

      if (claimIds.length === 0) {
        if (component.length >= this.minZones) {
          events.push(this.open(component, now, splitOrigin.get(index) ?? null, touched));
        }
        return;
      }

      if (claimIds.length === 1) {
        const incident = this.incidents.get(claimIds[0])!;
        touched.add(incident.incidentId);
        const event = this.applyMembership(incident, component, now);
        if (event !== null) {
          events.push(event);
        }
        return;
      }

      const survivor = this.pickSurvivor(claimIds);
      const losers = claimIds.filter((id) => id !== survivor.incidentId);
      touched.add(survivor.incidentId);
      events.push(this.applyMerge(survivor, losers, component, now));
      for (const loserId of losers) {
        touched.add(loserId);
        this.supersededCount++;
        events.push(
          this.close(this.incidents.get(loserId)!, now, 'SUPERSEDED', survivor.incidentId)
        );
      }
    });

    // --- time-driven and absence-driven closes ------------------------------------------------
    // Sorted, so two incidents closing in the same reconcile always close in the same order.
    for (const incidentId of [...this.incidents.keys()].sort()) {
      const incident = this.incidents.get(incidentId)!;

      if (!touched.has(incidentId)) {
        // No component carries it: every member left the window. Nothing remains that could carry
        // the identity forward, so a grace period here would only delay a certain close.
        const departed = incident.members;
        incident.members = [];
        incident.memberSet = new Set<string>();
        events.push(this.close(incident, now, 'DISSOLVED', null, departed));
        continue;
      }

      if (
        incident.status === 'DRAINING' &&
        incident.belowMinSince !== null &&
        now - incident.belowMinSince >= this.closeGraceMs
      ) {
        events.push(this.close(incident, now, 'GRACE_EXPIRED', null));
      }
    }

    this.rebuildClaims();
    this.peakActiveIncidents = Math.max(this.peakActiveIncidents, this.incidents.size);

    return events;
  }

  /** The incident currently claiming `zoneId`, or undefined. */
  incidentOf(zoneId: string): string | undefined {
    return this.claims.get(zoneId);
  }

  /** A copy of one live incident's state, or undefined once it has closed. */
  snapshot(incidentId: string): IncidentSnapshot | undefined {
    const incident = this.incidents.get(incidentId);
    return incident === undefined ? undefined : this.toSnapshot(incident);
  }

  /** Every live incident, sorted by id. */
  activeIncidents(): IncidentSnapshot[] {
    return [...this.incidents.keys()].sort().map((id) => this.toSnapshot(this.incidents.get(id)!));
  }

  /** Live incidents, `OPEN` and `DRAINING` together. */
  get size(): number {
    return this.incidents.size;
  }

  /** Highest event time this lifecycle has been shown. */
  get watermark(): number {
    return this.highWatermark;
  }

  /** The thresholds this instance is working to. */
  get geometry(): { minZones: number; closeGraceMs: number } {
    return { minZones: this.minZones, closeGraceMs: this.closeGraceMs };
  }

  stats(): IncidentLifecycleStats {
    let draining = 0;
    for (const incident of this.incidents.values()) {
      if (incident.status === 'DRAINING') {
        draining++;
      }
    }
    return {
      reconciles: this.reconciles,
      membersReconciled: this.membersReconciled,
      opened: this.opened,
      grew: this.grew,
      shrank: this.shrank,
      merged: this.mergedCount,
      closed: this.closedCount,
      superseded: this.supersededCount,
      splits: this.splits,
      splitFragments: this.splitFragments,
      idCollisions: this.idCollisions,
      activeIncidents: this.incidents.size,
      draining,
      peakActiveIncidents: this.peakActiveIncidents,
      watermark: this.highWatermark
    };
  }

  // -------------------------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------------------------

  /**
   * `INC-<16 hex>` = SHA-256 over `scheme | openedAt | sorted seed members`.
   *
   * **Why a hash and not a UUID or a counter.** Both of those are functions of *when the process
   * happened to run*, not of what happened. Replay a scenario and a UUID gives different ids; a
   * counter gives the same ids only if every incident opens in the same order, which stops being
   * true the moment two partitions are consumed concurrently. Every measurement this project
   * makes is a replay compared against a previous replay, and the eval harness joins incidents to
   * ground truth by id. A hash of the facts makes that join stable by construction, and it makes
   * two independent consumers of the same stream agree on the name of an incident without
   * coordinating.
   *
   * **Why it is unique, and what the loop below is for.** Two incidents collide only if they
   * hash the same preimage: the same seed member set at the same `openedAt`. Components of a
   * partition are disjoint, so no two incidents open with the same seed set in the same
   * reconcile, and `openedAt` is a monotonic watermark, so a later reconcile never stamps an
   * earlier time. That leaves exactly one real route, and the property tests found it: an
   * incident closes and an identical seed set reopens **at the same event-time instant** — a
   * zone that recovers and re-degrades inside one millisecond, which at `minZones: 1` is a
   * single message pair. `retired` closes that hole, and the loop disambiguates by extending the
   * preimage. The remaining route is an actual 64-bit SHA-256 collision, handled by the same
   * loop. Both resolutions are a function of the input alone, so a replay disambiguates
   * identically; `stats().idCollisions` counts how often it happened.
   *
   * 64 bits is chosen against the size of the population it has to separate: incidents live for
   * minutes and a busy deployment produces thousands a day, so a birthday collision is a
   * once-in-many-millions-of-years event. A full 256-bit id would be unreadable in a log line for
   * no gain.
   */
  private mintId(seedMembers: readonly string[], openedAt: number): string {
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `|#${attempt}`;
      const preimage = `${ID_SCHEME}|${openedAt}|${seedMembers.join(',')}${suffix}`;
      const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
      const incidentId = `${this.idPrefix}-${digest.slice(0, ID_HEX_LENGTH)}`;
      if (!this.incidents.has(incidentId) && !this.retired.has(incidentId)) {
        return incidentId;
      }
      this.idCollisions++;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------------------------

  private open(
    members: readonly string[],
    now: number,
    splitFrom: string | null,
    touched: Set<string>
  ): IncidentEvent {
    const seedMembers = [...members];
    const incidentId = this.mintId(seedMembers, now);

    const incident: Incident = {
      incidentId,
      status: 'OPEN',
      openedAt: now,
      updatedAt: now,
      closedAt: null,
      members: seedMembers,
      memberSet: new Set(seedMembers),
      peakMemberCount: seedMembers.length,
      seedMembers: [...seedMembers],
      belowMinSince: null,
      supersededBy: null,
      splitFrom
    };

    this.incidents.set(incidentId, incident);
    touched.add(incidentId);
    this.opened++;

    return this.buildEvent(incident, 'OPENED', now, [...seedMembers], [], {
      splitFrom: splitFrom ?? undefined
    });
  }

  /**
   * Move an incident onto a new member set and name the transition.
   *
   * `GREW` if anything joined, `SHRANK` if members left and nothing joined, nothing at all if the
   * set is unchanged. A batch can do both at once — that is the point of consuming a whole batch
   * of degradations as one unit — and when it does, the event type names the net direction while
   * `added` and `removed` carry the exact truth. One event per incident per reconcile is
   * deliberate: the alternative is a `GREW` per zone during a storm, which is the churn this
   * whole project exists to remove.
   */
  private applyMembership(
    incident: Incident,
    members: readonly string[],
    now: number
  ): IncidentEvent | null {
    const { added, removed } = this.diff(incident, members);
    if (added.length === 0 && removed.length === 0) {
      return null;
    }

    this.adopt(incident, members, now);

    if (added.length > 0) {
      this.grew++;
      return this.buildEvent(incident, 'GREW', now, added, removed);
    }
    this.shrank++;
    return this.buildEvent(incident, 'SHRANK', now, added, removed);
  }

  private applyMerge(
    survivor: Incident,
    losers: readonly string[],
    members: readonly string[],
    now: number
  ): IncidentEvent {
    const { added, removed } = this.diff(survivor, members);
    this.adopt(survivor, members, now);
    this.mergedCount++;
    return this.buildEvent(survivor, 'MERGED', now, added, removed, { mergedFrom: [...losers] });
  }

  private close(
    incident: Incident,
    now: number,
    reason: IncidentCloseReason,
    supersededBy: string | null,
    removed: string[] = []
  ): IncidentEvent {
    incident.status = 'CLOSED';
    incident.closedAt = now;
    incident.updatedAt = now;
    incident.supersededBy = supersededBy;
    this.incidents.delete(incident.incidentId);
    this.retired.set(incident.incidentId, incident.openedAt);
    this.closedCount++;

    return this.buildEvent(incident, 'CLOSED', now, [], removed, {
      supersededBy: supersededBy ?? undefined,
      closeReason: reason
    });
  }

  /**
   * The incident that keeps its id when several meet in one component: **earliest `openedAt`,
   * ties broken by lexicographic `incidentId`**.
   *
   * Age is the rule because the older incident is the one people have been looking at — it is in
   * a ticket, in a chat thread, on a dashboard. Size is the obvious alternative and it is worse:
   * a fault that spreads fast would repeatedly hand the identity to whichever fragment happened
   * to be larger at the instant of the merge, so the id would change under an engineer
   * mid-incident. The lexicographic tie-break is not cosmetic: two incidents genuinely can open
   * at the same event time, and without a total order the survivor would depend on iteration
   * order, which would make replays disagree.
   */
  private pickSurvivor(claimIds: readonly string[]): Incident {
    let survivor = this.incidents.get(claimIds[0])!;
    for (let i = 1; i < claimIds.length; i++) {
      const candidate = this.incidents.get(claimIds[i])!;
      if (
        candidate.openedAt < survivor.openedAt ||
        (candidate.openedAt === survivor.openedAt && candidate.incidentId < survivor.incidentId)
      ) {
        survivor = candidate;
      }
    }
    return survivor;
  }

  // -------------------------------------------------------------------------------------------
  // Splits
  // -------------------------------------------------------------------------------------------

  /**
   * An incident carried by two or more components has been split by a departing member. Award the
   * id to one fragment and strip the claim from the rest, so that the pass afterwards sees them
   * as either fresh components or as members of some other incident.
   *
   * The keeper is **the fragment that retained the most of the incident's members**, ties broken
   * by total fragment size, then by canonical order. Inherited members rather than raw size,
   * because the question being answered is "which of these is most continuous with the thing that
   * was there before" — a fragment that is large only because four unrelated zones joined it in
   * the same batch has not inherited the incident.
   *
   * Returns, for each losing fragment, the incident it was carved out of, so the `OPENED` event
   * can carry `splitFrom`. Where a fragment lost claims to more than one incident, the one it
   * took the most members from wins the provenance.
   */
  private resolveSplits(
    partition: readonly string[][],
    claimCounts: ReadonlyArray<Map<string, number>>,
    fragmentsOf: ReadonlyMap<string, number[]>
  ): Map<number, string> {
    const splitOrigin = new Map<number, string>();
    const splitOriginWeight = new Map<number, number>();

    // Sorted for a stable order of the stat counters; the outcome itself is order-independent.
    for (const incidentId of [...fragmentsOf.keys()].sort()) {
      const fragments = fragmentsOf.get(incidentId)!;
      if (fragments.length < 2) {
        continue;
      }
      this.splits++;

      let keeper = fragments[0];
      for (const index of fragments.slice(1)) {
        const inherited = claimCounts[index].get(incidentId)!;
        const best = claimCounts[keeper].get(incidentId)!;
        if (
          inherited > best ||
          (inherited === best && partition[index].length > partition[keeper].length)
        ) {
          keeper = index;
        }
        // Equal on both counts: keep the earlier index, which is canonical order — the fragment
        // whose lexicographically smallest member sorts first.
      }

      for (const index of fragments) {
        if (index === keeper) {
          continue;
        }
        const inherited = claimCounts[index].get(incidentId)!;
        claimCounts[index].delete(incidentId);
        this.splitFragments++;

        if (inherited > (splitOriginWeight.get(index) ?? 0)) {
          splitOrigin.set(index, incidentId);
          splitOriginWeight.set(index, inherited);
        }
      }
    }

    return splitOrigin;
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  /**
   * Canonicalise the partition and reject the two shapes that would silently corrupt state: an
   * empty component (no zone to key an incident on) and a zone in two components at once (not a
   * partition, and it would let two incidents claim the same zone). Both are caller bugs, and a
   * loud failure here is much cheaper than the incident-shaped garbage they would otherwise
   * produce downstream.
   */
  private validate(components: ReadonlyArray<readonly string[]>): string[][] {
    const seen = new Set<string>();
    for (const component of components) {
      if (component.length === 0) {
        throw new Error('reconcile received an empty component');
      }
      for (const zoneId of component) {
        if (seen.has(zoneId)) {
          throw new Error(`zone ${zoneId} appears in more than one component`);
        }
        seen.add(zoneId);
      }
    }
    this.membersReconciled += seen.size;
    return canonicalise(components.map((component) => [...component]));
  }

  private diff(
    incident: Incident,
    members: readonly string[]
  ): { added: string[]; removed: string[] } {
    const incoming = new Set(members);
    const added = members.filter((zoneId) => !incident.memberSet.has(zoneId)).sort();
    const removed = incident.members.filter((zoneId) => !incoming.has(zoneId)).sort();
    return { added, removed };
  }

  /**
   * Take on a new member set and re-derive the status from it.
   *
   * Status can only change alongside a membership change — `OPEN` → `DRAINING` needs a departure
   * and `DRAINING` → `OPEN` needs an arrival — which is why every status change rides on an event
   * and none has to be announced separately.
   */
  private adopt(incident: Incident, members: readonly string[], now: number): void {
    incident.members = [...members];
    incident.memberSet = new Set(members);
    incident.updatedAt = now;
    incident.peakMemberCount = Math.max(incident.peakMemberCount, incident.members.length);

    if (incident.members.length >= this.minZones) {
      incident.status = 'OPEN';
      incident.belowMinSince = null;
    } else {
      incident.status = 'DRAINING';
      if (incident.belowMinSince === null) {
        incident.belowMinSince = now;
      }
    }
  }

  private rebuildClaims(): void {
    this.claims.clear();
    for (const incident of this.incidents.values()) {
      for (const zoneId of incident.members) {
        this.claims.set(zoneId, incident.incidentId);
      }
    }
  }

  /**
   * Events are built with a fixed key order, and optional fields are omitted rather than set to
   * `undefined`, so `JSON.stringify` of an event stream is byte-stable across replays. The
   * determinism property test compares exactly that string.
   */
  private buildEvent(
    incident: Incident,
    type: IncidentEventType,
    eventTime: number,
    added: string[],
    removed: string[],
    extra: {
      mergedFrom?: string[];
      supersededBy?: string;
      splitFrom?: string;
      closeReason?: IncidentCloseReason;
    } = {}
  ): IncidentEvent {
    const event: IncidentEvent = {
      type,
      incidentId: incident.incidentId,
      eventTime,
      status: incident.status,
      openedAt: incident.openedAt,
      members: [...incident.members],
      memberCount: incident.members.length,
      added,
      removed
    };
    if (extra.mergedFrom !== undefined) {
      event.mergedFrom = extra.mergedFrom;
    }
    if (extra.supersededBy !== undefined) {
      event.supersededBy = extra.supersededBy;
    }
    if (extra.splitFrom !== undefined) {
      event.splitFrom = extra.splitFrom;
    }
    if (extra.closeReason !== undefined) {
      event.closeReason = extra.closeReason;
    }
    return event;
  }

  private toSnapshot(incident: Incident): IncidentSnapshot {
    return {
      incidentId: incident.incidentId,
      status: incident.status,
      openedAt: incident.openedAt,
      updatedAt: incident.updatedAt,
      closedAt: incident.closedAt,
      members: [...incident.members],
      memberCount: incident.members.length,
      peakMemberCount: incident.peakMemberCount,
      seedMembers: [...incident.seedMembers],
      belowMinSince: incident.belowMinSince,
      supersededBy: incident.supersededBy,
      splitFrom: incident.splitFrom
    };
  }
}
