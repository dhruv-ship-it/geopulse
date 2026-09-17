import { AdjacencyProvider, Connectivity, canonicalise } from './connectivity';

/**
 * Connected components by brute force: keep a set of active members, and rediscover the whole
 * partition with a fresh graph traversal every time anyone asks.
 *
 * **This is not dead code and it is not a first draft.** It is the oracle the optimised
 * structure is tested against. Its value is that it is obviously right — there is no incremental
 * state to get stale, no merge order to reason about, no expiry path to get wrong. You can read
 * it in a minute and convince yourself it computes connected components, because that is
 * literally all it does: BFS from every unvisited member over the neighbours that are also
 * members.
 *
 * `TimeAwareConnectivity` is the opposite. It is fast because it never recomputes anything it
 * does not have to, and every one of those avoided recomputations is a chance to be subtly
 * wrong in a way no hand-written unit test would think to check. Differential testing turns the
 * obviously-correct implementation into a specification: drive both with the same 10,000
 * randomised sequences and require that their partitions agree after every operation. A unit
 * test checks the cases you imagined; the oracle checks the ones you did not.
 *
 * Cost: `components()` is O(V + E) over the whole active set, recomputed per call, where E is
 * counted over full neighbour lists rather than active ones. That is the thing the optimised
 * version exists to avoid, and keeping the slow version around is what proves the avoidance was
 * safe.
 *
 * No clock and no randomness: members are traversed in sorted order, so the same member set and
 * the same adjacency always yield the same traversal.
 */
export class NaiveConnectivity implements Connectivity {
  private readonly members = new Set<string>();

  constructor(private readonly adjacency: AdjacencyProvider) {}

  activate(zoneId: string): void {
    this.members.add(zoneId);
  }

  deactivate(zoneId: string): void {
    this.members.delete(zoneId);
  }

  compact(expired: readonly string[]): void {
    for (const zoneId of expired) {
      this.members.delete(zoneId);
    }
  }

  isMember(zoneId: string): boolean {
    return this.members.has(zoneId);
  }

  get size(): number {
    return this.members.size;
  }

  connected(a: string, b: string): boolean {
    if (!this.members.has(a) || !this.members.has(b)) {
      return false;
    }
    if (a === b) {
      return true;
    }
    return this.reachableFrom(a).has(b);
  }

  componentOf(zoneId: string): string[] | undefined {
    if (!this.members.has(zoneId)) {
      return undefined;
    }
    return [...this.reachableFrom(zoneId)].sort();
  }

  components(): string[][] {
    const seen = new Set<string>();
    const components: string[][] = [];

    // Sorted, so the partition does not depend on the order members happened to be added in.
    for (const zoneId of [...this.members].sort()) {
      if (seen.has(zoneId)) {
        continue;
      }
      const component = this.reachableFrom(zoneId);
      for (const member of component) {
        seen.add(member);
      }
      components.push([...component]);
    }

    return canonicalise(components);
  }

  /** Every member reachable from `start` over adjacency edges between members, including it. */
  private reachableFrom(start: string): Set<string> {
    const visited = new Set<string>([start]);
    const queue: string[] = [start];

    // Index rather than shift(): shift() on a JS array is O(n), which would make a single BFS
    // quadratic in the component size for no reason.
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const neighbour of this.adjacency.neighboursOf(current)) {
        if (this.members.has(neighbour) && !visited.has(neighbour)) {
          visited.add(neighbour);
          queue.push(neighbour);
        }
      }
    }

    return visited;
  }
}
