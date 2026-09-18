import 'dotenv/config';
import { NeighbourGraph } from '@geopulse/spatial';

import { describeConfig, loadConfig } from './config';
import { CorrelationEngine } from './correlationEngine';
import { IncidentDispatcher } from './incidentDispatcher';
import { IncidentStore } from './incidentStore';
import { KafkaDegradationConsumer } from './kafkaConsumer';
import { KafkaIncidentProducer } from './kafkaProducer';
import { logger } from './logger';
import { register } from './metrics';
import { RedisClient } from './redisClient';
import { ZoneRegistry } from './zoneRegistry';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ geometry: describeConfig(config) }, 'Starting GeoPulse Correlation Engine');

  const redisClient = new RedisClient(config.redisHost, config.redisPort, config.redisPassword);
  const consumer = new KafkaDegradationConsumer({
    broker: config.kafkaBroker,
    topic: config.degradationsTopic,
    groupId: config.consumerGroup,
    fromBeginning: config.fromBeginning,
    maxBatchSize: config.maxBatchSize
  });
  const producer = new KafkaIncidentProducer(config.kafkaBroker, config.incidentsTopic);

  let metricsServer: ReturnType<typeof import('http').createServer> | null = null;
  let shuttingDown = false;

  try {
    await redisClient.connect();
    await producer.connect();
    await consumer.connect();

    // The neighbour graph is shared: the registry writes zones into it, the engine's
    // connectivity structure reads adjacency out of it. One object, so a zone discovered on the
    // degradation stream is adjacent to its neighbours in the very same batch.
    const graph = new NeighbourGraph();
    const registry = new ZoneRegistry(redisClient.getClient(), graph);
    await registry.load();
    registry.startBackgroundRefresh(config.zoneRefreshIntervalMs);

    const engine = new CorrelationEngine(graph, registry, {
      windowMs: config.correlationWindowMs,
      compactionIntervalMs: config.compactionIntervalMs,
      minZones: config.incidentMinZones,
      closeGraceMs: config.incidentCloseGraceMs,
      reconcileTickMs: config.reconcileTickMs
    });

    const store = new IncidentStore(redisClient.getClient(), {
      closedTtlSeconds: config.closedIncidentTtlSeconds
    });
    const dispatcher = new IncidentDispatcher(producer, store);

    await consumer.startConsuming(async (messages) => {
      // Fold, then get the result out. Nothing is caught here: a dispatch failure must escape
      // eachBatch so the offsets are not resolved (defect D1), and the dispatcher keeps the
      // events for the retry because the re-fold will not produce them again.
      await dispatcher.dispatch(engine.applyBatch(messages));
    });

    metricsServer = require('http').createServer(async (req: any, res: any) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } else if (req.url === '/health') {
        // Deliberately reports what the engine believes rather than just '200 ok'. A correlation
        // engine that is connected to everything and has consumed nothing looks healthy by every
        // liveness check and is doing no work at all — which is exactly what defect D10 looked
        // like for a week.
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'ok',
            geometry: describeConfig(config),
            engine: engine.stats(),
            registry: registry.stats(),
            consumer: consumer.stats(),
            dispatcher: dispatcher.stats(),
            store: store.stats()
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    metricsServer!.listen(config.metricsPort, () => {
      logger.info({ port: config.metricsPort }, 'Metrics server started');
    });

    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal, engine: engine.stats() }, 'Shutting down');

      registry.stopBackgroundRefresh();
      // Consumer first: stop taking new work before tearing down what processes it.
      await consumer.disconnect();

      // Then close out the final partial tick. The grid reconciles a boundary when a later
      // message crosses it, and on shutdown there is no later message — so without this the
      // last interval's incidents are never announced. Dispatch failures are logged rather
      // than rethrown: there are no offsets left to withhold at this point, and failing the
      // shutdown would leave the process alive with its consumer already gone.
      try {
        const final = engine.flush();
        if (final.length > 0) {
          await dispatcher.dispatch(final);
          logger.info({ events: final.length }, 'Flushed the final reconcile tick');
        }
      } catch (err) {
        logger.error({ error: err }, 'Failed to flush the final tick on shutdown');
      }

      await producer.disconnect();
      await redisClient.disconnect();
      metricsServer?.close();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ error: err }, 'Correlation engine failed to start');
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled Rejection');
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.fatal({ error: err }, 'Uncaught Exception');
  process.exit(1);
});

main();
