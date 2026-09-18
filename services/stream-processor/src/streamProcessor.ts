import { SensorEvent, ZoneStateData, StateTransitionAlert, ZoneDegradation } from './types';
import { TimeWindowManager } from './timeWindowManager';
import { StateMachine } from './stateMachine';
import { KafkaEventConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { RedisWriter } from './redisWriter';
import { KafkaDegradationProducer } from './kafkaProducer';
import { severityOf } from './severity';
import { ZoneStateStore } from './zoneStateStore';
import { logger } from './logger';
import {
  degradationPublishLatencyMs,
  degradationsDeadLetteredTotal,
  degradationsPublishedTotal,
  sensorEventsProcessedTotal,
  stateTransitionsTotal,
  zonesEvictedTotal,
  zonesTrackedGauge
} from './metrics';

/**
 * Main stream processor that consumes events and derives operational states
 * Implements event-time sliding windows and state machine logic
 */
export class StreamProcessor {
  private consumer: KafkaEventConsumer;
  private redisClient: RedisClient;
  private redisWriter?: RedisWriter;
  private degradationProducer?: KafkaDegradationProducer;
  private zones: ZoneStateStore = new ZoneStateStore();
  private eventCounter: number = 0;
  private transitionCounter: number = 0;
  private degradationCounter: number = 0;
  private recoveryCounter: number = 0;
  /** Producer dead-letter tally already mirrored into the metric, so it is not double counted. */
  private deadLetteredSeen: number = 0;
  private startTime: number = 0;
  private isRunning: boolean = false;

  constructor() {
    this.consumer = new KafkaEventConsumer();
    this.redisClient = new RedisClient();
    // Note: the producers are initialized in initialize() to avoid async work in a constructor
  }

  /**
   * Initialize the processor
   */
  async initialize(): Promise<void> {
    logger.info('Initializing GeoPulse Stream Processor');
    
    // Connect to Kafka
    await this.consumer.connect();

    // Brings up its own dead letter producer on the same connection. See KafkaDegradationProducer.
    this.degradationProducer = new KafkaDegradationProducer();
    await this.degradationProducer.connect();
    
    // Connect to Redis
    await this.redisClient.connect();
    this.redisWriter = new RedisWriter(this.redisClient.getClient());
    
    this.startTime = Date.now();
    logger.info('Stream processor initialized and ready');
  }

  /**
   * Start processing events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Processor is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting stream processing');
    
    // Start consuming events
    await this.consumer.startConsuming(this.handleEvent.bind(this));

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
   * Stop processing
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping stream processor');
    this.isRunning = false;
    
    await this.consumer.disconnect();
    if (this.degradationProducer) {
      await this.degradationProducer.disconnect();
    }
    await this.redisClient.disconnect();
    
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = this.eventCounter / duration;
    const diagnostics = this.zones.diagnostics();
    const perZone = [...diagnostics.perZone.values()];
    logger.info(
      {
        duration,
        totalEvents: this.eventCounter,
        stateTransitions: this.transitionCounter,
        consumer: this.consumer.stats(),
        producer: this.degradationProducer?.stats(),
        degradationsPublished: this.degradationCounter,
        recoveriesPublished: this.recoveryCounter,
        averageRate: rate,
        zonesTracked: this.zones.size,
        zonesEvicted: this.zones.evicted,
        sweeps: diagnostics.sweeps,
        zonesEvictedAtLeastOnce: diagnostics.perZone.size,
        zonesEvictedMoreThanOnce: perZone.filter((n) => n > 1).length,
        maxEvictionsForOneZone: perZone.length ? Math.max(...perZone) : 0,
        maxZoneLagBehindWatermarkMs: diagnostics.maxLagBehindWatermarkMs,
        finalPartitionSkewMs: this.partitionSkewMs(),
        partitionHighWater: Object.fromEntries(this.partitionHighWater)
      },
      'Processing summary'
    );
  }

  /**
   * Handle incoming sensor event
   */
  private async handleEvent(event: SensorEvent, partition: number): Promise<void> {
    this.eventCounter++;
    sensorEventsProcessedTotal.inc();

    this.recordPartitionProgress(partition, event.eventTimestamp);
    
    // Track the zone and advance the event-time watermark. The store creates state on first
    // sight and evicts zones that have gone quiet, so the maps are bounded (D5).
    const entry = this.zones.observe(
      event.zoneId,
      event.latitude,
      event.longitude,
      event.eventTimestamp,
      () => this.createZoneState()
    );
    const zoneState = entry.state;

    // Publish the zone to the Redis registry the first time we see it. Separate from the
    // state write below because that only fires on a transition, and the correlation engine
    // needs the location and H3 cells of every zone — including ones that never leave NORMAL.
    if (!entry.registered && this.redisWriter) {
      try {
        await this.redisWriter.registerZone(
          event.zoneId,
          event.latitude,
          event.longitude,
          event.eventTimestamp
        );
        entry.registered = true;
      } catch (err) {
        // Leave it unregistered so the next event retries. Processing continues: windowing
        // does not depend on Redis.
        logger.error({ error: err, zoneId: event.zoneId }, 'Failed to register zone');
      }
    }

    // Add event to windows using event-time semantics
    TimeWindowManager.addEvent(
      zoneState.window1m, 
      event.eventTimestamp, 
      event.load, 
      TimeWindowManager.WINDOW_1M_SECONDS
    );
    
    TimeWindowManager.addEvent(
      zoneState.window5m, 
      event.eventTimestamp, 
      event.load, 
      TimeWindowManager.WINDOW_5M_SECONDS
    );

    // Calculate current averages
    const avg1m = TimeWindowManager.calculateAverage(zoneState.window1m);
    const avg5m = TimeWindowManager.calculateAverage(zoneState.window5m);

    // Store previous state for comparison
    const previousState = zoneState.currentState;

    // Determine next state using state machine
    const nextState = StateMachine.getNextState(
      zoneState.currentState,
      avg1m,
      avg5m,
      event.eventTimestamp,
      zoneState
    );

    // Check if state changed and should trigger alert
    const stateChanged = previousState !== nextState;
    
    // Increment state transition counter when state changes
    if (stateChanged) {
      stateTransitionsTotal.labels(previousState, nextState).inc();
    }
    
    if (StateMachine.shouldAlert(
      previousState,
      nextState,
      zoneState.lastAlertTimestamp,
      event.eventTimestamp
    )) {
      // Every transition is published, including the ones back down. A transition to NORMAL is
      // a *recovery*, and the correlation engine needs it: without it, a zone stays an incident
      // member until its correlation window expires, so an incident is reported over ground that
      // recovered up to CORRELATION_WINDOW_MS ago. Recoveries are also what let an incident
      // shrink and close on the evidence rather than on a timeout.
      const degradation: ZoneDegradation = {
        zoneId: event.zoneId,
        h3Cell: entry.cells.h3Cell,
        h3CoarseCell: entry.cells.h3CoarseCell,
        latitude: entry.coordinates.latitude,
        longitude: entry.coordinates.longitude,
        previousState,
        currentState: nextState,
        severity: severityOf(avg1m, avg5m),
        avg1m,
        avg5m,
        // Event time, from the event. Not Date.now(), and not the Kafka record timestamp —
        // ADR-007, and the 5.76M messages D10 cost.
        eventTime: event.eventTimestamp
      };

      // Publishes, or retries, or dead-letters, or throws — see KafkaDegradationProducer.
      // Deliberately not wrapped in try/catch here: a throw from this line must reach
      // eachMessage so the offset is not committed. That is defect D1.
      if (this.degradationProducer) {
        const start = Date.now();
        await this.degradationProducer.publish(degradation);
        degradationPublishLatencyMs.observe(Date.now() - start);

        const recovery = nextState === 'NORMAL';
        degradationsPublishedTotal.labels(recovery ? 'recovery' : 'degradation').inc();
        if (recovery) {
          this.recoveryCounter++;
        } else {
          this.degradationCounter++;
        }
        const producerStats = this.degradationProducer.stats();
        degradationsDeadLetteredTotal.inc(producerStats.deadLettered - this.deadLetteredSeen);
        this.deadLetteredSeen = producerStats.deadLettered;
      }

      // Emit local log alert (unchanged behavior)
      this.emitAlert({
        zoneId: event.zoneId,
        previousState,
        currentState: nextState,
        avg1m,
        avg5m,
        detectedAt: event.eventTimestamp
      });
      
      zoneState.lastAlertTimestamp = event.eventTimestamp;
      this.transitionCounter++;
    }

    // Update state first
    zoneState.currentState = nextState;

    // Write to Redis when state changes
    if (stateChanged && this.redisWriter) {
      await this.redisWriter.writeZoneState(
        event.zoneId,
        zoneState,
        entry.coordinates.latitude,
        entry.coordinates.longitude,
        event.eventTimestamp
      );
    }

    // Drop zones that have stopped reporting. Driven by the event-time watermark, so a
    // replay evicts at exactly the same points as the original run.
    const evicted = this.zones.sweep();
    if (evicted.length > 0) {
      zonesEvictedTotal.inc(evicted.length);
      const diagnostics = this.zones.diagnostics();
      const repeatedlyEvicted = [...diagnostics.perZone.values()].filter((n) => n > 1).length;
      logger.info(
        {
          evicted: evicted.length,
          tracked: this.zones.size,
          watermark: this.zones.currentWatermark,
          // The three numbers that tell a one-off eviction apart from a loop.
          partitionSkewMs: this.partitionSkewMs(),
          evictionsTotal: diagnostics.evictions,
          zonesEvictedMoreThanOnce: repeatedlyEvicted,
          sampleEvicted: evicted.slice(0, 5)
        },
        'Evicted idle zone state'
      );
    }
    zonesTrackedGauge.set(this.zones.size);

    // Log periodic updates
    if (this.eventCounter % 1000 === 0) {
      this.logProgress(event, avg1m, avg5m);
    }
  }

  /**
   * Highest event time seen on each partition, for D10 diagnosis.
   *
   * Kafka only guarantees order within a partition, and kafkajs drains partitions concurrently,
   * so each one is an independent stream of event time. How far apart they run is the quantity
   * the eviction bug turns on, and nothing was measuring it.
   */
  private readonly partitionHighWater = new Map<number, number>();

  private recordPartitionProgress(partition: number, eventTime: number): void {
    const current = this.partitionHighWater.get(partition);
    if (current === undefined || eventTime > current) {
      this.partitionHighWater.set(partition, eventTime);
    }
  }

  /** Spread between the fastest and slowest partition, in event-time milliseconds. */
  private partitionSkewMs(): number {
    if (this.partitionHighWater.size < 2) return 0;
    const values = [...this.partitionHighWater.values()];
    return Math.max(...values) - Math.min(...values);
  }

  /**
   * Create initial zone state
   */
  private createZoneState(): ZoneStateData {
    return {
      currentState: 'NORMAL',
      window1m: TimeWindowManager.createWindow(),
      window5m: TimeWindowManager.createWindow(),
      stressedSince: null,
      criticalSince: null,
      lastAlertTimestamp: null
    };
  }

  /**
   * Emit state transition alert
   */
  private emitAlert(alert: StateTransitionAlert): void {
    logger.warn(alert, 'State transition alert');
  }

  /**
   * Log processing progress
   */
  private logProgress(event: SensorEvent, avg1m: number, avg5m: number): void {
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = (this.eventCounter / duration).toFixed(1);
    const currentState = this.zones.get(event.zoneId)?.state.currentState;
    
    logger.info({ eventCount: this.eventCounter, rate, zoneId: event.zoneId, load: event.load, avg1m, avg5m, currentState }, 'Processing progress');
    
    // Log zone state summary
    if (this.eventCounter % 5000 === 0) {
      this.logZoneSummary();
    }
  }

  /**
   * Log summary of all zone states
   */
  private logZoneSummary(): void {
    const zoneSummaries = Array.from(this.zones.entries()).map(([zoneId, entry]) => {
      const avg1m = TimeWindowManager.calculateAverage(entry.state.window1m);
      const avg5m = TimeWindowManager.calculateAverage(entry.state.window5m);
      return {
        zoneId,
        currentState: entry.state.currentState,
        avg1m: avg1m.toFixed(3),
        avg5m: avg5m.toFixed(3)
      };
    });
    
    logger.info({ zones: zoneSummaries }, 'Zone state summary');
  }
}