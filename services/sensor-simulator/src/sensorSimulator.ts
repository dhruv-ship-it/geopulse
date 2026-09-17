import * as path from 'path';
import { ZoneGenerator } from './zoneGenerator';
import { LoadGenerator } from './loadGenerator';
import { KafkaEventProducer } from './kafkaProducer';
import { loadConfig } from './config';
import { ZoneConfig, SensorEvent, AnomalySpec, isAnomalyScenario } from './types';
import { VirtualClock } from './virtualClock';
import { SimulationLoop } from './simulationLoop';
import { buildAnomalies } from './scenarios';
import { haversineKm } from './geo';
import { deriveRunId, writeGroundTruth } from './groundTruth';
import { logger } from './logger';

/**
 * Main sensor simulator orchestrator
 * Manages zone generation, event creation, and Kafka publishing
 *
 * Simulated time is owned by a single VirtualClock shared by every zone; SimulationLoop decides
 * how fast that clock runs against the wall clock. Nothing on an emitted event comes from
 * `Date.now()` — see virtualClock.ts for why.
 *
 * On an eval scenario the simulator additionally injects faults and writes the labels for them
 * before it produces a single event, then stops itself after the configured simulated duration.
 * That makes an eval run a single terminating command rather than something an operator has to
 * remember to stop at the right moment — and "the right moment" would otherwise be a wall-clock
 * judgement, which is exactly what the run is not supposed to depend on.
 */
export class SensorSimulator {
  private config = loadConfig();
  private zones: ZoneConfig[] = [];
  private anomalies: AnomalySpec[] = [];
  private kafkaProducer: KafkaEventProducer;
  private clock: VirtualClock;
  private loop: SimulationLoop;
  private isRunning: boolean = false;
  private eventCounter: number = 0;
  private startTime: number = 0;
  private readonly runId: string;
  /** Simulated instant the run stops at, or null to run until interrupted. */
  private readonly stopAtEventTime: number | null;

  constructor() {
    this.kafkaProducer = new KafkaEventProducer();
    this.clock = new VirtualClock({
      startEpochMs: this.config.startEpochMs,
      stepMs: this.config.stepMs,
      speedMultiplier: this.config.speedMultiplier
    });
    this.loop = new SimulationLoop(this.clock, (stepTimes) => this.emitSteps(stepTimes));

    this.runId =
      this.config.runIdOverride ??
      deriveRunId(this.config.scenario, this.config.seed, this.config.startEpochMs);

    this.stopAtEventTime = isAnomalyScenario(this.config.scenario)
      ? this.config.startEpochMs + this.config.runDurationMs
      : null;
  }

  /**
   * Initialize the simulator
   */
  async initialize(): Promise<void> {
    logger.info(
      {
        numberOfZones: this.config.numberOfZones,
        scenario: this.config.scenario,
        seed: this.config.seed,
        zoneLayout: this.config.zoneLayout,
        runId: this.runId,
        logEveryNEvents: this.config.logEveryNEvents
      },
      'Initializing GeoPulse Sensor Simulator'
    );

    this.zones = ZoneGenerator.generate({
      count: this.config.numberOfZones,
      layout: this.config.zoneLayout,
      seed: this.config.seed,
      regionCentreLat: this.config.regionCentreLat,
      regionCentreLon: this.config.regionCentreLon,
      regionExtentKm: this.config.regionExtentKm
    });
    logger.info(
      { zoneCount: this.zones.length, layout: this.config.zoneLayout },
      'Generated zones with geographic distribution'
    );

    logger.info(
      {
        startEpoch: new Date(this.clock.startEpochMs).toISOString(),
        stepMs: this.clock.stepMs,
        speedMultiplier: this.clock.speedMultiplier,
        realTickIntervalMs: Number(this.clock.realTickIntervalMs.toFixed(3)),
        stepsPerRealTick: this.clock.stepsPerRealTick,
        eventsPerRealSecond: Math.round(this.clock.eventsPerRealSecond(this.zones.length)),
        maxSensorLagMs: LoadGenerator.MAX_SENSOR_LAG_MS
      },
      'Virtual clock configured — event time is simulated, not wall clock'
    );

    this.prepareGroundTruth();

    if (this.config.planOnly) {
      // Plan-only exists because the labels are worth looking at on their own. Producing four
      // simulated hours of events takes minutes and a running broker; deriving the labels takes
      // milliseconds and nothing. Being able to ask "what would this seed actually inject, and
      // how many zones would it reach" before committing to a run is the difference between
      // tuning a scenario in seconds and tuning it in afternoons.
      logger.info('PLAN_ONLY set — ground truth written, no events will be produced');
      return;
    }

    // Connect to Kafka
    await this.kafkaProducer.connect();

    this.startTime = Date.now();
    logger.info('Simulator initialized and ready');
  }

  /** True when the run was asked only to plan, so start() should do nothing. */
  isPlanOnly(): boolean {
    return this.config.planOnly;
  }

  /**
   * Build the fault injection plan and write its labels.
   *
   * Deliberately before the Kafka connection and before the first event: if the broker is down,
   * or the run is killed early, the labels for what was *supposed* to happen already exist on
   * disk, and the sidecar manifest says how long the run should have been — so a partial run is
   * recognisable as partial rather than scoring as a detector that missed everything.
   */
  private prepareGroundTruth(): void {
    this.anomalies = buildAnomalies(this.config.scenario, {
      zones: this.zones,
      seed: this.config.seed,
      startEventTime: this.config.startEpochMs,
      runDurationMs: this.config.runDurationMs
    });

    if (!isAnomalyScenario(this.config.scenario)) {
      return;
    }

    const written = writeGroundTruth(this.resolveGroundTruthDir(), {
      runId: this.runId,
      scenario: this.config.scenario,
      seed: this.config.seed,
      zones: this.zones,
      anomalies: this.anomalies,
      startEpochMs: this.config.startEpochMs,
      stepMs: this.config.stepMs,
      runDurationMs: this.config.runDurationMs
    });

    logger.info(
      {
        runId: this.runId,
        anomalies: written.recordCount,
        affectedZones: written.affectedZoneCount,
        simulatedHours: Number((this.config.runDurationMs / 3_600_000).toFixed(2)),
        groundTruth: written.groundTruthPath,
        manifest: written.manifestPath
      },
      'Ground truth written before the first event'
    );

    this.warnIfFieldTooSparse();

    if (written.affectedZoneCount === 0) {
      logger.warn(
        { scenario: this.config.scenario, zoneCount: this.zones.length },
        'No zone falls inside any injected anomaly — the run will score as a detector that ' +
          'found nothing. Raise NUM_ZONES or shrink ZONE_REGION_EXTENT_KM.'
      );
    }
  }

  /**
   * Warn when the zone field is too thin for correlation to mean anything.
   *
   * An eval run over a sparse field does not fail — it quietly produces a perfect-looking set of
   * singleton incidents and a collapse ratio of zero, and reads as a broken correlation engine
   * rather than as a misconfigured simulator. That is the most expensive kind of wrong number,
   * so it is worth one O(n) check at startup. Measured spacings are in
   * `benchmarks/results/d9-zone-spacing.txt`; the regional layout needs roughly 100 zones in the
   * default 400 km region before every zone has a neighbour at all.
   *
   * Sampled rather than exhaustive: an all-pairs scan is 25 million distances at 5000 zones, and
   * the first 64 zones against the whole field answer the question just as well. The sample is
   * the first N by id, not a random draw, so the check stays deterministic.
   */
  private warnIfFieldTooSparse(): void {
    const sample = this.zones.slice(0, Math.min(64, this.zones.length));
    if (sample.length < 2) {
      return;
    }

    const nearest = sample.map((zone) => {
      let best = Infinity;
      for (const other of this.zones) {
        if (other.zoneId === zone.zoneId) {
          continue;
        }
        const km = haversineKm(zone, other);
        if (km < best) {
          best = km;
        }
      }
      return best;
    });
    nearest.sort((a, b) => a - b);
    const medianKm = nearest[Math.floor(nearest.length / 2)];

    if (medianKm > SensorSimulator.NEIGHBOUR_REACH_KM) {
      logger.warn(
        {
          medianNearestNeighbourKm: Number(medianKm.toFixed(1)),
          neighbourReachKm: SensorSimulator.NEIGHBOUR_REACH_KM,
          zoneCount: this.zones.length,
          zoneLayout: this.config.zoneLayout
        },
        'Zones are further apart than the H3 neighbour ring reaches, so no two of them are ' +
          'adjacent. Incidents will all be singletons and the collapse ratio will be zero ' +
          'regardless of how the correlation engine behaves. Raise NUM_ZONES or shrink ' +
          'ZONE_REGION_EXTENT_KM before treating this run as a measurement.'
      );
    }
  }

  /** Reach of a one-ring H3 neighbourhood at resolution 5, give or take. */
  private static readonly NEIGHBOUR_REACH_KM = 25;

  /** Relative ground-truth paths resolve against the repo root, not the service directory. */
  private resolveGroundTruthDir(): string {
    const configured = this.config.groundTruthDir;
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(__dirname, '..', '..', '..', configured);
  }

  /**
   * Start the simulation
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Simulator is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting sensor simulation');

    this.loop.start();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received shutdown signal');
      await this.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received termination signal');
      await this.stop();
      process.exit(0);
    });
  }

  /**
   * Stop the simulation
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping sensor simulation');
    this.isRunning = false;
    this.loop.stop();

    await this.kafkaProducer.disconnect();

    const duration = (Date.now() - this.startTime) / 1000;
    const rate = this.eventCounter / duration;
    logger.info(
      {
        duration,
        totalEvents: this.eventCounter,
        averageRate: rate,
        simulatedSeconds: this.clock.elapsedMs / 1000,
        simulatedNow: new Date(this.clock.now()).toISOString(),
        runId: this.runId
      },
      'Simulation summary'
    );
  }

  /** Resolves once an eval run has emitted its last step. Never resolves for an open run. */
  async waitForCompletion(): Promise<void> {
    if (this.stopAtEventTime === null) {
      return new Promise<void>(() => {});
    }
    await new Promise<void>((resolve) => {
      this.onComplete = resolve;
    });
  }

  private onComplete: (() => void) | null = null;

  /**
   * Emit one event per zone for each simulated step in this firing, then publish the batch.
   *
   * At high speed multipliers a single firing covers several steps; batching their events into
   * one Kafka send keeps the producer call rate bounded while the event stream stays identical
   * to what a 1x run would produce.
   */
  private async emitSteps(stepTimes: number[]): Promise<void> {
    const events: SensorEvent[] = [];
    let reachedEnd = false;

    for (const simNow of stepTimes) {
      if (this.stopAtEventTime !== null && simNow > this.stopAtEventTime) {
        reachedEnd = true;
        break;
      }
      for (const zone of this.zones) {
        events.push(LoadGenerator.generateEvent(zone, this.config.scenario, simNow, this.anomalies));
        this.eventCounter++;
      }
    }

    try {
      if (events.length > 0) {
        await this.kafkaProducer.sendEvents(events);

        if (this.eventCounter % this.config.logEveryNEvents < events.length) {
          this.logProgress(events[events.length - 1]);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error sending events');
    } finally {
      if (reachedEnd) {
        logger.info(
          { runId: this.runId, simulatedHours: Number((this.config.runDurationMs / 3_600_000).toFixed(2)) },
          'Reached the end of the planned simulated run'
        );
        await this.stop();
        this.onComplete?.();
      }
    }
  }

  /**
   * Log simulation progress
   */
  private logProgress(sampleEvent: SensorEvent): void {
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = (this.eventCounter / duration).toFixed(1);

    logger.info(
      {
        eventCount: this.eventCounter,
        rate,
        zoneId: sampleEvent.zoneId,
        load: sampleEvent.load,
        eventTime: new Date(sampleEvent.eventTimestamp).toISOString(),
        simulatedSeconds: this.clock.elapsedMs / 1000
      },
      'Simulation progress'
    );

    // Log zone distribution info periodically
    if (this.eventCounter % (this.config.logEveryNEvents * 10) < 1) {
      this.logZoneSummary();
    }
  }

  /**
   * Log summary of zone configurations
   */
  private logZoneSummary(): void {
    const zoneSummaries = this.zones.slice(0, 5).map(zone => ({
      zoneId: zone.zoneId,
      latitude: zone.latitude.toFixed(2),
      longitude: zone.longitude.toFixed(2),
      baseLoad: zone.baseLoad.toFixed(2)
    }));

    logger.info({ zones: zoneSummaries, totalZones: this.zones.length }, 'Zone summary');
  }
}
