import { SensorEvent, ZoneStateData, StateTransitionAlert, ZoneState } from './types';
import { TimeWindowManager } from './timeWindowManager';
import { StateMachine } from './stateMachine';
import { KafkaEventConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { RedisWriter } from './redisWriter';

/**
 * Main stream processor that consumes events and derives operational states
 * Implements event-time sliding windows and state machine logic
 */
export class StreamProcessor {
  private consumer: KafkaEventConsumer;
  private redisClient: RedisClient;
  private redisWriter?: RedisWriter;
  private zoneStates: Map<string, ZoneStateData> = new Map<string, ZoneStateData>();
  private zoneCoordinates: Map<string, { latitude: number; longitude: number }> = new Map();
  private eventCounter: number = 0;
  private transitionCounter: number = 0;
  private startTime: number = 0;
  private isRunning: boolean = false;

  constructor() {
    this.consumer = new KafkaEventConsumer();
    this.redisClient = new RedisClient();
  }

  /**
   * Initialize the processor
   */
  async initialize(): Promise<void> {
    console.log('Initializing GeoPulse Stream Processor...');
    
    // Connect to Kafka
    await this.consumer.connect();
    
    // Connect to Redis
    await this.redisClient.connect();
    this.redisWriter = new RedisWriter(this.redisClient.getClient());
    
    this.startTime = Date.now();
    console.log('Stream processor initialized and ready');
  }

  /**
   * Start processing events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Processor is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting stream processing...');
    
    // Start consuming events
    await this.consumer.startConsuming(this.handleEvent.bind(this));

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received shutdown signal...');
      await this.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received termination signal...');
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

    console.log('Stopping stream processor...');
    this.isRunning = false;
    
    await this.consumer.disconnect();
    await this.redisClient.disconnect();
    
    const duration = (Date.now() - this.startTime) / 1000;
    console.log('Processing summary:');
    console.log(`  - Duration: ${duration.toFixed(1)} seconds`);
    console.log(`  - Total events processed: ${this.eventCounter}`);
    console.log(`  - State transitions: ${this.transitionCounter}`);
    console.log(`  - Average rate: ${(this.eventCounter / duration).toFixed(1)} events/sec`);
  }

  /**
   * Handle incoming sensor event
   */
  private async handleEvent(event: SensorEvent): Promise<void> {
    this.eventCounter++;
    
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
    
    if (StateMachine.shouldAlert(
      previousState,
      nextState,
      zoneState.lastAlertTimestamp,
      event.eventTimestamp
    )) {
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
    console.log('🚨 STATE TRANSITION ALERT 🚨');
    console.log(JSON.stringify(alert, null, 2));
    console.log('─'.repeat(50));
  }

  /**
   * Log processing progress
   */
  private logProgress(event: SensorEvent, avg1m: number, avg5m: number): void {
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = (this.eventCounter / duration).toFixed(1);
    
    console.log(`📊 Progress: ${this.eventCounter} events | ${rate} events/sec`);
    console.log(`   Zone ${event.zoneId}: load=${event.load.toFixed(3)}, avg1m=${avg1m.toFixed(3)}, avg5m=${avg5m.toFixed(3)}, state=${this.zoneStates.get(event.zoneId)?.currentState}`);
    
    // Log zone state summary
    if (this.eventCounter % 5000 === 0) {
      this.logZoneSummary();
    }
  }

  /**
   * Log summary of all zone states
   */
  private logZoneSummary(): void {
    console.log('🌍 Zone State Summary:');
    for (const [zoneId, stateData] of this.zoneStates.entries()) {
      const avg1m = TimeWindowManager.calculateAverage(stateData.window1m);
      const avg5m = TimeWindowManager.calculateAverage(stateData.window5m);
      console.log(`   ${zoneId}: ${stateData.currentState} (1m:${avg1m.toFixed(3)}, 5m:${avg5m.toFixed(3)})`);
    }
  }
}