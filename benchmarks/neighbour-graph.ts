/**
 * WP1: does the H3 neighbour graph actually buy anything over just measuring distances?
 *
 * Run from the spatial package so its node_modules resolve. NODE_PATH is needed as well as the
 * working directory because this file sits outside the package, so Node would otherwise look
 * for h3-js in benchmarks/node_modules and the repo root, neither of which exists:
 *
 *   cd packages/spatial && NODE_PATH=./node_modules \
 *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}' \
 *     ../../benchmarks/neighbour-graph.ts | tee ../../benchmarks/results/wp1-neighbour-graph.txt
 *
 * The claim WP1 has to support is that `neighboursOf` is O(1) in the total zone count, against
 * O(n) for the obvious alternative — a haversine scan over every zone, which is what this
 * codebase would have had to do before WP1 because lat/lon was stored and never indexed.
 *
 * Two series, because "flat vs linear" is only half the story:
 *
 *   constant density — the region grows with the fleet, so each zone has the same number of
 *     neighbours at 1k as at 100k. This is the honest scaling question: adding sensors to a
 *     country does not make any one sensor's neighbourhood more crowded. The graph should be
 *     flat here and the scan should be linear.
 *
 *   constant area — the same patch of ground, more and more zones in it. Neighbourhoods get
 *     genuinely denser, so the graph *should* get slower: it pays for the size of the answer.
 *     Reporting only the first series would be picking the flattering half of the result.
 *
 * The baseline is a plain scan with no index, which is the thing being replaced. A k-d tree or
 * R-tree is a more serious alternative and it is argued against in
 * docs/adr/ADR-001-h3-vs-alternatives.md on semantics and churn rather than measured here —
 * adding a spatial-index dependency to measure a design that was rejected for other reasons
 * would earn its keep in neither direction (CLAUDE.md rule 5).
 *
 * The geometry section at the end exists so that every number ADR-001 quotes — hexagon
 * equidistance, res-5 cell area spread, what a one-ring neighbourhood means in kilometres —
 * comes out of this committed script rather than out of a blog post (CLAUDE.md rule 1).
 *
 * Zone placement is deterministic (seeded splitmix32, no Math.random) so the fields are
 * identical between runs. The timings are not deterministic and are not meant to be; they are
 * wall-clock measurements on one machine, and the shape of the curve is the result, not the
 * absolute microseconds.
 */
import {
  cellArea,
  cellToLatLng,
  getHexagonAreaAvg,
  getHexagonEdgeLengthAvg,
  getPentagons,
  getResolution,
  gridDisk,
  gridDistance,
  isPentagon,
  latLngToCell
} from 'h3-js';
import { NeighbourGraph, ZoneLocation } from '../packages/spatial/src/neighbourGraph';
import { haversineKm } from '../packages/spatial/src/geo';

const RESOLUTION = 5;
const RING_SIZE = 1;

/** Reach of a one-ring res-5 neighbourhood, and so the radius the naive scan is asked for. */
const NAIVE_RADIUS_KM = 25;

const ZONE_COUNTS = [1_000, 10_000, 100_000];

/**
 * Zones per km², taken from the project's own reference config: 400 zones over a 400 km square
 * (docs/03-MEASUREMENT.md §2.1, and the `regional-grid` layout the eval scenarios use).
 */
const REFERENCE_DENSITY = 400 / (400 * 400);

/** The constant-area series keeps every fleet inside this square. */
const FIXED_SIDE_KM = 400;

const SEED = 42;
const KM_PER_DEGREE = 111.195; // one degree of latitude on a sphere of radius 6371.0088 km

/** Deterministic PRNG: splitmix32, the same generator the simulator uses. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 0x100000000;
  };
}

/**
 * A field of zones `sideKm` on a side, centred on the equator.
 *
 * The longitude spread is divided by cos(latitude) so that the east-west extent is `sideKm` on
 * every row rather than `sideKm` only at the equator. Without that, the 100k field — which
 * spans ±28° — would be 13% denser in zones per km² at its edges than at its middle, and part
 * of the neighbour count would be an artefact of the placement rather than a property of the
 * grid.
 */
function field(count: number, sideKm: number, seed: number): ZoneLocation[] {
  const next = prng(seed);
  const halfDeg = sideKm / 2 / KM_PER_DEGREE;
  const zones: ZoneLocation[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const latitude = (next() * 2 - 1) * halfDeg;
    const halfLonDeg = halfDeg / Math.cos((latitude * Math.PI) / 180);
    zones[i] = {
      zoneId: `Z-${i}`,
      latitude,
      longitude: (next() * 2 - 1) * halfLonDeg
    };
  }
  return zones;
}

/**
 * The pre-WP1 alternative: no index at all, measure the distance to every zone.
 *
 * Kept deliberately plain. It is the implementation someone writes when lat/lon is in the
 * record and there is nothing else to work with.
 */
function naiveNeighbours(zones: readonly ZoneLocation[], self: ZoneLocation, radiusKm: number): string[] {
  const found: string[] = [];
  for (let i = 0; i < zones.length; i++) {
    const other = zones[i];
    if (other.zoneId === self.zoneId) {
      continue;
    }
    if (haversineKm(self, other) <= radiusKm) {
      found.push(other.zoneId);
    }
  }
  return found;
}

function microsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1000;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

interface Row {
  series: string;
  count: number;
  sideKm: number;
  buildMs: number;
  graphUs: number;
  naiveUs: number;
  speedup: number;
  graphNeighbours: number;
  naiveNeighbours: number;
  /** Mean area of the cells the zones actually landed in. Explains the neighbour counts. */
  cellAreaKm2: number;
  recall: number;
  precision: number;
}

function measure(series: string, count: number, sideKm: number): Row {
  const zones = field(count, sideKm, SEED);

  const graph = new NeighbourGraph({ resolution: RESOLUTION, ringSize: RING_SIZE });
  const buildStart = process.hrtime.bigint();
  graph.build(zones);
  const buildMs = microsSince(buildStart) / 1000;

  // Query zones are sampled across the field rather than taken from the front of the array, so
  // the sample is not all from one corner of the region and one corner of the hash table.
  const sampleCount = 200;
  const stride = Math.max(1, Math.floor(count / sampleCount));
  const sample: ZoneLocation[] = [];
  for (let i = 0; i < count && sample.length < sampleCount; i += stride) {
    sample.push(zones[i]);
  }

  // Warm up both paths: the first calls pay for JIT and for filling the disk cache, and
  // neither is what is being compared.
  for (const z of sample) {
    graph.neighboursOf(z.zoneId);
    naiveNeighbours(zones, z, NAIVE_RADIUS_KM);
  }

  // The graph is microseconds per call, so each sampled zone is queried many times and the
  // per-call cost is the total divided out. The scan is milliseconds per call at 100k, so once
  // per zone is plenty.
  const graphRepeats = 200;
  const graphStart = process.hrtime.bigint();
  let graphSink = 0;
  for (let r = 0; r < graphRepeats; r++) {
    for (const z of sample) {
      graphSink += graph.neighboursOf(z.zoneId).length;
    }
  }
  const graphUs = microsSince(graphStart) / (graphRepeats * sample.length);

  const naiveStart = process.hrtime.bigint();
  let naiveSink = 0;
  for (const z of sample) {
    naiveSink += naiveNeighbours(zones, z, NAIVE_RADIUS_KM).length;
  }
  const naiveUs = microsSince(naiveStart) / sample.length;

  // Agreement. These two answer different questions — "in an adjacent cell" is not "within
  // 25 km" — and the gap is a property of the design, not an error, so it is reported rather
  // than asserted away. Recall is the fraction of the 25 km circle the hex disk covers;
  // precision is the fraction of the hex disk that falls inside the circle.
  let truePositives = 0;
  let graphTotal = 0;
  let naiveTotal = 0;
  for (const z of sample) {
    const hex = new Set(graph.neighboursOf(z.zoneId));
    const circle = new Set(naiveNeighbours(zones, z, NAIVE_RADIUS_KM));
    graphTotal += hex.size;
    naiveTotal += circle.size;
    for (const id of circle) {
      if (hex.has(id)) {
        truePositives++;
      }
    }
  }

  if (graphSink < 0 || naiveSink < 0) {
    throw new Error('unreachable, keeps the optimiser from discarding the measured work');
  }

  // A res-5 cell is 156 km2 in some parts of the world and 305 km2 in others, so the number of
  // neighbours a fixed zone density produces depends on where the field sits. Measured here so
  // that a drift in the neighbour column is explained rather than mysterious.
  let areaSum = 0;
  for (const z of sample) {
    areaSum += cellArea(graph.cellOf(z.zoneId)!, 'km2');
  }

  return {
    series,
    count,
    sideKm,
    buildMs,
    graphUs,
    naiveUs,
    speedup: naiveUs / graphUs,
    graphNeighbours: graphTotal / sample.length,
    naiveNeighbours: naiveTotal / sample.length,
    cellAreaKm2: areaSum / sample.length,
    recall: naiveTotal === 0 ? 1 : truePositives / naiveTotal,
    precision: graphTotal === 0 ? 1 : truePositives / graphTotal
  };
}

function printTable(title: string, note: string, rows: Row[]): void {
  console.log(title);
  console.log(note);
  console.log();
  console.log(
    'zones     region      build     neighboursOf   naive scan     speedup   nbrs/zone   cell    hex vs 25km'
  );
  console.log(
    '                                 us/lookup      us/lookup               hex/circle   km2   recall  prec.'
  );
  for (const r of rows) {
    console.log(
      `${String(r.count).padStart(7)}   ${(Math.round(r.sideKm) + ' km').padStart(8)}   ` +
        `${r.buildMs.toFixed(0).padStart(5)} ms   ${r.graphUs.toFixed(3).padStart(10)}   ` +
        `${r.naiveUs.toFixed(1).padStart(10)}   ${(r.speedup.toFixed(0) + 'x').padStart(8)}   ` +
        `${r.graphNeighbours.toFixed(1).padStart(5)}/${r.naiveNeighbours.toFixed(1).padEnd(6)} ` +
        `${r.cellAreaKm2.toFixed(0).padStart(5)}   ` +
        `${(r.recall * 100).toFixed(1).padStart(5)}%  ${(r.precision * 100).toFixed(1).padStart(5)}%`
    );
  }
  console.log('The hex disk and the 25 km circle are not the same query - a 7-cell disk covers about');
  console.log('7 x the cell area above, the circle covers 1963 km2 - which is what recall and precision');
  console.log('report. It is not a thumb on the scale either way: the scan computes a distance to every');
  console.log('zone whatever the radius, so its cost is set by the fleet size and not by the question.');
  console.log();
}

/**
 * The geometry behind ADR-001. Every figure the ADR quotes is printed here.
 */
function geometry(): void {
  console.log('================================================================');
  console.log('geometry of the chosen grid (the numbers ADR-001 argues from)');
  console.log('================================================================');
  console.log();
  console.log(`H3 resolution ${RESOLUTION}: average edge ${getHexagonEdgeLengthAvg(RESOLUTION, 'km').toFixed(2)} km, ` +
    `average area ${getHexagonAreaAvg(RESOLUTION, 'km2').toFixed(1)} km2`);
  console.log(`ring size ${RING_SIZE}: a neighbourhood of ${1 + 3 * RING_SIZE * (RING_SIZE + 1)} cells ` +
    `(1 + 3k(k+1)), fixed whatever the zone count`);
  console.log();

  const next = prng(SEED);
  // Area-weighted uniform sampling over the sphere: asin of a uniform in [-1, 1], not a uniform
  // latitude, which would over-sample the poles.
  const sampleCell = (): string => {
    const latitude = (Math.asin(next() * 2 - 1) * 180) / Math.PI;
    const longitude = next() * 360 - 180;
    return latLngToCell(latitude, longitude, RESOLUTION);
  };

  // 1. Why hexagons: how equidistant are the six neighbours, really?
  const ratios: number[] = [];
  let worstRatio = 0;
  for (let i = 0; i < 5_000; i++) {
    const cell = sampleCell();
    if (isPentagon(cell)) {
      continue;
    }
    const centre = cellToLatLng(cell);
    const distances = gridDisk(cell, 1)
      .filter((c) => c !== cell)
      .map((c) => {
        const [lat, lon] = cellToLatLng(c);
        return haversineKm(
          { latitude: centre[0], longitude: centre[1] },
          { latitude: lat, longitude: lon }
        );
      });
    if (distances.length !== 6) {
      continue;
    }
    const ratio = Math.max(...distances) / Math.min(...distances);
    ratios.push(ratio);
    worstRatio = Math.max(worstRatio, ratio);
  }
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  console.log('hexagon neighbour equidistance, over ' + ratios.length + ' cells sampled uniformly by area');
  console.log(`  furthest / nearest of the six neighbour centres: median ${median(ratios).toFixed(4)}, ` +
    `mean ${meanRatio.toFixed(4)}, worst ${worstRatio.toFixed(4)}`);
  console.log('  the same ratio on a square grid is exactly 1.4142 for the four diagonal neighbours,');
  console.log('  and it is exact everywhere - it is the grid, not a projection artefact.');
  console.log();

  // 2. Cell area is not uniform. The checkpoint question asks how much and whether it matters.
  let minArea = Infinity;
  let maxArea = 0;
  for (let i = 0; i < 5_000; i++) {
    const area = cellArea(sampleCell(), 'km2');
    minArea = Math.min(minArea, area);
    maxArea = Math.max(maxArea, area);
  }
  const pentagons = getPentagons(RESOLUTION);
  console.log('cell area spread at resolution ' + RESOLUTION + ', 5000 cells sampled uniformly by area');
  console.log(`  min ${minArea.toFixed(1)} km2, max ${maxArea.toFixed(1)} km2, ratio ${(maxArea / minArea).toFixed(2)}`);
  console.log(`  ${pentagons.length} pentagons exist at every resolution; the first is ` +
    `${cellArea(pentagons[0], 'km2').toFixed(1)} km2 with ${gridDisk(pentagons[0], 1).length - 1} neighbours`);
  console.log();

  // 3. What "adjacent" means in kilometres - the envelope, not a radius, because a hexagon
  //    disk is not a circle.
  const envelopeZones = field(1_200, 200, SEED);
  const cells = envelopeZones.map((z) => latLngToCell(z.latitude, z.longitude, RESOLUTION));
  let maxNeighbourKm = 0;
  let minNonNeighbourKm = Infinity;
  for (let i = 0; i < envelopeZones.length; i++) {
    for (let j = i + 1; j < envelopeZones.length; j++) {
      const km = haversineKm(envelopeZones[i], envelopeZones[j]);
      if (gridDistance(cells[i], cells[j]) <= RING_SIZE) {
        maxNeighbourKm = Math.max(maxNeighbourKm, km);
      } else {
        minNonNeighbourKm = Math.min(minNonNeighbourKm, km);
      }
    }
  }
  console.log('what a one-ring neighbourhood means on the ground, over 1200 zones in a 200 km square');
  console.log(`  two zones ${minNonNeighbourKm.toFixed(1)} km apart can already be non-neighbours`);
  console.log(`  two zones ${maxNeighbourKm.toFixed(1)} km apart can still be neighbours`);
  console.log('  so cell adjacency brackets a distance threshold rather than equalling one. Closer than');
  console.log('  the first figure is always adjacent, further than the second never is, and in between it');
  console.log('  depends where the boundary falls. See ADR-001 on why that band is acceptable.');
  console.log();
  console.log(`resolution sanity: every cell above is resolution ${getResolution(latLngToCell(0, 0, RESOLUTION))}`);
  console.log();
}

function main(): void {
  console.log('GeoPulse WP1 - NeighbourGraph vs a naive haversine scan');
  console.log(`generated: ${new Date().toISOString()}`);
  console.log(`node ${process.version} on ${process.platform} ${process.arch}`);
  console.log(`H3 resolution ${RESOLUTION}, ring size ${RING_SIZE}, naive radius ${NAIVE_RADIUS_KM} km, seed ${SEED}`);
  console.log();
  console.log('Zone placement is deterministic. Timings are wall-clock on one machine - the shape of');
  console.log('the curve across zone counts is the result, not the absolute microseconds.');
  console.log();

  const constantDensity: Row[] = [];
  for (const count of ZONE_COUNTS) {
    constantDensity.push(measure('constant-density', count, Math.sqrt(count / REFERENCE_DENSITY)));
  }
  printTable(
    '================================================================\n' +
      'constant density - the region grows with the fleet\n' +
      '================================================================',
    `${(REFERENCE_DENSITY * 10_000).toFixed(0)} zones per 10 000 km2 (a 100 km square) - the density of the\n` +
      'reference config, 400 zones in a 400 km square. Zone density is identical at 1k and at 100k,\n' +
      'so any change in the neighbour column comes from the grid or the edges, not from the fleet size.',
    constantDensity
  );

  const constantArea: Row[] = [];
  for (const count of ZONE_COUNTS) {
    constantArea.push(measure('constant-area', count, FIXED_SIDE_KM));
  }
  printTable(
    '================================================================\n' +
      'constant area - the same ground, packed tighter\n' +
      '================================================================',
    `All fleets inside one ${FIXED_SIDE_KM} km square, so neighbourhoods really do get denser.\n` +
      'The graph is expected to slow down here: it pays for the size of the answer, not for the search.',
    constantArea
  );

  geometry();
}

main();
