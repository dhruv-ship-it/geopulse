# ADR-001 — H3 hex cells for adjacency, over geohash, spatial trees and raw distance

**Status.** Accepted (WP1).
**Context.** `docs/02-PHASE-1-CORRELATION.md` WP1. Evidence:
`benchmarks/results/wp1-neighbour-graph.txt` (re-run with `benchmarks/neighbour-graph.ts`).
**Relates to.** ADR-004 (partitioning on coarse H3 cells) depends on this choice. D9
(`docs/01-ARCHITECTURE.md` §3.3) is the defect that made the resolution question concrete.

---

## Context

Phase 1's thesis is that a single zone going critical is noise and the signal is the geometry.
Every part of that rests on one question asked over and over on the hot path:

> a degradation just arrived for zone Z — which other zones are close enough to it that a shared
> cause is plausible?

The old codebase could not answer it. Latitude and longitude were stored on every event and read
by nothing; there was no notion of "near" anywhere in the detection path. So the decision is not
"which spatial library" — it is what *adjacency itself* is going to mean, and that definition
then has to hold identically in two processes (`stream-processor` writes a zone's cell at
registration, the correlation engine builds components out of it) and survive being a Kafka
partition key later.

Three properties matter, in this order:

1. **Constant cost per query as the fleet grows.** One lookup per degradation event. A fleet
   of 100k sensors does not make any one sensor's neighbourhood more crowded, so the lookup
   must not get slower just because there are more zones elsewhere.
2. **Adjacency must not depend on direction.** Incidents have shapes, and WP4 goes on to
   estimate which way one is moving. If "one step north" and "one step north-east" are
   different physical distances, then the measured extent and the estimated velocity of an
   incident both inherit a bias from the grid's orientation.
3. **The address must be a value, not a data structure.** The thing that says where a zone is
   has to be storable in Redis, shippable in a Kafka message and usable as a partition key by a
   process that holds no index at all.

## Decision

**Adjacency is defined by the H3 hexagonal grid: two zones are adjacent when their resolution-5
cells are within `NEIGHBOUR_RING_SIZE` (default 1) grid steps of each other.** `NeighbourGraph`
keeps a `Map<cell, zoneId[]>` occupancy index and answers a query by walking the `gridDisk` of
the zone's own cell — 1 + 3k(k+1) cells, 7 at k=1 — and collecting their occupants.

Measured, at the reference density of 25 zones per 100 km square
(`benchmarks/results/wp1-neighbour-graph.txt`):

| zones | `neighboursOf` | naive haversine scan | speedup |
|---|---|---|---|
| 1 000 | 0.58 µs | 39.6 µs | 68× |
| 10 000 | 0.77 µs | 399.2 µs | 521× |
| 100 000 | 1.03 µs | 4630.7 µs | 4484× |

The graph is flat in the fleet size and the scan is linear in it, which is the whole claim. When
the *density* rises instead — 1k, 10k and 100k zones in the same 400 km square — the graph does
slow down, 0.70 µs to 27.9 µs, because the answer itself grows from 7.6 zones to 771. It pays
for the size of the answer, never for the size of the search.

### Why hexagons, specifically

This is the part that decides between H3 and every rectangular scheme, and it is a property of
the tiling rather than of the library.

On a square grid, a cell has two kinds of neighbour. Four share an edge, at centre distance *d*.
Four share only a corner, at *d*√2 ≈ **1.414 d**. So a grid built out of squares has no
direction-independent notion of "one step":

- take 4-adjacency and a fault spreading diagonally is invisible — two zones 1.1 d apart on a
  diagonal are not neighbours while two zones 1.0 d apart on an axis are;
- take 8-adjacency and the diagonal neighbours are 41% further away than the axial ones, so the
  correlation reach is 41% longer along the diagonals. An incident's measured radius then
  depends on how it happened to be oriented against an arbitrary grid.

A hexagon has exactly one kind of neighbour: six of them, each sharing an edge, each the same
distance from the centre. "One step" means one distance in every direction, so adjacency stops
carrying an orientation.

On a sphere that equidistance is approximate, and the benchmark measures how approximate. Over
5000 res-5 cells sampled uniformly by area, the ratio of the furthest to the nearest of the six
neighbour centres is **median 1.045, mean 1.053, worst 1.207**. The square grid's 1.4142 is not
a distortion that a better projection would reduce — it is exactly what a square is. A bounded
few-percent projection artefact, worst case 21%, is a different class of error from a
structural 41% that is present everywhere and in a fixed set of directions.

There is a second, quieter reason: hexagon neighbourhoods approximate a disc better than square
ones do. A ring of six hexagons is closer to a circle than a ring of eight squares, so growing k
grows the reach more evenly.

### Why resolution 5

Res 5: average edge 9.85 km, average area 252.9 km², one-ring neighbourhood therefore about
20–30 km of reach. Chosen against two measured constraints, not picked for roundness:

- **Not finer**, because the zones have to be able to reach each other. D9 killed the original
  global zone layout precisely here: at 5000 zones on a fibonacci spiral the closest pair was
  160 km apart and **zero** pairs fell within a res-5 ring, so every component would have been
  a singleton and the engine would have measured as broken while being correct
  (`benchmarks/results/d9-zone-spacing.txt`). The replacement `regional-grid` layout has a
  median nearest-neighbour distance of 15.7 km at 400 zones — comfortably inside a one-ring
  reach, and that margin is what a finer resolution would spend.
- **Not coarser**, because the whole output is a count of incidents. At res 3 (≈69 km edge) a
  one-ring neighbourhood spans roughly 200 km, which is wider than the 84 km reference anomaly
  radius in `docs/03-MEASUREMENT.md` §2.1. Two genuinely unrelated faults 150 km apart would
  merge into one incident, the `multi-anomaly` eval scenario — which exists exactly to catch
  over-grouping — would fail, and the headline collapse ratio would look *better* while being
  less true.

Resolution is configuration (`H3_RESOLUTION`), so this is a default rather than a constant, but
changing it changes what an incident is and invalidates every measured number taken before it.

### Non-uniform cells, and what that costs

H3 tiles an icosahedron, so cells are not equal in area. Measured over 5000 res-5 cells sampled
uniformly by area: **156.4 km² to 305.1 km², a ratio of 1.95**. Twelve cells per resolution are
pentagons with five neighbours rather than six (the first is 127.8 km²) — an icosahedron cannot
be tiled by hexagons alone.

That variation is visible in the benchmark rather than theoretical. In the constant-density
series the neighbour count climbs from 2.9 to 4.2 while the zone density is fixed, tracking the
mean area of the cells the field landed in (188 → 257 km²): the same density of sensors produces
a different neighbourhood size depending on where on the icosahedron the region sits.

It is acceptable here because the thing being detected is a *shared cause*, not a radius. The
correlation engine asks whether degrading zones form a connected blob, and a blob is connected
or not under a ±20% wobble in what "adjacent" means — an anomaly is either covering a
neighbourhood of sensors or it is not. Where it would not be acceptable is a claim of the form
"incidents within X km", and this project does not make one: the eval scores against injected
ground truth (`docs/03-MEASUREMENT.md`), not against a distance.

The pentagons are handled rather than hoped about: `gridDisk` is used and not the
`gridRing*Unsafe` variants, which throw when a traversal meets one, and there is a test that
places a zone inside a pentagon.

## Alternatives considered

### Geohash

Rejected. Same family of problems as any rectangular grid, plus two of its own.

- **Direction-dependent adjacency, worse than squares.** A geohash cell is not even square: each
  character alternates which axis it subdivides, so cells are 2:1 at odd precisions and roughly
  1:1 at even ones. The eight neighbours therefore sit at three different distances.
- **The cell's ground size depends on latitude.** Geohash is a lat/lon grid, so a cell's
  east-west extent shrinks with cos(latitude): a precision-6 cell is ~1.2 km wide at the equator
  and ~0.6 km wide at 60°N. "One cell away" would mean half the ground distance in Norway that
  it means in Kenya — for a system whose output is the geographic extent of an incident, that is
  a bias baked into the coordinate system. H3's area variation is 1.95× and icosahedral, with no
  systematic latitude trend of that kind.
- **Neighbour computation is string surgery with special cases.** Finding the eight neighbours
  of a geohash means the classic borders/neighbours lookup-table algorithm, with explicit cases
  at the ±180 seam and at the poles. `gridDisk` has neither. The WP1 tests put zones at
  lon ±179.98 (same cell, 4.4 km apart on the ground, 359.96° apart in the coordinate) and at
  89.9°N across 0°/90°/180° of longitude, and the graph needs no code of its own for either.
- **What geohash has that H3 lacks**, in fairness: a geohash is a sortable prefix, so proximity
  becomes a range scan in any ordered key-value store. That is a real advantage for a
  disk-resident index. This system holds occupancy in memory and needs adjacency rather than
  prefix ranges, so it buys nothing here.

### k-d tree / R-tree KNN

Rejected, and on semantics before performance.

- **"k nearest" is the wrong question.** The correlation question is "everyone within reach",
  which is a radius query, not a KNN query. There is no defensible k: the benchmark's own fields
  have neighbourhoods of 2.9 zones at one density and 771 at another. A fixed k truncates a real
  incident in a dense city and invents adjacency between zones 200 km apart in a sparse region —
  and the second failure is the dangerous one, because it manufactures the exact signal the
  system claims to detect.
- **Radius queries on a tree are the more expensive mode**, O(log n + m) with poor cache
  locality, against a handful of hash lookups whose cost does not depend on n at all.
- **Churn.** Zones appear at runtime — `stream-processor` registers a zone the first time it
  sees an event from it, so the correlation engine discovers zones while running. k-d trees do
  not rebalance under insertion; keeping one healthy means periodic O(n log n) rebuilds, and a
  rebuild on the hot path of a live consumer is a latency cliff. `addZone` here is a hash-map
  push, and the disk cache never needs invalidating because which cells surround a cell is pure
  geometry that no insertion can change.
- **A tree is not a value.** This is the decisive one for a distributed system. An H3 cell is a
  64-bit id: it goes in the Redis registry, travels in the Kafka message, and becomes the
  partition key at a coarser resolution (ADR-004) so that an incident's events land in one
  partition. A tree lives in one process's heap and cannot be any of those things. Choosing H3
  buys an addressing scheme, and only incidentally an index.

### Raw haversine scan, no index

Rejected — this is the measured baseline. 4630.7 µs per lookup at 100k zones, against 1.03 µs,
on one lookup per degradation event. A modest incident storm of a thousand degradations a second
would need 4.6 seconds of CPU per second to answer "who is nearby" and nothing else. It is also
what the codebase had before WP1, which is to say: it stored the coordinates and never used
them.

### Exact distance cut on top of the cell disk (deferred, not rejected)

Not adopted now, and worth recording because it is cheap and the obvious upgrade. The cell disk
could serve as a candidate filter, followed by an exact haversine test against a radius — 7
cells' worth of candidates, so a handful of distance computations rather than n.

It is deferred because it adds a second tunable (the radius) alongside the resolution, and
nothing yet shows the fuzziness costs anything. The trigger for revisiting is explicit: if WP6b
shows incident extent or the propagation vector biased by cell alignment, the filter-then-verify
version is a small change to `neighboursOf`, and the benchmark already measures the gap it would
close — against a true 25 km circle, cell adjacency scores 63–76% recall at 86–96% precision.

## Consequences

- **Adjacency is now configuration, and a disagreement about it is silent.** Two resolutions do
  not conflict; res-5 and res-6 ids are both valid, just in different tilings, so a mismatch
  yields empty lookups, singleton components, and a system calmly reporting that nothing in the
  world is correlated. That is why the definition lives in one shared package rather than being
  copied per service, and why `NeighbourGraph` recomputes — and counts, in
  `stats().recomputedCells` — any stored cell that arrives at the wrong resolution instead of
  trusting it.
- **Adjacency brackets a distance rather than equalling one.** Measured over 1200 zones in a
  200 km square: two zones **9.2 km** apart can already be non-adjacent, while two zones
  **31.7 km** apart can still be adjacent, depending on where the cell boundaries fall. Closer
  than the first is always adjacent; further than the second never is. Every claim about incident
  extent inherits that band, which is one more reason the eval scores against injected ground
  truth rather than against a radius.
- **The two zones 500 m apart on opposite sides of a boundary are fine, and that is the point of
  the ring.** They land in adjacent cells, and adjacent cells are inside the k=1 disk, so they
  are neighbours. The discontinuity does not disappear — it moves out to the edge of the ring,
  where it acts on pairs 9–32 km apart. Pushing it further out means raising k, which widens the
  reach everywhere; it is a choice about where the seam sits, never about removing it.
- **WP4 must compute propagation from zone coordinates, not from cell centroids.** Neighbouring
  cell centres are up to 20% unevenly spaced on the sphere, so a velocity estimated from centroid
  hops would carry that anisotropy into a number reported in km/h.
- **The zone registry is now load-bearing.** The graph is built from `zones:registry`, so a zone
  that never degrades still has to be registered — which is why WP0 made registration separate
  from state transitions.
- **A build step.** Consumers depend on the package's compiled output through
  `file:../../packages/spatial`, so it must be built before a service compiles. `npm install`
  does it via `prepare`.
