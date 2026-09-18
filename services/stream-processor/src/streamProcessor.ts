import {
  SensorEvent,
  StateTransitionAlert,
  ZoneDegradation,
  ZoneState,
  ZoneStateData
} from './types';
import { TimeWindowManager } from './timeWindowManager';
import { StateMachine } from './stateMachine';
import { KafkaEventConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { RedisWriter } from './redisWriter';
import { KafkaDegradationProducer } from './kafkaProducer';
import { severityOf } from './severity';
import { ZoneEntry, ZoneStateStore } from './zoneStateStore';
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
 * How much event time may pass before a still-degraded zone says so again.
 *
 * ## Defect D14: this service is edge-triggered, the correlation window is level-expecting
 *
 * `StateMachine.shouldAlert` fires only when a zone *changes* state, which is exactly right for
 * something that persists transitions. It is exactly wrong as the only input to a correlation
 * window whose membership rule is "a zone is an active member while it has degraded within the
 * last `CORRELATION_WINDOW_MS`".
 *
 * The first end-to-end run showed the consequence, and it is severe. A regional fault ran for 2.4
 * simulated hours; 62 zones crossed into STRESSED over about 80 seconds and then sat there,
 * steadily degraded, emitting nothing because nothing changed. The correlation engine's watermark
 * froze, its 120-second window expired every member, and the incident **closed while the fault was
 * still happening** — then re-opened in fragments when the zones eventually recovered. One fault,
 * seven incidents, and a 2.2-hour hole in the middle during which the system believed everything
 * was fine.
 *
 * Both halves were behaving as designed. The mismatch was in how they were joined: one emits
 * edges, the other integrates levels.
 *
 * ## Why re-assert rather than make membership permanent
 *
 * The alternative is to keep a zone a member until an explicit recovery arrives, dropping the
 * window entirely. That trades this bug for a worse one: a `stream-processor` that dies holding
 * degraded zones leaves them in an incident forever, because the recovery that would release them
 * is never produced. Time-bounded membership means the system's belief decays without evidence,
 * which is the property you want from a monitoring system. Re-assertion is what *supplies* that
 * evidence — and it makes true the claim ADR-000's amendment already rested on, that a degradation
 * is one sample of a re-sampled signal rather than a one-off edge.
 *
 * ## Choosing the interval
 *
 * It must be comfortably below `CORRELATION_WINDOW_MS` (120 s), or a member expires between
 * re-assertions and the incident flickers. 30 s gives four assertions per window, so it takes
 * three consecutive publish failures to drop a zone.
 *
 * The cost is bounded and small: one message per degraded zone per interval. A 62-zone fault is
 * about 2 messages/s, and even all 400 zones degrading at once is ~13/s — against the 400/s of raw
 * sensor events this same service is already consuming. Set it to 0 to disable, which restores the
 * edge-only behaviour for anyone who wants to reproduce D14.
 */
const DEGRADATION_REASSERT_MS = parseInt(process.env.DEGRADATION_REASSERT_MS || '30000', 10);

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
  private reassertCounter: number = 0;
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
        reassertionsPublished: this.reassertCounter,
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
      await this.publishDegradation(
        event,
        entry,
        previousState,
        nextState,
        avg1m,
        avg5m,
        'transition'
      );

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
    } else if (
      nextState !== 'NORMAL' &&
      DEGRADATION_REASSERT_MS > 0 &&
      (zoneState.lastDegradationPublishedAt === null ||
        event.eventTimestamp - zoneState.lastDegradationPublishedAt >= DEGRADATION_REASSERT_MS)
    ) {
      // The zone has not changed state, and that is exactly the case this exists for: it is
      // still degraded and nothing would otherwise say so. See DEGRADATION_REASSERT_MS (D14).
      await this.publishDegradation(event, entry, nextState, nextState, avg1m, avg5m, 'reassert');
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
   * Build and publish one `ZoneDegradation`, and remember when we did.
   *
   * Shared by the transition path and the re-assertion path so the two cannot describe a zone
   * differently — a re-assertion carrying a stale severity would be worse than no re-assertion at
   * all, because it would look like evidence.
   */
  private async publishDegradation(
    event: SensorEvent,
    entry: ZoneEntry,
    previousState: ZoneState,
    currentState: ZoneState,
    avg1m: number,
    avg5m: number,
    reason: 'transition' | 'reassert'
  ): Promise<void> {
    if (!this.degradationProducer) {
      return;
    }

    const degradation: ZoneDegradation = {
      zoneId: event.zoneId,
      h3Cell: entry.cells.h3Cell,
      h3CoarseCell: entry.cells.h3CoarseCell,
      latitude: entry.coordinates.latitude,
      longitude: entry.coordinates.longitude,
      previousState,
      currentState,
      severity: severityOf(avg1m, avg5m),
      avg1m,
      avg5m,
      // Event time, from the event. Not Date.now(), and not the Kafka record timestamp —
      // ADR-007, and the 5.76M messages D10 cost.
      eventTime: event.eventTimestamp
    };

    // Publishes, or retries, or dead-letters, or throws — see KafkaDegradationProducer.
    // Deliberately not wrapped in try/catch: a throw from here must reach eachMessage so the
    // offset is not committed. That is defect D1.
    const start = Date.now();
    await this.degradationProducer.publish(degradation);
    degradationPublishLatencyMs.observe(Date.now() - start);

    const direction =
      reason === 'reassert' ? 'reassert' : currentState === 'NORMAL' ? 'recovery' : 'degradation';
    degradationsPublishedTotal.labels(direction).inc();
    if (direction === 'recovery') {
      this.recoveryCounter++;
    } else if (direction === 'reassert') {
      this.reassertCounter++;
    } else {
      this.degradationCounter++;
    }

    // Advanced only on a successful publish. One that failed and was dead-lettered has told the
    // correlation engine nothing, so the next event should try again rather than sit out another
    // whole interval.
    entry.state.lastDegradationPublishedAt = event.eventTimestamp;

    const producerStats = this.degradationProducer.stats();
    degradationsDeadLetteredTotal.inc(producerStats.deadLettered - this.deadLetteredSeen);
    this.deadLetteredSeen = producerStats.deadLettered;
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
      lastAlertTimestamp: null,
      lastDegradationPublishedAt: null
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