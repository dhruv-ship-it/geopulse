import { SensorEvent, ZoneStateData, StateTransitionAlert, ZoneState } from './types';
import { TimeWindowManager } from './timeWindowManager';
import { StateMachine } from './stateMachine';
import { KafkaEventConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { RedisWriter } from './redisWriter';
import { KafkaAlertProducer, ZoneAlert } from './kafkaProducer';
import { ZoneStateStore } from './zoneStateStore';
import { logger } from './logger';
import { sensorEventsProcessedTotal, stateTransitionsTotal, alertsPublishedTotal, alertPublishLatencyMs, zonesTrackedGauge, zonesEvictedTotal } from './metrics';

/**
 * Main stream processor that consumes events and derives operational states
 * Implements event-time sliding windows and state machine logic
 */
export class StreamProcessor {
  private consumer: KafkaEventConsumer;
  private redisClient: RedisClient;
  private redisWriter?: RedisWriter;
  private alertProducer?: KafkaAlertProducer;
  private zones: ZoneStateStore = new ZoneStateStore();
  private eventCounter: number = 0;
  private transitionCounter: number = 0;
  private startTime: number = 0;
  private isRunning: boolean = false;

  constructor() {
    this.consumer = new KafkaEventConsumer();
    this.redisClient = new RedisClient();
    // Note: alertProducer is initialized in initialize() to avoid async work in constructor
  }

  /**
   * Initialize the processor
   */
  async initialize(): Promise<void> {
    logger.info('Initializing GeoPulse Stream Processor');
    
    // Connect to Kafka
    await this.consumer.connect();

    // Initialize alert producer and connect
    this.alertProducer = new KafkaAlertProducer();
    await this.alertProducer.connect();
    
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
    if (this.alertProducer) {
      await this.alertProducer.disconnect();
    }
    await this.redisClient.disconnect();
    
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = this.eventCounter / duration;
    logger.info({ duration, totalEvents: this.eventCounter, stateTransitions: this.transitionCounter, averageRate: rate, zonesTracked: this.zones.size, zonesEvicted: this.zones.evicted }, 'Processing summary');
  }

  /**
   * Handle incoming sensor event
   */
  private async handleEvent(event: SensorEvent): Promise<void> {
    this.eventCounter++;
    sensorEventsProcessedTotal.inc();
    
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
      // Create alert object matching strict Phase 4 schema
      const alert: ZoneAlert = {
        zoneId: event.zoneId,
        previousState,
        currentState: nextState,
        avg1m,
        avg5m,
        timestamp: event.eventTimestamp
      };

      // Publish to Kafka (zone.alerts) — only on actual state transitions
      try {
        if (this.alertProducer) {
          const start = Date.now();
          await this.alertProducer.sendAlert(alert);
          
          // Observe latency and increment counter
          alertPublishLatencyMs.observe(Date.now() - start);
          alertsPublishedTotal.inc();
          
          logger.info({ zoneId: alert.zoneId, previousState: alert.previousState, currentState: alert.currentState }, 'Published alert to Kafka');
        }
      } catch (err) {
        logger.error({ error: err }, 'Failed to publish alert to Kafka');
        // Per Phase 4 rules: do not add retries or alter state machine behavior
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
      logger.info(
        { evicted: evicted.length, tracked: this.zones.size, watermark: this.zones.currentWatermark },
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