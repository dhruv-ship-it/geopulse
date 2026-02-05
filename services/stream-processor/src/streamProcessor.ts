import { SensorEvent, ZoneStateData, StateTransitionAlert, ZoneState } from './types';
import { TimeWindowManager } from './timeWindowManager';
import { StateMachine } from './stateMachine';
import { KafkaEventConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { RedisWriter } from './redisWriter';
import { KafkaAlertProducer, ZoneAlert } from './kafkaProducer';
import { logger } from './logger';
import { sensorEventsProcessedTotal, stateTransitionsTotal, alertsPublishedTotal, alertPublishLatencyMs } from './metrics';

/**
 * Main stream processor that consumes events and derives operational states
 * Implements event-time sliding windows and state machine logic
 */
export class StreamProcessor {
  private consumer: KafkaEventConsumer;
  private redisClient: RedisClient;
  private redisWriter?: RedisWriter;
  private alertProducer?: KafkaAlertProducer;
  private zoneStates: Map<string, ZoneStateData> = new Map<string, ZoneStateData>();
  private zoneCoordinates: Map<string, { latitude: number; longitude: number }> = new Map();
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
    logger.info({ duration, totalEvents: this.eventCounter, stateTransitions: this.transitionCounter, averageRate: rate }, 'Processing summary');
  }

  /**
   * Handle incoming sensor event
   */
  private async handleEvent(event: SensorEvent): Promise<void> {
    this.eventCounter++;
    sensorEventsProcessedTotal.inc();
    
    // Store zone coordinates
    if (!this.zoneCoordinates.has(event.zoneId)) {
      this.zoneCoordinates.set(event.zoneId, {
        latitude: event.latitude,
        longitude: event.longitude
      });
    }
    
    // Get or create zone state
    let zoneState = this.zoneStates.get(event.zoneId);
    if (!zoneState) {
      zoneState = this.createZoneState();
      this.zoneStates.set(event.zoneId, zoneState);
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
      const coordinates = this.zoneCoordinates.get(event.zoneId);
      if (coordinates) {
        await this.redisWriter.writeZoneState(
          event.zoneId,
          zoneState,
          coordinates.latitude,
          coordinates.longitude
        );
      }
    }

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
    const currentState = this.zoneStates.get(event.zoneId)?.currentState;
    
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
    const zoneSummaries = Array.from(this.zoneStates.entries()).map(([zoneId, stateData]) => {
      const avg1m = TimeWindowManager.calculateAverage(stateData.window1m);
      const avg5m = TimeWindowManager.calculateAverage(stateData.window5m);
      return {
        zoneId,
        currentState: stateData.currentState,
        avg1m: avg1m.toFixed(3),
        avg5m: avg5m.toFixed(3)
      };
    });
    
    logger.info({ zones: zoneSummaries }, 'Zone state summary');
  }
}