import { ZoneGenerator } from '../zoneGenerator';
import { LoadGenerator } from '../loadGenerator';
import { VirtualClock } from '../virtualClock';
import { buildAnomalies } from '../scenarios';
import { deriveGroundTruth, deriveRunId, serialiseGroundTruth } from '../groundTruth';
import { ANOMALY_SCENARIOS, ScenarioType, SensorEvent, ZoneConfig } from '../types';

/**
 * The hard constraint from CLAUDE.md rule 3, asserted directly: the same seed produces a
 * byte-identical run.
 *
 * "Byte-identical" is not a figure of speech here. Every claim this project will make rests on
 * a number produced by a scored eval run, and a run that cannot be reproduced exactly cannot be
 * re-scored, cannot be bisected when a result changes, and cannot be defended when someone asks
 * where the number came from. So these tests compare serialised bytes rather than structures:
 * a change that reorders a key, widens a float, or lets a single Math.random() in fails here
 * rather than silently in the results table three weeks later.
 *
 * The full pipeline is covered — zone placement, anomaly planning, the emitted event stream,
 * and the ground-truth file — because a non-deterministic step anywhere in that chain poisons
 * everything downstream of it.
 */

const SEED = 42;
const START = Date.UTC(2026, 0, 15, 12, 0, 0);
const STEP_MS = 1000;
const ZONE_COUNT = 120;
const RUN_DURATION_MS = 60 * 60 * 1000; // one simulated hour keeps the suite quick

interface Run {
  zones: ZoneConfig[];
  groundTruth: string;
  events: SensorEvent[];
}

/** Plan and execute a complete run, end to end, exactly as the simulator would. */
function performRun(scenario: ScenarioType, seed: number, speedMultiplier = 1): Run {
  const zones = ZoneGenerator.generate({ count: ZONE_COUNT, layout: 'regional-grid', seed });

  const anomalies = buildAnomalies(scenario, {
    zones,
    seed,
    startEventTime: START,
    runDurationMs: RUN_DURATION_MS
  });

  const groundTruth = serialiseGroundTruth(
    deriveGroundTruth({
      runId: deriveRunId(scenario, seed, START),
      scenario,
      seed,
      zones,
      anomalies,
      startEpochMs: START,
      stepMs: STEP_MS,
      runDurationMs: RUN_DURATION_MS
    })
  );

  // A short slice of the stream, sampled around the busiest part of the run. Comparing every
  // tick of a simulated hour for 120 zones would be 432,000 events per run and would dominate
  // the suite's runtime without testing anything the slice does not.
  const clock = new VirtualClock({ startEpochMs: START, stepMs: STEP_MS, speedMultiplier });
  clock.advance(Math.floor(RUN_DURATION_MS / STEP_MS / 3));

  const events: SensorEvent[] = [];
  for (let i = 0; i < 400; i++) {
    const simNow = clock.tick();
    for (const zone of zones) {
      events.push(LoadGenerator.generateEvent(zone, scenario, simNow, anomalies));
    }
  }

  return { zones, groundTruth, events };
}

describe.each(ANOMALY_SCENARIOS)('%s is reproducible', (scenario) => {
  it('produces a byte-identical run for the same seed', () => {
    const first = performRun(scenario, SEED);
    const second = performRun(scenario, SEED);

    expect(JSON.stringify(second.zones)).toBe(JSON.stringify(first.zones));
    expect(second.groundTruth).toBe(first.groundTruth);
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
  });

  it('produces a different run for a different seed', () => {
    // The mirror of the test above, and just as necessary: a builder that ignored its seed
    // would pass every reproducibility assertion perfectly.
    const base = performRun(scenario, SEED);
    const other = performRun(scenario, SEED + 1);

    expect(JSON.stringify(other.zones)).not.toBe(JSON.stringify(base.zones));
    expect(other.groundTruth).not.toBe(base.groundTruth);
    expect(JSON.stringify(other.events)).not.toBe(JSON.stringify(base.events));
  });

  it('is unchanged by how fast the run is paced', () => {
    // SPEED_MULTIPLIER is what makes a four-hour eval finish in minutes. It is only safe if it
    // changes the wall clock and nothing else.
    const realTime = performRun(scenario, SEED, 1);
    const fast = performRun(scenario, SEED, 600);

    expect(JSON.stringify(fast.events)).toBe(JSON.stringify(realTime.events));
  });

  it('writes a run id that carries the seed and does not move', () => {
    const runId = deriveRunId(scenario, SEED, START);

    expect(runId).toBe(deriveRunId(scenario, SEED, START));
    expect(runId).toContain(`seed${SEED}`);
    expect(runId).toContain(scenario);
    // Legal as a filename on every platform we run on — no colons from the ISO form.
    expect(runId).not.toMatch(/[:*?"<>|\\/]/);
  });
});

describe('the generation path holds no hidden state', () => {
  it('gives the same answer for a tick whether or not earlier ticks were generated first', () => {
    // Replay depends on this. If generation accumulated anything — a running average, a
    // previous-value cache, an event counter folded into the load — then scoring a run would
    // depend on having replayed it from the beginning, and D8 would be back in a new costume.
    const zones = ZoneGenerator.generate({ count: 20, layout: 'regional-grid', seed: SEED });
    const anomalies = buildAnomalies('regional-anomaly', {
      zones,
      seed: SEED,
      startEventTime: START,
      runDurationMs: RUN_DURATION_MS
    });
    const target = START + 1234 * STEP_MS;

    const cold = zones.map((zone) =>
      LoadGenerator.generateEvent(zone, 'regional-anomaly', target, anomalies)
    );

    for (let tick = 0; tick < 1234; tick++) {
      for (const zone of zones) {
        LoadGenerator.generateEvent(zone, 'regional-anomaly', START + tick * STEP_MS, anomalies);
      }
    }
    const warm = zones.map((zone) =>
      LoadGenerator.generateEvent(zone, 'regional-anomaly', target, anomalies)
    );

    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
  });

  it('leaves the legacy scenarios byte-identical to a run with no anomaly support at all', () => {
    // The anomaly parameter defaults to empty. normal / spike / drop must be exactly what they
    // were before WP6a, or every measurement taken against them stops being comparable.
    const zones = ZoneGenerator.generateZones(10);
    const withArgument = zones.map((zone) =>
      LoadGenerator.generateEvent(zone, 'spike', START, [])
    );
    const withoutArgument = zones.map((zone) => LoadGenerator.generateEvent(zone, 'spike', START));

    expect(JSON.stringify(withArgument)).toBe(JSON.stringify(withoutArgument));
  });
});
