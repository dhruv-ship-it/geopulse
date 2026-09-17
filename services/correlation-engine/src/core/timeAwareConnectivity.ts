import { AdjacencyProvider, Connectivity, canonicalise } from './connectivity';

export interface TimeAwareConnectivityStats {
  /** Active members. */
  members: number;
  /** Current number of components. */
  components: number;
  /** Calls to `activate` that made a zone a new member. */
  activations: number;
  /** Calls to `activate` for a zone that was already a member. */
  reactivations: number;
  /** Pairs actually merged. A repeat union of two zones already together is not counted. */
  merges: number;
  /** Members removed by `deactivate` or `compact`. */
  removals: number;
  /** Component rebuilds run. One per component that lost at least one member. */
  rebuilds: number;
  /**
   * Members visited by rebuild BFS, summed over every rebuild. Divided by `rebuilds` this is
   * the average component size being paid for on the expiry path — the number that says whether
   * the "components are small relative to the universe" assumption still holds in production.
   */
  rebuiltMembers: number;
  /** `find` operations served. */
  finds: number;
  /**
   * Parent pointers actually rewritten by path compression. A node already pointing straight at
   * its root is not counted, so a forest that has gone flat stops adding to this.
   */
  compressions: number;
  /**
   * Highest rank among the roots — union by rank's upper bound on tree height, and so an upper
   * bound on how far any `find` can walk. It must stay around log2(members); a value climbing
   * towards the member count would mean the rank rule had stopped working.
   */
  maxRank: number;
}

/** A node in the union-find forest, plus the bookkeeping the expiry path needs. */
interface Node {
  /** Union-find parent. A root points at itself. */
  parent: string;
  /**
   * Union-by-rank height bound. Only meaningful at a root, and it is an upper bound on the tree
   * height rather than the height itself, because path compression flattens trees without ever
   * lowering a rank.
   */
  rank: number;
  /**
   * Next member in this component's circular list. Every component's members form exactly one
   * cycle, so from any member you can walk the whole component and get back where you started.
   *
   * This is the piece that makes local rebuild possible. Union-find on its own can tell you
   * whether two zones are together but not *who else* is in there with them, and the expiry
   * path needs precisely that: the survivors of the component that just lost a member. The
   * alternative — a `Map<root, Set<member>>` — has to move a set on every union, which is
   * O(size) unless you also switch to union by size. Splicing two cycles is two pointer writes,
   * O(1), and stays independent of which root union by rank happened to pick.
   */
  next: string;
}

/**
 * Connected components of the active members, maintained incrementally.
 *
 * ## The problem
 *
 * Union-find is the right structure for the arrival path: a degradation arrives, the zone joins,
 * and it merges with each active neighbour in near-constant amortised time. What union-find does
 * not have is a delete. There is no way to undo a union, because the structure deliberately
 * threw away the information needed to do so — it records only *that* two elements ended up
 * together, never which edge put them there. Remove the hub of a star and the remaining spokes
 * still point at it; there is nothing in the forest that says whether they were connected
 * through the hub or to each other.
 *
 * Our members expire. `CORRELATION_WINDOW_MS` after its last degradation, a zone stops counting,
 * and a component can fall apart. So delete is not optional.
 *
 * ## The resolution
 *
 * Keep union-find on the hot path and rebuild on the cold one, but rebuild *locally*:
 *
 * - **Arrival** (`activate`): make-set, then union with each active neighbour. Path compression
 *   and union by rank, so a chain of merges across a spreading regional fault stays effectively
 *   flat.
 * - **Expiry** (`compact`) and **recovery** (`deactivate`): find which components lost a member,
 *   tear down *only those*, and rediscover their internal structure with a BFS over the
 *   survivors. A component that lost nothing is not touched, not walked, not read.
 *
 * The cost of a removal batch is therefore O(V + E) summed over the *affected* components, not
 * over the active set. That is the whole design, and it is justified by two facts about the
 * workload rather than by asymptotics in the abstract:
 *
 * 1. **Arrivals vastly outnumber expiries.** A degrading zone re-degrades on every sample
 *    interval (1 s) while the window is 120 s, so a member that stays unhealthy is refreshed
 *    ~120 times for each time it leaves.
 * 2. **Components are small relative to the universe.** An incident covers tens of zones out of
 *    a fleet of thousands. Rebuilding one is cheap; rebuilding all of them, every tick, is the
 *    thing we are avoiding. `stats().rebuiltMembers / rebuilds` is the measurement that keeps
 *    this claim honest if the workload ever changes.
 *
 * The alternative that makes deletes genuinely cheap is fully dynamic connectivity —
 * Holm–de Lichtenberg–Thorup, or Euler-tour / link-cut trees — at O(log² n) amortised per update.
 * It is rejected here, and the rejection is recorded in `docs/adr/ADR-002-time-aware-connectivity.md`:
 * it is a large amount of intricate machinery to avoid a rebuild whose measured input is a few
 * dozen zones a few times a minute.
 *
 * ## Correctness
 *
 * Incremental structures fail in ways unit tests do not think to try, so this one is not argued
 * to be correct — it is tested against `NaiveConnectivity`, which recomputes everything from
 * scratch, over 10,000 randomised event sequences with the partitions compared after every
 * single operation. See `differentialFuzz.test.ts`.
 *
 * ## Determinism
 *
 * No clock, no randomness (CLAUDE.md rule 3). Rebuild visits survivors in sorted order rather
 * than in whatever order the circular list happens to hold them, so a rebuild is a function of
 * the surviving member set and the adjacency alone — not of the merge history that produced the
 * component. Replaying the same event sequence therefore yields the same partition, in the same
 * order, every time.
 */
export class TimeAwareConnectivity implements Connectivity {
  private readonly nodes = new Map<string, Node>();

  private activations = 0;
  private reactivations = 0;
  private merges = 0;
  private removals = 0;
  private rebuilds = 0;
  private rebuiltMembers = 0;
  private finds = 0;
  private compressions = 0;

  constructor(private readonly adjacency: AdjacencyProvider) {}

  /**
   * Make `zoneId` an active member and union it with every active neighbour.
   *
   * Idempotent, and deliberately not short-circuited for an existing member. Re-running the
   * unions is how an edge the graph learned late gets picked up: zones are discovered at
   * runtime, so a neighbour may have been unknown when this zone first degraded. A zone that is
   * actively degrading re-activates on every sample, so the repair arrives within one sample
   * interval. The unions themselves are no-ops when nothing changed — one `find` each.
   */
  activate(zoneId: string): void {
    if (this.nodes.has(zoneId)) {
      this.reactivations++;
    } else {
      this.makeSet(zoneId);
      this.activations++;
    }

    for (const neighbour of this.adjacency.neighboursOf(zoneId)) {
      if (neighbour !== zoneId && this.nodes.has(neighbour)) {
        this.union(zoneId, neighbour);
      }
    }
  }

  /** Drop one member — a recovery. Same machinery as expiry; a removal is a removal. */
  deactivate(zoneId: string): void {
    this.removeMembers([zoneId]);
  }

  /** Drop a batch of members — a compaction tick. */
  compact(expired: readonly string[]): void {
    this.removeMembers(expired);
  }

  isMember(zoneId: string): boolean {
    return this.nodes.has(zoneId);
  }

  get size(): number {
    return this.nodes.size;
  }

  connected(a: string, b: string): boolean {
    if (!this.nodes.has(a) || !this.nodes.has(b)) {
      return false;
    }
    return this.find(a) === this.find(b);
  }

  componentOf(zoneId: string): string[] | undefined {
    if (!this.nodes.has(zoneId)) {
      return undefined;
    }
    return this.walkComponent(zoneId).sort();
  }

  components(): string[][] {
    const seen = new Set<string>();
    const components: string[][] = [];

    for (const zoneId of [...this.nodes.keys()].sort()) {
      if (seen.has(zoneId)) {
        continue;
      }
      const component = this.walkComponent(zoneId);
      for (const member of component) {
        seen.add(member);
      }
      components.push(component);
    }

    return canonicalise(components);
  }

  /**
   * The representative of `zoneId`'s component. Exposed for diagnostics only.
   *
   * **Not an incident id.** Which member ends up as root is an artefact of merge order and
   * changes whenever a component is rebuilt, so nothing downstream may key on it. WP2b derives
   * incident identity from the member set instead (ADR-003).
   */
  representativeOf(zoneId: string): string | undefined {
    return this.nodes.has(zoneId) ? this.find(zoneId) : undefined;
  }

  stats(): TimeAwareConnectivityStats {
    let components = 0;
    let maxRank = 0;
    for (const [zoneId, node] of this.nodes) {
      if (node.parent === zoneId) {
        components++;
        maxRank = Math.max(maxRank, node.rank);
      }
    }
    return {
      members: this.nodes.size,
      components,
      activations: this.activations,
      reactivations: this.reactivations,
      merges: this.merges,
      removals: this.removals,
      rebuilds: this.rebuilds,
      rebuiltMembers: this.rebuiltMembers,
      finds: this.finds,
      compressions: this.compressions,
      maxRank
    };
  }

  // ---------------------------------------------------------------------------------------
  // Union-find
  // ---------------------------------------------------------------------------------------

  private makeSet(zoneId: string): void {
    // A fresh member is a root, rank 0, and a cycle of one: its own successor.
    this.nodes.set(zoneId, { parent: zoneId, rank: 0, next: zoneId });
  }

  /**
   * The root of `zoneId`'s tree, with **path compression**: every node walked on the way up is
   * repointed straight at the root, so the next lookup from anywhere on that path is one step.
   *
   * Iterative in two passes rather than recursive. A recursive `find` is shorter but recurses to
   * the depth of the tree, and the whole point of a structure that has to survive an adversarial
   * merge order is not to have a stack depth that depends on the data.
   */
  private find(zoneId: string): string {
    this.finds++;

    let root = zoneId;
    for (;;) {
      const node = this.nodes.get(root)!;
      if (node.parent === root) {
        break;
      }
      root = node.parent;
    }

    let current = zoneId;
    while (current !== root) {
      const node = this.nodes.get(current)!;
      const parent = node.parent;
      if (parent !== root) {
        node.parent = root;
        this.compressions++;
      }
      current = parent;
    }

    return root;
  }

  /**
   * Merge the components of `a` and `b`. Returns false if they were already together.
   *
   * **Union by rank**: the shallower tree is hung under the deeper one, so the depth only grows
   * when two trees of equal rank meet — which is what bounds height at O(log n) before
   * compression, and with compression gives the classic O(α(n)) amortised bound. α is the
   * inverse Ackermann function; it is below 5 for any n that fits in this universe, so the
   * operation is constant time for every practical purpose without actually being constant time.
   *
   * The rank of a node that stops being a root is left in place and simply never read again:
   * rank is only ever consulted at roots, and a non-root can only become a root again by being
   * torn down and re-made by a rebuild, which resets it.
   */
  private union(a: string, b: string): boolean {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) {
      return false;
    }

    const nodeA = this.nodes.get(rootA)!;
    const nodeB = this.nodes.get(rootB)!;

    if (nodeA.rank < nodeB.rank) {
      [rootA, rootB] = [rootB, rootA];
    } else if (nodeA.rank === nodeB.rank) {
      this.nodes.get(rootA)!.rank++;
    }
    this.nodes.get(rootB)!.parent = rootA;

    // Splice the two circular member lists into one. Valid precisely because a and b were in
    // different cycles, which is what rootA !== rootB just established. Uses a and b themselves,
    // not their roots: any member of each cycle will do.
    const nodeOfA = this.nodes.get(a)!;
    const nodeOfB = this.nodes.get(b)!;
    const afterA = nodeOfA.next;
    nodeOfA.next = nodeOfB.next;
    nodeOfB.next = afterA;

    this.merges++;
    return true;
  }

  /** Every member of the component containing `zoneId`, by walking the circular list. */
  private walkComponent(zoneId: string): string[] {
    const members: string[] = [];
    let current = zoneId;
    do {
      members.push(current);
      current = this.nodes.get(current)!.next;
    } while (current !== zoneId);
    return members;
  }

  // ---------------------------------------------------------------------------------------
  // Removal — the expiry path
  // ---------------------------------------------------------------------------------------

  /**
   * Remove `zones` and repair connectivity, touching only the components that lost a member.
   *
   * Three phases, in this order for a reason:
   *
   * 1. **Identify.** Filter to zones that are actually members, and collect the root of each
   *    one's component. Roots are read before anything is modified, so they are all still valid.
   * 2. **Tear down.** For each affected component, walk its circular list to get every member,
   *    then delete all of those nodes. Both the departing members and the survivors go: the
   *    survivors' parent pointers and ranks describe merges that may no longer hold, and there
   *    is no way to tell which ones still do without re-deriving them.
   * 3. **Rebuild.** Re-make the survivors as singletons and BFS over them, unioning as we go.
   *    Only edges between two survivors are followed, which is the definition of the induced
   *    subgraph, which is the definition of the component structure after the removal.
   *
   * Survivors are sorted before the BFS. That costs O(k log k) on a small set and buys something
   * worth more: the rebuilt structure depends only on *who survived*, never on the merge history
   * that produced the component being torn down. Replay stability follows, and so does the
   * property the differential test relies on — that a rebuilt component is indistinguishable
   * from one built fresh.
   */
  private removeMembers(zones: readonly string[]): void {
    const removing = new Set<string>();
    for (const zoneId of zones) {
      if (this.nodes.has(zoneId)) {
        removing.add(zoneId);
      }
    }
    if (removing.size === 0) {
      return;
    }

    // Phase 1: which components are affected. Sorted so the rebuild order is deterministic even
    // though the components are independent of each other.
    const affectedRoots = new Set<string>();
    for (const zoneId of removing) {
      affectedRoots.add(this.find(zoneId));
    }

    for (const root of [...affectedRoots].sort()) {
      // Phase 2: tear the whole component down, departing members and survivors alike.
      const members = this.walkComponent(root);
      const survivors: string[] = [];
      for (const member of members) {
        this.nodes.delete(member);
        if (!removing.has(member)) {
          survivors.push(member);
        }
      }

      if (survivors.length === 0) {
        this.rebuilds++;
        continue;
      }
      survivors.sort();

      // Phase 3: rediscover the structure of the induced subgraph on the survivors.
      const survivorSet = new Set(survivors);
      for (const survivor of survivors) {
        this.makeSet(survivor);
      }

      const visited = new Set<string>();
      for (const start of survivors) {
        if (visited.has(start)) {
          continue;
        }
        visited.add(start);

        const queue: string[] = [start];
        for (let head = 0; head < queue.length; head++) {
          const current = queue[head];
          for (const neighbour of this.adjacency.neighboursOf(current)) {
            if (!survivorSet.has(neighbour) || visited.has(neighbour)) {
              continue;
            }
            visited.add(neighbour);
            this.union(start, neighbour);
            queue.push(neighbour);
          }
        }
      }

      this.rebuilds++;
      this.rebuiltMembers += survivors.length;
    }

    this.removals += removing.size;
  }
}
