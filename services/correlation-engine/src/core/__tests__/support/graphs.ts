import { AdjacencyProvider } from '../../connectivity';

/**
 * Test adjacency: a fixed, explicitly-listed edge set.
 *
 * The connectivity structures take an `AdjacencyProvider` rather than a `NeighbourGraph` so
 * that tests can state the topology they want to exercise directly — a path, a ring, a star, a
 * random graph — instead of hunting for coordinates whose H3 cells happen to produce it. The
 * real `NeighbourGraph` is driven through the same structures separately, in the H3 half of
 * `differentialFuzz.test.ts`.
 *
 * Edges are stored as a **symmetric** closure, because that is the documented contract on
 * `AdjacencyProvider` and a test fixture that quietly violated it would be testing something
 * the production graph never does. Neighbour lists are sorted and deduplicated so the fixture
 * itself contributes no ordering noise to a divergence.
 */
export class StaticAdjacency implements AdjacencyProvider {
  private readonly edges = new Map<string, Set<string>>();
  private cache = new Map<string, string[]>();

  constructor(edges: ReadonlyArray<readonly [string, string]> = []) {
    for (const [a, b] of edges) {
      this.addEdge(a, b);
    }
  }

  addEdge(a: string, b: string): void {
    if (a === b) {
      return; // a self-loop says nothing about connectivity
    }
    this.link(a, b);
    this.link(b, a);
    this.cache.delete(a);
    this.cache.delete(b);
  }

  neighboursOf(zoneId: string): readonly string[] {
    const cached = this.cache.get(zoneId);
    if (cached !== undefined) {
      return cached;
    }
    const neighbours = [...(this.edges.get(zoneId) ?? [])].sort();
    this.cache.set(zoneId, neighbours);
    return neighbours;
  }

  /** Every edge, each pair once, sorted. Used to assert the fixture is what the test meant. */
  edgeList(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [a, neighbours] of this.edges) {
      for (const b of neighbours) {
        if (a < b) {
          out.push([a, b]);
        }
      }
    }
    // Plain comparison, not localeCompare: collation is locale- and ICU-dependent, and a test
    // helper whose ordering varies by machine is the last place to introduce that.
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    out.sort((x, y) => (x[0] === y[0] ? cmp(x[1], y[1]) : cmp(x[0], y[0])));
    return out;
  }

  private link(from: string, to: string): void {
    const existing = this.edges.get(from);
    if (existing === undefined) {
      this.edges.set(from, new Set([to]));
    } else {
      existing.add(to);
    }
  }
}

/** Zone ids are zero-padded so that lexicographic order — what we sort by — reads numerically. */
export function zoneId(index: number): string {
  return `Z-${String(index).padStart(3, '0')}`;
}

export function zoneIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => zoneId(i));
}

/** Z-000 — Z-001 — ... — Z-(n-1). The worst case for a structure that walks chains. */
export function path(n: number): StaticAdjacency {
  const edges: Array<[string, string]> = [];
  for (let i = 0; i + 1 < n; i++) {
    edges.push([zoneId(i), zoneId(i + 1)]);
  }
  return new StaticAdjacency(edges);
}

/** A path with the ends joined: removing any single member leaves the rest connected. */
export function ring(n: number): StaticAdjacency {
  const adjacency = path(n);
  if (n > 2) {
    adjacency.addEdge(zoneId(n - 1), zoneId(0));
  }
  return adjacency;
}

/** Z-000 adjacent to everything else, nothing else adjacent to anything. The classic bridge. */
export function star(n: number): StaticAdjacency {
  const edges: Array<[string, string]> = [];
  for (let i = 1; i < n; i++) {
    edges.push([zoneId(0), zoneId(i)]);
  }
  return new StaticAdjacency(edges);
}

/** A `width` x `height` 4-connected lattice, indexed row-major. Closest to a real zone field. */
export function grid(width: number, height: number): StaticAdjacency {
  const edges: Array<[string, string]> = [];
  const at = (x: number, y: number) => zoneId(y * width + x);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x + 1 < width) {
        edges.push([at(x, y), at(x + 1, y)]);
      }
      if (y + 1 < height) {
        edges.push([at(x, y), at(x, y + 1)]);
      }
    }
  }
  return new StaticAdjacency(edges);
}

/** No edges at all: every member is its own component. */
export function isolated(): StaticAdjacency {
  return new StaticAdjacency();
}
