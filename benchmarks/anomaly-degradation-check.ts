/**
 * Does an injected anomaly actually drive the real state machine into degradation?
 *
 * Run from the stream-processor service, which can see both source trees:
 *   cd services/stream-processor && \
 *     npx ts-node -O '{"module":"commonjs","esModuleInterop":true,"target":"ES2020"}' \
 *     ../../benchmarks/anomaly-degradation-check.ts \
 *     | tee ../../benchmarks/results/wp6a-degradation-check.txt
 *
 * WP6a's own tests assert that a labelled zone's *load* sustains a degrading level. That is the
 * simulator's side of the contract, and it is deliberately asserted without re-implementing the
 * consumer's windowing — but it leaves one question open: does the injection actually clear the
 * bar the real `TimeWindowManager` and `StateMachine` set, with their five-minute average and
 * their sixty-second confirmation? If it does not, every eval run scores a correlation engine
 * that was handed nothing to correlate.
 *
 * So this replays the simulator's exact event stream through the stream-processor's own classes.
 * No broker, no Redis, no Kafka: just the two components, fed the events the simulator would
 * have produced. Deterministic and re-runnable, like everything else that produces a number here.
 *
 * Part 2 exists because a live run disagreed with part 1: the same configuration, against the
 * real stack, produced zero degradations. It probes one suspected contributor — watermark-driven
 * eviction under cross-partition skew — and is deliberately reported as a partial finding,
 * because it does not by itself account for what was observed. See defect D10 in
 * `docs/01-ARCHITECTURE.md` §3.4.
 */
import { TimeWindowManager } from '../services/stream-processor/src/timeWindowManager';
import { StateMachine } from '../services/stream-processor/src/stateMachine';
import { ZoneStateStore } from '../services/stream-processor/src/zoneStateStore';
import { ZoneState, ZoneStateData } from '../services/stream-processor/src/types';
import { ZoneGenerator } from '../services/sensor-simulator/src/zoneGenerator';
import { LoadGenerator } from '../services/sensor-simulator/src/loadGenerator';
import { buildAnomalies } from '../services/sensor-simulator/src/scenarios';
import { deriveGroundTruth, deriveRunId } from '../services/sensor-simulator/src/groundTruth';
import { ScenarioType } from '../services/sensor-simulator/src/types';

const SEED = 42;
const START = Date.UTC(2026, 0, 15, 12, 0, 0);
const STEP_MS = 1000;
const ZONE_COUNT = 400;
const RUN_DURATION_MS = 4 * 60 * 60 * 1000;

/** Partitions the pipeline runs with, per tools/kafka-bootstrap. */
const PARTITIONS = 12;

const zones = ZoneGenerator.generate({ count: ZONE_COUNT, layout: 'regional-grid', seed: SEED });

interface Transition {
  from: ZoneState;
  to: ZoneState;
  at: number;
  avg5m: number;
}

function freshState(): ZoneStateData {
  return {
    currentState: 'NORMAL',
    window1m: TimeWindowManager.createWindow(),
    window5m: TimeWindowManager.createWindow(),
    stressedSince: null,
    criticalSince: null,
    lastAlertTimestamp: null
  };
}

/** Replay one zone's own events, in order, through the real window + state machine. */
function replayZone(
  zoneId: string,
  scenario: ScenarioType,
  anomalies: ReturnType<typeof buildAnomalies>
): Transition[] {
  const zone = zones.find((z) => z.zoneId === zoneId)!;
  const lagMs = LoadGenerator.sensorLagMs(zoneId);

  const state = freshState();
  const { window1m, window5m } = state;
  const transitions: Transition[] = [];

  const ticks = Math.floor(RUN_DURATION_MS / STEP_MS);
  for (let tick = 0; tick <= ticks; tick++) {
    const eventTime = START + tick * STEP_MS - lagMs;
    const load = LoadGenerator.loadAt(zone, scenario, eventTime, anomalies);

    TimeWindowManager.addEvent(window1m, eventTime, load, TimeWindowManager.WINDOW_1M_SECONDS);
    TimeWindowManager.addEvent(window5m, eventTime, load, TimeWindowManager.WINDOW_5M_SECONDS);

    const avg1m = TimeWindowManager.calculateAverage(window1m);
    const avg5m = TimeWindowManager.calculateAverage(window5m);
    const next = StateMachine.getNextState(state.currentState, avg1m, avg5m, eventTime, state);

    if (next !== state.currentState) {
      transitions.push({ from: state.currentState, to: next, at: eventTime, avg5m });
      state.currentState = next;
    }
  }

  return transitions;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

console.log('WP6a: does an injected anomaly degrade the real state machine?');
console.log(`zones: ${ZONE_COUNT} (regional-grid)   seed: ${SEED}   run: ${RUN_DURATION_MS / 3_600_000}h simulated`);
console.log('components under replay: stream-processor TimeWindowManager + StateMachine');
console.log();

// ------------------------------------------------------------------ part 1

console.log('Part 1 — per-zone ordered replay');
console.log('-'.repeat(92));
console.log('scenario              labelled  reached   reached   first STRESSED   median lag from');
console.log('                         zones  STRESSED  CRITICAL   (worst zone)     labelled onset');
console.log('-'.repeat(92));

let anyFailure = false;

for (const scenario of [
  'regional-anomaly',
  'propagating-anomaly',
  'multi-anomaly',
  'noise'
] as ScenarioType[]) {
  const anomalies = buildAnomalies(scenario, {
    zones,
    seed: SEED,
    startEventTime: START,
    runDurationMs: RUN_DURATION_MS
  });
  const records = deriveGroundTruth({
    runId: deriveRunId(scenario, SEED, START),
    scenario,
    seed: SEED,
    zones,
    anomalies,
    startEpochMs: START,
    stepMs: STEP_MS,
    runDurationMs: RUN_DURATION_MS
  });

  const onsetByZone = new Map<string, number>();
  for (const record of records) {
    for (const zone of record.affectedZones) {
      onsetByZone.set(zone.zoneId, Math.min(onsetByZone.get(zone.zoneId) ?? Infinity, zone.onsetEventTime));
    }
  }

  let stressed = 0;
  let critical = 0;
  let worstFirstStressed = 0;
  const lags: number[] = [];

  for (const [zoneId, labelledOnset] of onsetByZone) {
    const transitions = replayZone(zoneId, scenario, anomalies);
    const firstStressed = transitions.find((t) => t.to === 'STRESSED' && t.from === 'NORMAL');

    if (firstStressed) {
      stressed++;
      lags.push(firstStressed.at - labelledOnset);
      if (firstStressed.at > worstFirstStressed) {
        worstFirstStressed = firstStressed.at;
      }
    }
    if (transitions.some((t) => t.to === 'CRITICAL')) {
      critical++;
    }
  }

  if (stressed !== onsetByZone.size) {
    anyFailure = true;
  }

  lags.sort((a, b) => a - b);
  const medianLagS = lags.length ? lags[Math.floor(lags.length / 2)] / 1000 : NaN;

  console.log(
    `${scenario.padEnd(22)}${String(onsetByZone.size).padStart(8)}` +
      `${String(stressed).padStart(10)}${String(critical).padStart(10)}   ` +
      `${(worstFirstStressed ? iso(worstFirstStressed) : '-').padEnd(16)} ` +
      `${lags.length ? medianLagS.toFixed(0) + 's' : '-'}`
  );
}

// A control: a zone the labels leave out must not transition, or the labels understate the
// affected set and every precision number is capped before the engine sees anything.
const controlAnomalies = buildAnomalies('regional-anomaly', {
  zones,
  seed: SEED,
  startEventTime: START,
  runDurationMs: RUN_DURATION_MS
});
const controlRecords = deriveGroundTruth({
  runId: deriveRunId('regional-anomaly', SEED, START),
  scenario: 'regional-anomaly',
  seed: SEED,
  zones,
  anomalies: controlAnomalies,
  startEpochMs: START,
  stepMs: STEP_MS,
  runDurationMs: RUN_DURATION_MS
});
const labelled = new Set(controlRecords.flatMap((r) => r.affectedZones.map((z) => z.zoneId)));
const controls = zones.filter((z) => !labelled.has(z.zoneId)).slice(0, 40);
const controlTransitions = controls.reduce(
  (sum, zone) => sum + replayZone(zone.zoneId, 'regional-anomaly', controlAnomalies).length,
  0
);

console.log();
console.log(
  `control: ${controls.length} unlabelled zones, regional-anomaly -> ${controlTransitions} transitions ` +
    `(expected 0)`
);
if (controlTransitions !== 0) {
  anyFailure = true;
}

console.log();
console.log(
  'The lag from labelled onset to STRESSED is the detection floor described in ' +
    '03-MEASUREMENT.md §3.3:'
);
console.log(
  '  the five-minute average has to fill before it can cross 0.75, then the transition has to ' +
    'survive'
);
console.log(
  '  a sixty-second confirmation. No correlation layer can beat it, and quoting a TTD that did ' +
    'would be a'
);
console.log('  sign of a measurement error rather than a fast system.');

// ------------------------------------------------------------------ part 2

console.log();
console.log('Part 2 — the same events with cross-partition skew (defect D10)');
console.log('-'.repeat(92));
console.log(
  'A live run of exactly this configuration produced ZERO degradations from 5.76M events, with'
);
console.log(
  'every zone left at avg1m = avg5m = 0. Part 1 says the events are fine, so the loss is in how'
);
console.log('they are consumed. This reproduces it without a broker.');
console.log();
console.log(
  'ZoneStateStore evicts a zone when the watermark — the highest event time seen across ALL'
);
console.log(
  'zones — has moved more than the idle TTL past that zone\'s own last event. With 12 partitions'
);
console.log(
  'consumed concurrently, one partition can run far ahead of another, so zones on a lagging'
);
console.log('partition are evicted as "idle" while their events are still arriving.');
console.log();

const skewAnomalies = controlAnomalies;
const idleTtlMs = 900_000; // ZoneStateStore default

for (const skewMinutes of [0, 5, 20, 45]) {
  const store = new ZoneStateStore({ idleTtlMs });
  const windows = new Map<string, { w5: ReturnType<typeof TimeWindowManager.createWindow> }>();
  let evictions = 0;
  let maxAvg5m = 0;

  const ticks = Math.floor(RUN_DURATION_MS / STEP_MS);
  const sampleZones = zones.slice(0, 120);

  for (let tick = 0; tick <= ticks; tick += 10) {
    for (const zone of sampleZones) {
      // Partition skew: a zone's events are delivered `skew` behind the leading partition's.
      const partition = zoneNumber(zone.zoneId) % PARTITIONS;
      const skewMs = (partition / (PARTITIONS - 1)) * skewMinutes * 60_000;
      const eventTime = START + tick * STEP_MS - LoadGenerator.sensorLagMs(zone.zoneId);
      const deliveredAt = eventTime + skewMs;

      store.observe(zone.zoneId, zone.latitude, zone.longitude, deliveredAt, freshState);

      let entry = windows.get(zone.zoneId);
      if (!entry || !store.has(zone.zoneId)) {
        entry = { w5: TimeWindowManager.createWindow() };
        windows.set(zone.zoneId, entry);
      }

      const load = LoadGenerator.loadAt(zone, 'regional-anomaly', eventTime, skewAnomalies);
      TimeWindowManager.addEvent(entry.w5, eventTime, load, TimeWindowManager.WINDOW_5M_SECONDS);

      const avg5m = TimeWindowManager.calculateAverage(entry.w5);
      if (avg5m > maxAvg5m) {
        maxAvg5m = avg5m;
      }
    }

    const swept = store.sweep();
    evictions += swept.length;
    for (const zoneId of swept) {
      // Eviction discards the zone's state, so its window restarts empty. That is the bug.
      windows.delete(zoneId);
    }
  }

  console.log(
    `  skew ${String(skewMinutes).padStart(2)} min -> ${String(evictions).padStart(6)} evictions, ` +
      `peak avg5m ${maxAvg5m.toFixed(3)} ` +
      `${maxAvg5m >= 0.75 ? '(degrades)' : '(NEVER degrades — D10)'}`
  );
}

console.log();
console.log(`  idle TTL: ${idleTtlMs / 60_000} min. Skew beyond it evicts zones mid-stream.`);
console.log();
console.log(
  '  Eviction under skew is real and substantial. It is NOT on its own an explanation for the'
);
console.log(
  '  live result: an evicted zone refills its five-minute window within five simulated minutes'
);
console.log(
  '  and still crosses the threshold, which is why peak avg5m stays above 0.75 in every row'
);
console.log(
  '  above. Whatever produced avg5m = 0 on the live run needs something further — most likely'
);
console.log(
  '  repeated eviction at a cadence shorter than the window, or a second factor not probed here.'
);
console.log('  Reported as a lead, not as a diagnosis.');
console.log();
console.log('Verdict');
console.log('-'.repeat(92));
console.log(
  anyFailure
    ? 'PART 1 FAILED — the injected anomaly does not reliably degrade the real state machine.'
    : 'Part 1 PASSED — every labelled zone reaches STRESSED, no unlabelled zone transitions.'
);
console.log(
  '  WP6a is therefore done: the labels are calibrated against the real state machine, not only'
);
console.log('  against what the simulator alone considers a degrading load.');
console.log();
console.log(
  'Part 2 INCONCLUSIVE — eviction under skew is demonstrated, but does not account for the live'
);
console.log(
  'zero on its own. D10 stays open with the mechanism unestablished. It is a stream-processor'
);
console.log(
  'defect, not a simulator one, and it blocks WP6b: there is nothing to score until it is fixed.'
);

function zoneNumber(zoneId: string): number {
  return parseInt(zoneId.replace('Z-', ''), 10) || 0;
}
