/**
 * Does the set of zones one anomaly degrades actually form ONE connected component under the
 * adjacency the correlation engine uses?
 *
 * This exists because the first full end-to-end run answered "no". Every one of the 62 zones the
 * `regional-anomaly` ground truth labels reached the correlation window — detection was exact —
 * and the engine still reported seven components and three separate incidents. A fault that is
 * one thing on the ground came out as several, which is the fragmentation failure mode the
 * scenario was written to catch, arriving from a direction nobody had checked: not from the
 * correlation algorithm, which is proved against an oracle, but from the *geometry the algorithm
 * is handed*.
 *
 * The question this answers is therefore not "is the union-find correct" (WP2a settled that with
 * 551,871 compared operations) but "is the adjacency reach large enough for the zone density".
 * Those are independent, and only the second one depends on how many zones you deploy.
 *
 * Run:
 *   cd packages/spatial && NODE_PATH=./node_modules  *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}'  *     ../../benchmarks/anomaly-connectivity.ts  *     | tee ../../benchmarks/results/wp3-anomaly-connectivity.txt
 *
 * Reads the committed ground truth in `evals/groundtruth/`, so it needs no broker, no stack and
 * no simulator run — the labelled zone set is a property of the seed.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { latLngToCell } from 'h3-js';

import { cellsFor, H3_RESOLUTION } from '../packages/spatial/src/cells';
import { NeighbourGraph, ZoneLocation } from '../packages/spatial/src/neighbourGraph';
import { ZoneGenerator } from '../services/sensor-simulator/src/zoneGenerator';

const GROUNDTRUTH_DIR = join(__dirname, '..', 'evals', 'groundtruth');

interface GroundTruthRecord {
  anomalyId: string;
  kind: string;
  seed: number;
  origin: { latitude: number; longitude: number };
  radiusKm: number;
  affectedZones: { zoneId: string }[];
}

interface Meta {
  runId: string;
  scenario: string;
  seed: number;
  zoneCount: number;
}

/** Components over a zone set, using exactly the adjacency rule the engine uses. */
function componentsOf(
  zones: readonly ZoneLocation[],
  resolution: number,
  ringSize: number
): string[][] {
  // Both, always. `NeighbourGraph` recomputes any `h3Cell` that is not at *its* resolution, so
  // passing cells at res 6 to a graph still configured for res 5 silently measures res 5 — which
  // is exactly what the first version of this script did, and it produced three identical rows.
  const graph = new NeighbourGraph({ resolution, ringSize });
  graph.build(zones);

  const ids = zones.map((z) => z.zoneId);
  const seen = new Set<string>();
  const components: string[][] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    const stack = [id];
    const component: string[] = [];
    seen.add(id);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      component.push(current);
      for (const neighbour of graph.neighboursOf(current)) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
    components.push(component.sort());
  }

  return components.sort((a, b) => b.length - a.length);
}

function zoneLocations(
  zoneIds: readonly string[],
  byId: Map<string, { latitude: number; longitude: number }>,
  resolution: number
): ZoneLocation[] {
  const located: ZoneLocation[] = [];
  for (const zoneId of zoneIds) {
    const position = byId.get(zoneId);
    if (!position) continue;
    located.push({
      zoneId,
      latitude: position.latitude,
      longitude: position.longitude,
      // At the service's own resolution this is `cellsFor(...).h3Cell`; the sweep below needs
      // other resolutions, and NeighbourGraph recomputes a cell that is at the wrong resolution
      // anyway — passing it explicitly keeps the comparison honest.
      h3Cell: latLngToCell(position.latitude, position.longitude, resolution)
    });
  }
  return located;
}

function main(): void {
  const files = readdirSync(GROUNDTRUTH_DIR).filter((f) => f.endsWith('.meta.json'));
  if (files.length === 0) {
    throw new Error(`No ground truth in ${GROUNDTRUTH_DIR}. Run the simulator first.`);
  }

  console.log('Anomaly connectivity under the engine adjacency');
  console.log('===============================================');
  console.log(`Detection resolution in @geopulse/spatial: res ${H3_RESOLUTION}`);
  console.log('');
  console.log('A regional fault is ONE thing. If its labelled zones are not one component,');
  console.log('the engine cannot report it as one incident no matter how correct it is.');
  console.log('');

  for (const metaFile of files.sort()) {
    const meta: Meta = JSON.parse(readFileSync(join(GROUNDTRUTH_DIR, metaFile), 'utf8'));
    const jsonlPath = join(GROUNDTRUTH_DIR, metaFile.replace('.meta.json', '.jsonl'));
    const records: GroundTruthRecord[] = readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    if (records.length === 0) continue;

    // Regenerate the exact zone field this run used. The generator is a pure function of
    // (count, seed, layout, region), so this is the same field, not a similar one.
    const zones = ZoneGenerator.generate({
      count: meta.zoneCount,
      layout: 'regional-grid',
      seed: meta.seed
    });
    const byId = new Map<string, { latitude: number; longitude: number }>(
      zones.map((z) => [z.zoneId, { latitude: z.latitude, longitude: z.longitude }])
    );

    console.log(`## ${meta.scenario}  (${meta.zoneCount} zones, seed ${meta.seed})`);

    for (const record of records) {
      const zoneIds = record.affectedZones.map((z) => z.zoneId);
      console.log(
        `\n${record.anomalyId}: ${zoneIds.length} labelled zones, radius ${record.radiusKm} km`
      );

      for (const resolution of [4, 5, 6]) {
        for (const ringSize of [1, 2, 3]) {
          const located = zoneLocations(zoneIds, byId, resolution);
          const components = componentsOf(located, resolution, ringSize);
          const occupied = new Set(located.map((z) => z.h3Cell)).size;
          const largest = components[0]?.length ?? 0;
          const marker = components.length === 1 ? ' <== one component' : '';
          console.log(
            `  res ${resolution} ring ${ringSize}: ` +
              `${String(components.length).padStart(3)} components, ` +
              `largest ${String(largest).padStart(3)}/${zoneIds.length}, ` +
              `${String(occupied).padStart(3)} cells occupied` +
              marker
          );
        }
      }
    }

    // The over-grouping check, and the reason a bigger ring is not free. Two anomalies in the
    // `multi-anomaly` scenario are placed at least 100 km apart precisely so that a correct
    // engine has no excuse to merge them. Any setting that connects them is wrong however well
    // it connects a single fault.
    if (records.length > 1) {
      console.log('\n  Over-grouping check — these must stay separate:');
      const allIds = records.flatMap((r) => r.affectedZones.map((z) => z.zoneId));
      for (const resolution of [4, 5, 6]) {
        for (const ringSize of [1, 2, 3]) {
          const located = zoneLocations(allIds, byId, resolution);
          const components = componentsOf(located, resolution, ringSize);
          const merged = components.length < records.length;
          console.log(
            `  res ${resolution} ring ${ringSize}: ${components.length} components across ` +
              `${records.length} anomalies${merged ? '  <== MERGED, over-grouping' : ''}`
          );
        }
      }
    }
    console.log('');
  }

  // Sanity: the production helper and the sweep agree at the production resolution.
  const sample = cellsFor(51.96, 13.09);
  console.log(
    `cellsFor(51.96, 13.09) -> fine ${sample.h3Cell} (res ${H3_RESOLUTION}), ` +
      `coarse ${sample.h3CoarseCell}`
  );
}

main();
