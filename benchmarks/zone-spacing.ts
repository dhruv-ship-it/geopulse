/**
 * D9: are the simulated zones close enough together for spatial correlation to exist at all?
 *
 * Run from the simulator service so its node_modules resolve:
 *   cd services/sensor-simulator && \
 *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}' \
 *     ../../benchmarks/zone-spacing.ts | tee ../../benchmarks/results/d9-zone-spacing.txt
 *
 * The question this answers is not cosmetic. Phase 1's entire thesis is "a single sensor going
 * critical is noise, the signal is the geometry" — which presupposes that zones have neighbours.
 * H3 at resolution 5 has an edge of roughly 8 km, so a one-ring neighbourhood reaches about
 * 25 km. If no two zones are ever that close, then `neighboursOf` returns the empty set for
 * every zone, every connected component is a singleton, every incident contains exactly one
 * zone, and the collapse ratio is exactly zero — not because the correlation engine is wrong,
 * but because there was nothing there to correlate.
 *
 * The original fibonacci-spiral layout spreads zones over the entire planet. This measures how
 * far apart that actually puts them, against the regional layout added for the eval scenarios,
 * at the zone counts the project plans to run at.
 *
 * Deterministic and instant: both layouts are pure functions, so nothing is sampled or timed.
 */
import { ZoneGenerator } from '../services/sensor-simulator/src/zoneGenerator';
import { haversineKm } from '../services/sensor-simulator/src/geo';
import { ZoneConfig, ZoneLayout } from '../services/sensor-simulator/src/types';

/** Reach of a one-ring H3 neighbourhood at resolution 5, give or take. */
const NEIGHBOUR_REACH_KM = 25;

/** The worked example radius in docs/03-MEASUREMENT.md §2. */
const ANOMALY_RADIUS_KM = 84;

const ZONE_COUNTS = [10, 100, 400, 1000, 5000];
const SEED = 42;

interface Row {
  layout: ZoneLayout;
  count: number;
  nearestMinKm: number;
  nearestMedianKm: number;
  nearestMaxKm: number;
  pairsWithinReach: number;
  zonesWithAnyNeighbour: number;
  zonesInAnomalyDisc: number;
}

function measure(layout: ZoneLayout, count: number): Row {
  const zones = ZoneGenerator.generate({ count, layout, seed: SEED });

  const nearest: number[] = [];
  let pairsWithinReach = 0;
  let zonesWithAnyNeighbour = 0;

  for (let i = 0; i < zones.length; i++) {
    let best = Infinity;
    let hasNeighbour = false;

    for (let j = 0; j < zones.length; j++) {
      if (i === j) {
        continue;
      }
      const km = haversineKm(zones[i], zones[j]);
      if (km < best) {
        best = km;
      }
      if (km <= NEIGHBOUR_REACH_KM) {
        hasNeighbour = true;
        if (j > i) {
          pairsWithinReach++;
        }
      }
    }

    nearest.push(best);
    if (hasNeighbour) {
      zonesWithAnyNeighbour++;
    }
  }

  nearest.sort((a, b) => a - b);

  return {
    layout,
    count,
    nearestMinKm: nearest[0],
    nearestMedianKm: nearest[Math.floor(nearest.length / 2)],
    nearestMaxKm: nearest[nearest.length - 1],
    pairsWithinReach,
    zonesWithAnyNeighbour,
    zonesInAnomalyDisc: zonesInDisc(zones)
  };
}

/** Zones inside an 84 km disc centred on the densest part of the field. */
function zonesInDisc(zones: readonly ZoneConfig[]): number {
  let best = 0;
  for (const centre of zones) {
    let inside = 0;
    for (const zone of zones) {
      if (haversineKm(centre, zone) <= ANOMALY_RADIUS_KM) {
        inside++;
      }
    }
    if (inside > best) {
      best = inside;
    }
  }
  return best;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

console.log('D9: zone spacing by layout');
console.log(`neighbour reach assumed: ${NEIGHBOUR_REACH_KM} km (H3 res 5, one ring)`);
console.log(`anomaly disc: ${ANOMALY_RADIUS_KM} km radius, best-case placement`);
console.log(`seed: ${SEED}`);
console.log();
console.log(
  'layout          zones   nn-min   nn-med   nn-max   pairs<=reach   zones with   zones in'
);
console.log(
  '                            km       km       km                  a neighbour   84km disc'
);
console.log('-'.repeat(88));

const rows: Row[] = [];
for (const layout of ['global-spiral', 'regional-grid'] as ZoneLayout[]) {
  for (const count of ZONE_COUNTS) {
    const row = measure(layout, count);
    rows.push(row);
    console.log(
      `${row.layout.padEnd(15)}${pad(row.count, 5)} ${pad(row.nearestMinKm.toFixed(1), 8)} ` +
        `${pad(row.nearestMedianKm.toFixed(1), 8)} ${pad(row.nearestMaxKm.toFixed(1), 8)} ` +
        `${pad(row.pairsWithinReach, 14)} ${pad(row.zonesWithAnyNeighbour, 12)} ` +
        `${pad(row.zonesInAnomalyDisc, 11)}`
    );
  }
  console.log();
}

const spiral = rows.filter((r) => r.layout === 'global-spiral');
const grid = rows.filter((r) => r.layout === 'regional-grid');

console.log('Verdict');
console.log('-'.repeat(88));
console.log(
  `global-spiral: closest pair anywhere is ${Math.min(...spiral.map((r) => r.nearestMinKm)).toFixed(1)} km, ` +
    `at ${Math.max(...ZONE_COUNTS)} zones. Pairs within neighbour reach at any count: ` +
    `${spiral.reduce((sum, r) => sum + r.pairsWithinReach, 0)}.`
);
console.log(
  `  Largest 84 km disc holds ${Math.max(...spiral.map((r) => r.zonesInAnomalyDisc))} zone(s). ` +
    'A regional anomaly is a single-zone event, so there is no correlation to measure and no'
);
console.log('  grouping decision for the engine to get right or wrong.');
console.log();
console.log(
  `regional-grid: closest pair ${Math.min(...grid.map((r) => r.nearestMinKm)).toFixed(1)} km; ` +
    `every zone has a neighbour from ${
      grid.find((r) => r.zonesWithAnyNeighbour === r.count)?.count ?? 'n/a'
    } zones upward.`
);
console.log(
  `  Largest 84 km disc holds ${Math.max(...grid.map((r) => r.zonesInAnomalyDisc))} zones at ` +
    `${Math.max(...ZONE_COUNTS)} zones, which is a regional event worth collapsing.`
);
