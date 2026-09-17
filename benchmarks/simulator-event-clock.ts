/**
 * D8: does the simulator's event clock track real time, and do all zones share it?
 *
 * Run from the simulator service so its node_modules resolve:
 *   cd services/sensor-simulator && \
 *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}' \
 *     ../../benchmarks/simulator-event-clock.ts
 *
 * BEFORE (benchmarks/results/d8-simulator-event-clock.txt) the mechanism was:
 *
 *   let eventTimestamp = this.zoneClocks.get(zone.zoneId) || producedAt;
 *   const processingDelay = 1 + (parseInt(zone.zoneId.replace('Z-', '')) % 20);
 *   eventTimestamp = Math.min(eventTimestamp + processingDelay, producedAt);
 *
 * — an accumulator advanced by a constant per EVENT, never by elapsed time, at a rate that
 * differed per zone because the delay came from the zone number. Result: event time ran at
 * 0.5–10% of real time and zones diverged 5.7 seconds within the first simulated minute.
 *
 * AFTER: one VirtualClock shared by every zone, advanced by SIM_STEP_MS per tick, with a
 * bounded per-zone sensor lag applied as an offset. This script measures the same quantities
 * against the same 20 zones so the two outputs are directly comparable.
 *
 * Nothing here sleeps: the pacing schedule is a property of the clock, so the wall-clock cost
 * of a simulated span is computed rather than waited out. That keeps the benchmark
 * deterministic and instant.
 */
import { LoadGenerator } from '../services/sensor-simulator/src/loadGenerator';
import { ZoneGenerator } from '../services/sensor-simulator/src/zoneGenerator';
import { VirtualClock } from '../services/sensor-simulator/src/virtualClock';

const WALL_MS = 60_000;
const ZONE_COUNT = 20;
const STEP_MS = 1000;
const SPEED = 1;

const CONFIRMATION_MS = 60_000; // stream-processor STRESSED confirmation, in event time

interface ZoneRow {
  zoneId: string;
  advanced: number;
  lagMs: number;
}

/**
 * Advance the shared clock over `WALL_MS` of real time at `speedMultiplier`, and report how far
 * each zone's event time moved.
 */
function run(zoneCount: number, speedMultiplier: number): ZoneRow[] {
  const clock = new VirtualClock({ stepMs: STEP_MS, speedMultiplier });
  const zones = ZoneGenerator.generateZones(zoneCount);

  const firings = Math.floor(WALL_MS / clock.realTickIntervalMs);
  const first = new Map<string, number>();
  const last = new Map<string, number>();

  for (let firing = 0; firing < firings; firing++) {
    for (let step = 0; step < clock.stepsPerRealTick; step++) {
      const simNow = clock.tick();
      for (const zone of zones) {
        const { eventTimestamp } = LoadGenerator.generateEvent(zone, 'spike', simNow);
        if (!first.has(zone.zoneId)) {
          first.set(zone.zoneId, eventTimestamp);
        }
        last.set(zone.zoneId, eventTimestamp);
      }
    }
  }

  return zones.map((z) => ({
    zoneId: z.zoneId,
    advanced: last.get(z.zoneId)! - first.get(z.zoneId)!,
    lagMs: LoadGenerator.sensorLagMs(z.zoneId)
  }));
}

/** The full event stream over a fixed simulated span, for comparing runs byte for byte. */
function stream(speedMultiplier: number, steps: number) {
  const clock = new VirtualClock({ stepMs: STEP_MS, speedMultiplier });
  const zones = ZoneGenerator.generateZones(ZONE_COUNT);
  const events = [];
  for (let i = 0; i < steps; i++) {
    const simNow = clock.tick();
    for (const zone of zones) {
      events.push(LoadGenerator.generateEvent(zone, 'spike', simNow));
    }
  }
  return events;
}

const rows = run(ZONE_COUNT, SPEED);
const spans = rows.map((r) => r.advanced);
const min = Math.min(...spans);
const max = Math.max(...spans);

const clock = new VirtualClock({ stepMs: STEP_MS, speedMultiplier: SPEED });

console.log(`Config:                    SIM_STEP_MS=${STEP_MS}, SPEED_MULTIPLIER=${SPEED}, ${ZONE_COUNT} zones`);
console.log(`Wall-clock elapsed:        ${WALL_MS} ms`);
console.log(`Event-time advanced, per zone:`);
for (const r of rows) {
  const pct = ((r.advanced / WALL_MS) * 100).toFixed(2);
  console.log(
    `  ${r.zoneId.padEnd(5)} ${String(r.advanced).padStart(6)} ms  (${pct.padStart(6)}% of real time)  sensor lag ${String(r.lagMs).padStart(2)} ms`
  );
}
console.log();
console.log(`Slowest zone:              ${min} ms (${((min / WALL_MS) * 100).toFixed(2)}% of real time)`);
console.log(`Fastest zone:              ${max} ms (${((max / WALL_MS) * 100).toFixed(2)}% of real time)`);
console.log(`Divergence between zones:  ${max - min} ms after ${WALL_MS / 1000}s`);
console.log(`Max sensor lag (bound):    ${LoadGenerator.MAX_SENSOR_LAG_MS} ms`);
console.log(
  `  (measured first sample to last, so one step short of the window: ${Math.round(
    WALL_MS / clock.realTickIntervalMs
  )} samples ${STEP_MS} ms apart span ${(WALL_MS - STEP_MS) / 1000}s of a ${WALL_MS / 1000}s window. The rate itself is exactly ${clock.simulatedMsPerRealMs}x.)`
);
console.log();
console.log('Zone-to-zone spread at a single instant:');
const lags = rows.map((r) => r.lagMs);
console.log(`  min lag ${Math.min(...lags)} ms, max lag ${Math.max(...lags)} ms, spread ${Math.max(...lags) - Math.min(...lags)} ms — bounded, and constant for the life of the run`);
console.log();
console.log('Wall-clock cost of one 60s STRESSED confirmation window:');
for (const speed of [1, 10, 60, 600]) {
  const c = new VirtualClock({ stepMs: STEP_MS, speedMultiplier: speed });
  const seconds = CONFIRMATION_MS / c.simulatedMsPerRealMs / 1000;
  console.log(
    `  SPEED_MULTIPLIER=${String(speed).padStart(3)}  ${seconds.toFixed(2).padStart(7)} s of wall clock` +
      `   (${Math.round(c.eventsPerRealSecond(ZONE_COUNT))} events/real second at ${ZONE_COUNT} zones)`
  );
}
console.log();
console.log('Determinism:');
console.log(
  `  same 300-step event stream at 1x and 60x: ${
    JSON.stringify(stream(1, 300)) === JSON.stringify(stream(60, 300)) ? 'yes' : 'NO'
  }`
);
console.log(
  `  same 300-step event stream across two runs at 1x: ${
    JSON.stringify(stream(1, 300)) === JSON.stringify(stream(1, 300)) ? 'yes' : 'NO'
  }`
);
console.log(`  achieved simulated ms per real ms at SPEED_MULTIPLIER=${SPEED}: ${clock.simulatedMsPerRealMs}`);
console.log();
console.log('Consequences:');
console.log('  - Event time now advances at exactly SPEED_MULTIPLIER x real time, so a 60s');
console.log('    confirmation window costs 60s of wall clock at 1x and 1s at 60x.');
console.log('  - All zones read one clock, so two adjacent zones degrading at the same');
console.log(`    simulated instant carry timestamps at most ${LoadGenerator.MAX_SENSOR_LAG_MS} ms apart, forever. That is`);
console.log('    the judgement spatial correlation (WP2) is built on.');
