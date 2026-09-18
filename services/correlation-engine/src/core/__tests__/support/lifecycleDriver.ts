import { AdjacencyProvider, describePartition } from '../../connectivity';
import { CorrelationWindow } from '../../correlationWindow';
import { IncidentEvent, IncidentLifecycle } from '../../incidentLifecycle';
import { TimeAwareConnectivity } from '../../timeAwareConnectivity';
import { BASE_EVENT_TIME, FuzzEvent } from './driver';

export interface LifecycleDriverOptions {
  windowMs: number;
  compactionIntervalMs: number;
  minZones: number;
  closeGraceMs: number;
}

export interface LifecycleRun {
  /**
   * One JSON line per emitted incident event, in order. This is the artefact the determinism
   * property compares: replaying the same input has to produce the same bytes, not merely an
   * equivalent state.
   */
  trace: string[];
  events: IncidentEvent[];
  /** Invariant failures, with enough context to reproduce. Empty is the passing case. */
  violations: string[];
  steps: number;
  /** Invariant checks performed — one per input event, not one per run. */
  checks: number;

  // Reach. Same reasoning as the differential fuzz: a generator that never merges or splits an
  // incident would satisfy every invariant while proving nothing.
  opened: number;
  grew: number;
  shrank: number;
  merged: number;
  closed: number;
  /** Incidents opened as the losing half of a split — carrying `splitFrom`. */
  splitOpens: number;
  supersededCloses: number;
  graceCloses: number;
  dissolvedCloses: number;
  /** Incidents that fell below the minimum and climbed back out with the same id. */
  revivals: number;
  maxIncidentMembers: number;
  maxConcurrentIncidents: number;
}

/**
 * Drive the whole core — window, connectivity, lifecycle — through one event sequence, checking
 * every invariant after every event.
 *
 * The sequence type is the differential fuzz's `FuzzEvent`, deliberately: the two tests explore
 * the same input space, so a sequence that is interesting for connectivity is interesting here
 * too, and anything learned about the generator applies to both.
 *
 * `reconcile` is called after **every** event rather than on the compaction cadence. That is the
 * harshest schedule — it maximises the number of distinct partitions the lifecycle is asked to
 * track, and so the number of opportunities to mis-attribute an identity. The real service
 * reconciles per batch, which is strictly less work over the same stream.
 */
export function driveLifecycle(
  adjacency: AdjacencyProvider,
  events: readonly FuzzEvent[],
  zoneIdOf: (index: number) => string,
  options: LifecycleDriverOptions
): LifecycleRun {
  const window = new CorrelationWindow(options);
  const connectivity = new TimeAwareConnectivity(adjacency);
  const incidents = new IncidentLifecycle({
    minZones: options.minZones,
    closeGraceMs: options.closeGraceMs
  });

  const run: LifecycleRun = {
    trace: [],
    events: [],
    violations: [],
    steps: 0,
    checks: 0,
    opened: 0,
    grew: 0,
    shrank: 0,
    merged: 0,
    closed: 0,
    splitOpens: 0,
    supersededCloses: 0,
    graceCloses: 0,
    dissolvedCloses: 0,
    revivals: 0,
    maxIncidentMembers: 0,
    maxConcurrentIncidents: 0
  };

  /** Ids seen in an OPENED, and ids seen in a CLOSED: an id must never come back from the dead. */
  const everOpened = new Set<string>();
  const everClosed = new Set<string>();
  const draining = new Set<string>();

  let eventTime = BASE_EVENT_TIME;
  const history: string[] = [];

  for (const event of events) {
    eventTime = Math.max(BASE_EVENT_TIME, eventTime + event.dt);

    switch (event.kind) {
      case 'degrade': {
        const zone = zoneIdOf(event.zone);
        window.admit(zone, eventTime);
        if (window.isActive(zone)) {
          connectivity.activate(zone);
        }
        history.push(`degrade ${zone} @${eventTime - BASE_EVENT_TIME}`);
        break;
      }
      case 'recover': {
        const zone = zoneIdOf(event.zone);
        window.release(zone, eventTime);
        connectivity.deactivate(zone);
        history.push(`recover ${zone} @${eventTime - BASE_EVENT_TIME}`);
        break;
      }
      case 'tick': {
        connectivity.compact(window.tick(eventTime));
        history.push(`tick @${eventTime - BASE_EVENT_TIME}`);
        break;
      }
    }

    const emitted = incidents.reconcile(connectivity.components(), eventTime);
    run.steps++;

    for (const incidentEvent of emitted) {
      run.events.push(incidentEvent);
      run.trace.push(JSON.stringify(incidentEvent));
      tallyEvent(run, incidentEvent, everOpened, everClosed, draining);
      for (const violation of checkEventShape(incidentEvent, everOpened, everClosed)) {
        run.violations.push(`${violation}\n  after: ${history[history.length - 1]}`);
      }
    }

    run.checks++;
    for (const violation of checkInvariants(window, connectivity, incidents, adjacency, options)) {
      run.violations.push(
        [violation, `  after: ${history[history.length - 1]}`, ...history.map((h) => `    ${h}`)].join(
          '\n'
        )
      );
    }

    run.maxConcurrentIncidents = Math.max(run.maxConcurrentIncidents, incidents.size);
    for (const snapshot of incidents.activeIncidents()) {
      run.maxIncidentMembers = Math.max(run.maxIncidentMembers, snapshot.memberCount);
    }

    if (run.violations.length > 0) {
      break;
    }
  }

  return run;
}

function tallyEvent(
  run: LifecycleRun,
  event: IncidentEvent,
  everOpened: Set<string>,
  everClosed: Set<string>,
  draining: Set<string>
): void {
  switch (event.type) {
    case 'OPENED':
      run.opened++;
      everOpened.add(event.incidentId);
      if (event.splitFrom !== undefined) {
        run.splitOpens++;
      }
      break;
    case 'GREW':
      run.grew++;
      if (draining.has(event.incidentId) && event.status === 'OPEN') {
        run.revivals++;
      }
      break;
    case 'SHRANK':
      run.shrank++;
      break;
    case 'MERGED':
      run.merged++;
      break;
    case 'CLOSED':
      run.closed++;
      everClosed.add(event.incidentId);
      if (event.closeReason === 'SUPERSEDED') run.supersededCloses++;
      if (event.closeReason === 'GRACE_EXPIRED') run.graceCloses++;
      if (event.closeReason === 'DISSOLVED') run.dissolvedCloses++;
      break;
  }

  if (event.type === 'CLOSED') {
    draining.delete(event.incidentId);
  } else if (event.status === 'DRAINING') {
    draining.add(event.incidentId);
  } else {
    draining.delete(event.incidentId);
  }
}

/** Per-event shape rules: an id is born once, dies once, and says nothing after it dies. */
function checkEventShape(
  event: IncidentEvent,
  everOpened: Set<string>,
  everClosed: Set<string>
): string[] {
  const violations: string[] = [];
  const id = event.incidentId;

  if (!/^INC-[0-9a-f]{16}$/.test(id)) {
    violations.push(`malformed incident id ${id}`);
  }
  if (event.type !== 'OPENED' && !everOpened.has(id)) {
    violations.push(`${event.type} for ${id}, which was never OPENED`);
  }
  if (event.type !== 'CLOSED' && everClosed.has(id)) {
    violations.push(`${event.type} for ${id} after it was CLOSED`);
  }
  if (event.memberCount !== event.members.length) {
    violations.push(`${id}: memberCount ${event.memberCount} != members ${event.members.length}`);
  }
  if (event.members.join(',') !== [...event.members].sort().join(',')) {
    violations.push(`${id}: members not sorted`);
  }
  if (event.type === 'CLOSED' && event.closeReason === undefined) {
    violations.push(`${id}: CLOSED without a reason`);
  }
  if ((event.supersededBy !== undefined) !== (event.closeReason === 'SUPERSEDED')) {
    violations.push(`${id}: supersededBy and SUPERSEDED must come together`);
  }
  if (event.mergedFrom !== undefined && event.type !== 'MERGED') {
    violations.push(`${id}: mergedFrom on a ${event.type}`);
  }
  return violations;
}

/**
 * The four structural invariants, checked against the state the three components jointly hold.
 *
 * The reachability oracle below is a plain BFS written here rather than a call to
 * `NaiveConnectivity`. It is the same algorithm, and that is the point: this test must be able to
 * fail if *both* connectivity implementations are wrong in the same way, which a comparison
 * between them cannot do.
 */
export function checkInvariants(
  window: CorrelationWindow,
  connectivity: TimeAwareConnectivity,
  incidents: IncidentLifecycle,
  adjacency: AdjacencyProvider,
  options: { minZones: number; closeGraceMs: number }
): string[] {
  const violations: string[] = [];
  const active = window.activeMembers();
  const activeSet = new Set(active);
  const partition = connectivity.components();

  // --- every active zone is in exactly one component ----------------------------------------
  const placements = new Map<string, number>();
  partition.forEach((component, index) => {
    for (const zone of component) {
      if (placements.has(zone)) {
        violations.push(`zone ${zone} is in two components`);
      }
      placements.set(zone, index);
      if (!activeSet.has(zone)) {
        violations.push(`zone ${zone} is in a component but is not an active member`);
      }
    }
  });
  for (const zone of active) {
    if (!placements.has(zone)) {
      violations.push(`active zone ${zone} is in no component`);
    }
  }

  // --- two zones share a component iff a path of active adjacent zones connects them ---------
  const expected = reachabilityPartition(active, adjacency);
  if (describePartition(partition) !== describePartition(expected)) {
    violations.push(
      `partition disagrees with reachability\n    got      ${describePartition(partition)}` +
        `\n    expected ${describePartition(expected)}`
    );
  }

  // --- incidents sit exactly on components --------------------------------------------------
  const componentKeys = new Set(partition.map((component) => component.join(',')));
  const covered = new Set<string>();
  const claimed = new Map<string, string>();

  for (const snapshot of incidents.activeIncidents()) {
    const key = snapshot.members.join(',');
    if (!componentKeys.has(key)) {
      violations.push(`incident ${snapshot.incidentId} members [${key}] are not a component`);
    }
    if (covered.has(key)) {
      violations.push(`component [${key}] is claimed by two incidents`);
    }
    covered.add(key);

    for (const zone of snapshot.members) {
      if (claimed.has(zone)) {
        violations.push(`zone ${zone} is claimed by two incidents`);
      }
      claimed.set(zone, snapshot.incidentId);
      if (incidents.incidentOf(zone) !== snapshot.incidentId) {
        violations.push(`incidentOf(${zone}) disagrees with the incident's own member list`);
      }
    }

    // --- no OPEN incident is below the minimum ----------------------------------------------
    if (snapshot.status === 'OPEN' && snapshot.memberCount < options.minZones) {
      violations.push(
        `incident ${snapshot.incidentId} is OPEN with ${snapshot.memberCount} members`
      );
    }
    if (snapshot.status === 'DRAINING') {
      if (snapshot.memberCount >= options.minZones) {
        violations.push(
          `incident ${snapshot.incidentId} is DRAINING with ${snapshot.memberCount} members`
        );
      }
      if (snapshot.belowMinSince === null) {
        violations.push(`incident ${snapshot.incidentId} is DRAINING without belowMinSince`);
      } else if (incidents.watermark - snapshot.belowMinSince >= options.closeGraceMs) {
        violations.push(
          `incident ${snapshot.incidentId} outlived its grace period by ` +
            `${incidents.watermark - snapshot.belowMinSince - options.closeGraceMs}ms`
        );
      }
    }
    if (snapshot.status === 'CLOSED') {
      violations.push(`incident ${snapshot.incidentId} is CLOSED but still live`);
    }
    if (snapshot.memberCount === 0) {
      violations.push(`incident ${snapshot.incidentId} is live with no members`);
    }
  }

  // Every component at or above the minimum must be somebody's incident. Without this, the
  // invariants above would all hold for a lifecycle that simply never opened anything.
  for (const component of partition) {
    if (component.length >= options.minZones && !covered.has(component.join(','))) {
      violations.push(`component [${component.join(',')}] reached the minimum but has no incident`);
    }
  }

  return violations;
}

/** Components of the subgraph induced on the active members, by BFS. The independent oracle. */
function reachabilityPartition(active: readonly string[], adjacency: AdjacencyProvider): string[][] {
  const remaining = new Set(active);
  const components: string[][] = [];

  for (const start of active) {
    if (!remaining.has(start)) {
      continue;
    }
    remaining.delete(start);

    const component = [start];
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const neighbour of adjacency.neighboursOf(queue[head])) {
        if (remaining.has(neighbour)) {
          remaining.delete(neighbour);
          component.push(neighbour);
          queue.push(neighbour);
        }
      }
    }
    components.push(component.sort());
  }

  return components;
}
