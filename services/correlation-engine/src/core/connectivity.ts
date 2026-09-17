/**
 * The contract both connectivity implementations satisfy, and the canonical form their answers
 * are compared in.
 *
 * There are two implementations on purpose. `NaiveConnectivity` recomputes every component from
 * scratch on every query; `TimeAwareConnectivity` maintains them incrementally. The naive one is
 * obviously correct and too slow; the incremental one is fast and subtle. Holding them to one
 * interface is what makes the differential fuzz test possible — the same call sequence goes into
 * both and their partitions must be identical after every single operation.
 */

/**
 * "Which zones are next to this one." Satisfied structurally by `NeighbourGraph` from
 * `@geopulse/spatial`, so the engine passes the real graph and the fuzz test passes a random
 * one without either side knowing the difference.
 *
 * **The relation must be symmetric**: `b ∈ neighboursOf(a)` iff `a ∈ neighboursOf(b)`. Adjacency
 * in H3 is `gridDistance(cell(a), cell(b)) <= k`, and grid distance is symmetric, so
 * `NeighbourGraph` satisfies this — including across the antimeridian and at the twelve
 * pentagons, which `packages/spatial` tests directly. The requirement is stated here because an
 * asymmetric provider would break the equivalence this whole design rests on: the incremental
 * structure unions a joining zone against `neighboursOf(joiner)` only, while a full recompute
 * walks `neighboursOf` from every member, and the two only agree when the relation reads the
 * same in both directions.
 *
 * The relation is also assumed **stable for the lifetime of a member's spell**. Zones are
 * discovered at runtime, so the graph does grow; an edge learned after both of its endpoints
 * last degraded is not seen until one of them degrades again or its component is rebuilt. That
 * can only ever *miss* a merge, never invent one, and it heals on the next degradation — which
 * for a zone that is actively degrading is at most one sample interval away.
 */
export interface AdjacencyProvider {
  neighboursOf(zoneId: string): readonly string[];
}

export interface Connectivity {
  /**
   * Make `zoneId` an active member and link it to every active neighbour. Idempotent: calling
   * it for a zone that is already a member re-runs the linking, which is how an edge learned
   * after the member joined gets picked up.
   */
  activate(zoneId: string): void;

  /** Drop a single member — a recovery. No-op for a zone that is not a member. */
  deactivate(zoneId: string): void;

  /** Drop a batch of members — a compaction tick. Zones that are not members are ignored. */
  compact(expired: readonly string[]): void;

  isMember(zoneId: string): boolean;

  /** Number of active members. */
  readonly size: number;

  /** Whether `a` and `b` are joined by a path of active, pairwise-adjacent members. */
  connected(a: string, b: string): boolean;

  /**
   * The members of `zoneId`'s component, sorted, including `zoneId` itself. Undefined if it is
   * not a member.
   */
  componentOf(zoneId: string): string[] | undefined;

  /** The whole partition, in canonical form. */
  components(): string[][];
}

/**
 * The canonical form of a partition: each component sorted by zone id, and the components
 * themselves sorted by their first member.
 *
 * Two correct implementations can represent the same partition completely differently — one
 * keeps a union-find forest whose root is an accident of merge order, the other a set it walks
 * in whatever order it likes. Canonicalising collapses that freedom so that comparing them is a
 * comparison of the partitions and nothing else. It also gives the engine a replay-stable order
 * to emit in, which WP2b needs for deterministic incident ids.
 */
export function canonicalise(components: string[][]): string[][] {
  const sorted = components.map((component) => [...component].sort());
  // Plain `<` / `>`, not localeCompare: collation depends on locale and ICU build, and this
  // ordering is what WP2b will derive incident ids from. The equal case cannot arise for a
  // genuine partition — components are disjoint, so no two share a first member.
  sorted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sorted;
}

/** A stable string rendering of a partition, for equality assertions and failure messages. */
export function describePartition(components: string[][]): string {
  return canonicalise(components)
    .map((component) => component.join('+'))
    .join(' | ');
}
