import { AdjacencyProvider, Connectivity, describePartition } from '../../connectivity';
import { CorrelationWindow } from '../../correlationWindow';
import { NaiveConnectivity } from '../../naiveConnectivity';
import { TimeAwareConnectivity } from '../../timeAwareConnectivity';

/** The simulator's fixed epoch (ADR-005), so fuzz timestamps look like the real ones. */
export const BASE_EVENT_TIME = 1768478400000;

/**
 * One randomised input event. This is the shape the correlation engine actually consumes: a
 * degradation, a recovery, or the passage of event time that eventually expires members.
 */
export type FuzzEvent =
  | { kind: 'degrade'; zone: number; dt: number }
  | { kind: 'recover'; zone: number; dt: number }
  | { kind: 'tick'; dt: number };

export interface DriverOptions {
  windowMs: number;
  compactionIntervalMs: number;
}

export interface Divergence {
  /** Index of the event that produced the disagreement. */
  step: number;
  event: FuzzEvent;
  eventTime: number;
  naive: string;
  optimised: string;
  /** Every event up to and including the diverging one, rendered for a repro. */
  history: string[];
}

export interface DriverResult {
  /** Non-null on the first disagreement; the run stops there. */
  divergence: Divergence | null;
  /** Events applied before stopping. */
  steps: number;
  /** Partition comparisons performed. */
  comparisons: number;
  /** The final partition, when the run completed. */
  finalPartition: string;

  // Reach. A fuzz run that only ever held one member would pass while proving nothing, so the
  // driver reports what the sequence actually got the structures to do. These are what make the
  // headline sequence count mean something.

  /** Largest component seen at any point in the run. */
  maxComponentSize: number;
  /** Removals that fractured a component — the case union-find cannot do at all. */
  splits: number;
  /** Zones expired by a compaction tick. */
  expired: number;
  /** Zones dropped by a recovery while they were members. */
  recovered: number;
  /**
   * Times the active set went from non-empty back to empty — a full teardown, where every
   * component was discarded rather than rebuilt. The path that leaves nothing behind is its own
   * branch in `removeMembers`, so a fuzz run that never took it would be leaving it untested.
   */
  wipeouts: number;
}

/**
 * Drive `TimeAwareConnectivity` and `NaiveConnectivity` through **one** event sequence and
 * compare their partitions after **every** event.
 *
 * Two deliberate choices here.
 *
 * *One window, two structures.* Membership — who is degraded, for how long, and when they
 * expire — is decided once by a single `CorrelationWindow`, and both structures are handed the
 * identical call sequence. If each owned its own window, a disagreement could originate in
 * either half and the test would only tell us that something, somewhere, differs.
 *
 * *Compare after every event, not at the end.* An incremental structure's failures are
 * order-dependent: a stale parent pointer can be invisible for twenty operations and then decide
 * a merge. Comparing only the final state would let a divergence be masked by a later removal
 * that happens to rebuild the broken component. Comparing every step means the reported failure
 * is the operation that caused it, which is also what makes a shrunk counterexample readable.
 */
export function driveBoth(
  adjacency: AdjacencyProvider,
  events: readonly FuzzEvent[],
  zoneIdOf: (index: number) => string,
  options: DriverOptions
): DriverResult {
  const window = new CorrelationWindow(options);
  const optimised: Connectivity = new TimeAwareConnectivity(adjacency);
  const naive: Connectivity = new NaiveConnectivity(adjacency);

  const history: string[] = [];
  let eventTime = BASE_EVENT_TIME;
  let comparisons = 0;
  let maxComponentSize = 0;
  let splits = 0;
  let expired = 0;
  let recovered = 0;
  let wipeouts = 0;
  let previousComponentCount = 0;
  let previousMemberCount = 0;

  for (let step = 0; step < events.length; step++) {
    const event = events[step];
    // Event time moves by the generated delta, which may be negative: partitions drain
    // independently and sensors carry a lag offset, so out-of-order arrival is normal. Clamped
    // so a sequence of negative deltas cannot walk off before the epoch.
    eventTime = Math.max(BASE_EVENT_TIME, eventTime + event.dt);

    switch (event.kind) {
      case 'degrade': {
        const zoneId = zoneIdOf(event.zone);
        window.admit(zoneId, eventTime);
        // Both structures are told only about zones the window actually holds. A degradation
        // refused as stale must move nothing, and a refresh re-runs the unions exactly as the
        // engine does.
        if (window.isActive(zoneId)) {
          optimised.activate(zoneId);
          naive.activate(zoneId);
        }
        history.push(`degrade ${zoneId} @${eventTime - BASE_EVENT_TIME}`);
        break;
      }
      case 'recover': {
        const zoneId = zoneIdOf(event.zone);
        if (window.release(zoneId, eventTime)) {
          recovered++;
        }
        optimised.deactivate(zoneId);
        naive.deactivate(zoneId);
        history.push(`recover ${zoneId} @${eventTime - BASE_EVENT_TIME}`);
        break;
      }
      case 'tick': {
        const evicted = window.tick(eventTime);
        optimised.compact(evicted);
        naive.compact(evicted);
        expired += evicted.length;
        history.push(`tick @${eventTime - BASE_EVENT_TIME} expired=[${evicted.join(',')}]`);
        break;
      }
    }

    const optimisedComponents = optimised.components();
    const naiveComponents = naive.components();
    const optimisedPartition = describePartition(optimisedComponents);
    const naivePartition = describePartition(naiveComponents);
    comparisons++;

    for (const component of optimisedComponents) {
      maxComponentSize = Math.max(maxComponentSize, component.length);
    }
    // A removal that leaves more components than it found is a split — a bridging member left
    // and its component fractured. This is the case a plain union-find cannot express, so a fuzz
    // run that never produced one would not have tested the thing being claimed.
    if (
      (event.kind === 'recover' || event.kind === 'tick') &&
      optimisedComponents.length > previousComponentCount
    ) {
      splits++;
    }
    previousComponentCount = optimisedComponents.length;

    const memberCount = optimised.size;
    if (memberCount === 0 && previousMemberCount > 0) {
      wipeouts++;
    }
    previousMemberCount = memberCount;

    // The window is the definition of who is a member; both structures must hold exactly that
    // set. A structure that agreed with the oracle about shape while holding the wrong members
    // would pass a partition comparison alone.
    const expectedMembers = window.activeMembers().join(',');
    const optimisedMembers = optimisedComponents.flat().sort().join(',');
    const naiveMembers = naiveComponents.flat().sort().join(',');

    if (
      optimisedPartition !== naivePartition ||
      optimisedMembers !== expectedMembers ||
      naiveMembers !== expectedMembers
    ) {
      return {
        divergence: {
          step,
          event,
          eventTime,
          naive: `${naivePartition}  (members ${naiveMembers}; window ${expectedMembers})`,
          optimised: `${optimisedPartition}  (members ${optimisedMembers})`,
          history: [...history]
        },
        steps: step + 1,
        comparisons,
        finalPartition: optimisedPartition,
        maxComponentSize,
        splits,
        expired,
        recovered,
        wipeouts
      };
    }
  }

  return {
    divergence: null,
    steps: events.length,
    comparisons,
    finalPartition: describePartition(optimised.components()),
    maxComponentSize,
    splits,
    expired,
    recovered,
    wipeouts
  };
}

/** A readable repro for a failing sequence: the events, then what each structure believed. */
export function formatDivergence(divergence: Divergence): string {
  return [
    `divergence at step ${divergence.step} (${divergence.event.kind})`,
    '  history:',
    ...divergence.history.map((line) => `    ${line}`),
    `  naive    : ${divergence.naive}`,
    `  optimised: ${divergence.optimised}`
  ].join('\n');
}
