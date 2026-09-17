import { ZoneGenerator } from './zoneGenerator';
import { LoadGenerator } from './loadGenerator';
import { KafkaEventProducer } from './kafkaProducer';
import { loadConfig } from './config';
import { ZoneConfig, SensorEvent } from './types';
import { VirtualClock } from './virtualClock';
import { SimulationLoop } from './simulationLoop';
import { logger } from './logger';

/**
 * Main sensor simulator orchestrator
 * Manages zone generation, event creation, and Kafka publishing
 *
 * Simulated time is owned by a single VirtualClock shared by every zone; SimulationLoop decides
 * how fast that clock runs against the wall clock. Nothing on an emitted event comes from
 * `Date.now()` — see virtualClock.ts for why.
 */
export class SensorSimulator {
  private config = loadConfig();
  private zones: ZoneConfig[] = [];
  private kafkaProducer: KafkaEventProducer;
  private clock: VirtualClock;
  private loop: SimulationLoop;
  private isRunning: boolean = false;
  private eventCounter: number = 0;
  private startTime: number = 0;

  constructor() {
    this.kafkaProducer = new KafkaEventProducer();
    this.clock = new VirtualClock({
      startEpochMs: this.config.startEpochMs,
      stepMs: this.config.stepMs,
      speedMultiplier: this.config.speedMultiplier
    });
    this.loop = new SimulationLoop(this.clock, (stepTimes) => this.emitSteps(stepTimes));
  }

  /**
   * Initialize the simulator
   */
  async initialize(): Promise<void> {
    logger.info({ numberOfZones: this.config.numberOfZones, scenario: this.config.scenario, logEveryNEvents: this.config.logEveryNEvents }, 'Initializing GeoPulse Sensor Simulator');

    // Generate zones
    this.zones = ZoneGenerator.generateZones(this.config.numberOfZones);
    logger.info({ zoneCount: this.zones.length }, 'Generated zones with geographic distribution');

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

    // Connect to Kafka
    await this.kafkaProducer.connect();
    
    this.startTime = Date.now();
    logger.info('Simulator initialized and ready');
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
        simulatedNow: new Date(this.clock.now()).toISOString()
      },
      'Simulation summary'
    );
  }

  /**
   * Emit one event per zone for each simulated step in this firing, then publish the batch.
   *
   * At high speed multipliers a single firing covers several steps; batching their events into
   * one Kafka send keeps the producer call rate bounded while the event stream stays identical
   * to what a 1x run would produce.
   */
  private async emitSteps(stepTimes: number[]): Promise<void> {
    const events: SensorEvent[] = [];

    for (const simNow of stepTimes) {
      for (const zone of this.zones) {
        events.push(LoadGenerator.generateEvent(zone, this.config.scenario, simNow));
        this.eventCounter++;
      }
    }

    try {
      // Send all events in batch
      await this.kafkaProducer.sendEvents(events);
      
      // Log progress
      if (this.eventCounter % this.config.logEveryNEvents < events.length) {
        this.logProgress(events[events.length - 1]);
      }
    } catch (error) {
      logger.error({ error }, 'Error sending events');
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
