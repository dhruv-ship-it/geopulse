import { ZoneGenerator } from './zoneGenerator';
import { LoadGenerator } from './loadGenerator';
import { KafkaEventProducer } from './kafkaProducer';
import { loadConfig } from './config';
import { ZoneConfig, SensorEvent } from './types';
import { logger } from './logger';

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
    logger.info({ numberOfZones: this.config.numberOfZones, eventsPerSecond: this.config.eventsPerSecond, scenario: this.config.scenario, logEveryNEvents: this.config.logEveryNEvents }, 'Initializing GeoPulse Sensor Simulator');

    // Generate zones
    this.zones = ZoneGenerator.generateZones(this.config.numberOfZones);
    logger.info({ zoneCount: this.zones.length }, 'Generated zones with geographic distribution');

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
    
    await this.kafkaProducer.disconnect();
    
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = this.eventCounter / duration;
    logger.info({ duration, totalEvents: this.eventCounter, averageRate: rate }, 'Simulation summary');
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
      logger.error({ error }, 'Error sending events');
    }
  }

  /**
   * Log simulation progress
   */
  private logProgress(sampleEvent: SensorEvent): void {
    const duration = (Date.now() - this.startTime) / 1000;
    const rate = (this.eventCounter / duration).toFixed(1);
    
    logger.info({ eventCount: this.eventCounter, rate, zoneId: sampleEvent.zoneId, load: sampleEvent.load }, 'Simulation progress');
    
    // Log zone distribution info periodically
    if (this.eventCounter % (this.config.logEveryNEvents * 10) === 0) {
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