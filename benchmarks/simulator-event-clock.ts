/**
 * Evidence for D8: the simulator's event clock does not track real time, and each zone's
 * clock advances at a different rate.
 *
 * Run from the simulator service so its node_modules resolve:
 *   cd services/sensor-simulator &&  *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}'  *     ../../benchmarks/simulator-event-clock.ts
 *
 * The mechanism, in loadGenerator.generateEvent:
 *
 *   let eventTimestamp = this.zoneClocks.get(zone.zoneId) || producedAt;
 *   const processingDelay = 1 + (parseInt(zone.zoneId.replace('Z-', '')) % 20);
 *   eventTimestamp = Math.min(eventTimestamp + processingDelay, producedAt);
 *
 * The clock starts at producedAt and thereafter advances by processingDelay per EVENT, never
 * by elapsed time. So it falls permanently behind wall clock, and its rate is
 * (events per second for that zone) x (that zone's processingDelay) — throughput-dependent,
 * and different for every zone because the delay is derived from the zone number.
 */
import { LoadGenerator } from '../services/sensor-simulator/src/loadGenerator';
import { ZoneGenerator } from '../services/sensor-simulator/src/zoneGenerator';

const START = 1_700_000_000_000;
const WALL_MS = 60_000;
const EVENT_INTERVAL_MS = 200; // each zone gets an event every 200ms (10 zones @ 50 eps)

function run(zoneCount: number) {
  LoadGenerator.reset();
  const zones = ZoneGenerator.generateZones(zoneCount);
  const clocks: Record<string, number> = {};

  for (let tick = 0; tick < WALL_MS / EVENT_INTERVAL_MS; tick++) {
    const producedAt = START + tick * EVENT_INTERVAL_MS;
    for (const z of zones) {
      clocks[z.zoneId] = LoadGenerator.generateEvent(z, 'spike', producedAt).eventTimestamp;
    }
  }
  return zones.map((z) => ({ zoneId: z.zoneId, advanced: clocks[z.zoneId] - START }));
}

const rows = run(20);
const spans = rows.map((r) => r.advanced);
const min = Math.min(...spans);
const max = Math.max(...spans);

console.log(`Wall-clock elapsed:        ${WALL_MS} ms`);
console.log(`Event-time advanced, per zone:`);
for (const r of rows) {
  const pct = ((r.advanced / WALL_MS) * 100).toFixed(2);
  console.log(`  ${r.zoneId.padEnd(5)} ${String(r.advanced).padStart(5)} ms  (${pct}% of real time)`);
}
console.log();
console.log(`Slowest zone:              ${min} ms (${((min / WALL_MS) * 100).toFixed(2)}% of real time)`);
console.log(`Fastest zone:              ${max} ms (${((max / WALL_MS) * 100).toFixed(2)}% of real time)`);
console.log(`Divergence between zones:  ${max - min} ms after only ${WALL_MS / 1000}s`);
console.log();
console.log('Consequences:');
console.log('  - STRESSED confirmation needs 60s of EVENT time. At the slowest zone rate that');
console.log(`    is ${(60000 / (min / WALL_MS) / 1000 / 60).toFixed(0)} minutes of wall clock, which is why a 2-minute run alerts on nothing.`);
console.log('  - Zones drift apart in event time at different rates, so two adjacent zones');
console.log('    never appear to degrade "at the same time" regardless of the physical scenario.');
console.log('    Spatial correlation (WP2) is built entirely on that judgement.');
