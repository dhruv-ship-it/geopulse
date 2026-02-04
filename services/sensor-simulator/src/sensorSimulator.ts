import { ZoneGenerator } from './zoneGenerator';
import { LoadGenerator } from './loadGenerator';
import { KafkaEventProducer } from './kafkaProducer';
import { loadConfig } from './config';
import { ZoneConfig, SensorEvent } from './types';

/**
 * Main sensor simulator orchestrator
 * Manages zone generation, event creation, and Kafka publishing
 */
export class SensorSimulator {
  private config = loadConfig();
  private zones: ZoneConfig[] = [];
  private kafkaProducer: KafkaEventProducer;
  private isRunning: boolean = false;
  private eventCounter: number = 0;
  private startTime: number = 0;

  constructor() {
    this.kafkaProducer = new KafkaEventProducer();
  }

  /**
   * Initialize the simulator
   */
  async initialize(): Promise<void> {
    console.log('🚀 Initializing GeoPulse Sensor Simulator...');
    console.log(`📊 Configuration: ${this.config.numberOfZones} zones, ${this.config.eventsPerSecond} events/sec`);
    console.log(`🎭 Scenario: ${this.config.scenario}`);
    console.log(`📝 Logging every ${this.config.logEveryNEvents} events`);

    // Generate zones
    this.zones = ZoneGenerator.generateZones(this.config.numberOfZones);
    console.log(`📍 Generated ${this.zones.length} zones with geographic distribution`);

    // Connect to Kafka
    await this.kafkaProducer.connect();
    
    this.startTime = Date.now();
    console.log('✅ Simulator initialized and ready');
  }

  /**
   * Start the simulation
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Simulator is already running');
      return;
    }

    this.isRunning = true;
    console.log('▶️ Starting sensor simulation...');
    
    // Calculate interval based on events per second
    const intervalMs = 1000 / this.config.eventsPerSecond;
    
    // Start the event generation loop
    const intervalId = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(intervalId);
        return;
      }
      
      this.generateAndSendEvents();
    }, intervalMs);

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
   * Stop the simulation
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('⏹️ Stopping sensor simulation...');
    this.isRunning = false;
    
    await this.kafkaProducer.disconnect();
    
    const duration = (Date.now() - this.startTime) / 1000;
    console.log(`📈 Simulation summary:`);
    console.log(`   - Duration: ${duration.toFixed(1)} seconds`);
    console.log(`   - Total events: ${this.eventCounter}`);
    console.log(`   - Average rate: ${(this.eventCounter / duration).toFixed(1)} events/sec`);
  }

  /**
   * Generate and send events for current time slice
   */
  private async generateAndSendEvents(): Promise<void> {
    const producedAt = Date.now();
    const events: SensorEvent[] = [];

    // Generate one event per zone
    for (const zone of this.zones) {
      const event = LoadGenerator.generateEvent(zone, this.config.scenario, producedAt);
      events.push(event);
      this.eventCounter++;
    }

    try {
      // Send all events in batch
      await this.kafkaProducer.sendEvents(events);
      
      // Log progress
      if (this.eventCounter % this.config.logEveryNEvents === 0) {
        this.logProgress(events[0]);
      }
    } catch (error) {
      console.error('❌ Error sending events:', error);
    }
  }

  /**
   * Log simulation progress
   */
  private logProgress(sampleEvent: SensorEvent): void {
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = (this.eventCounter / duration).toFixed(1);
    
    console.log(`📊 Progress: ${this.eventCounter} events | ${rate} events/sec | Zone ${sampleEvent.zoneId} load: ${sampleEvent.load}`);
    
    // Log zone distribution info periodically
    if (this.eventCounter % (this.config.logEveryNEvents * 10) === 0) {
      this.logZoneSummary();
    }
  }

  /**
   * Log summary of zone configurations
   */
  private logZoneSummary(): void {
    console.log('🌍 Zone Summary:');
    this.zones.slice(0, 5).forEach(zone => {
      console.log(`   ${zone.zoneId}: (${zone.latitude.toFixed(2)}, ${zone.longitude.toFixed(2)}) base=${zone.baseLoad.toFixed(2)}`);
    });
    if (this.zones.length > 5) {
      console.log(`   ... and ${this.zones.length - 5} more zones`);
    }
  }
}