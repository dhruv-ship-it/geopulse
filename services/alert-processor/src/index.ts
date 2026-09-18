import 'dotenv/config';
import { KafkaDeadLetterProducer } from '@geopulse/kafka-recovery';
import { Kafka } from 'kafkajs';

import { logger } from './logger';
import { KafkaAlertConsumer } from './kafkaConsumer';
import { KafkaIncidentConsumer } from './incidentConsumer';
import { IncidentRepository } from './incidentRepository';
import { RedisClient } from './redisClient';
import { PostgresClient } from './postgresClient';
import { runMigrations } from './migrate';
import { AlertProcessor } from './alertProcessor';
import { register, alertsConsumedTotal } from './metrics';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';

/**
 * The persistence service: everything the pipeline emits that has to outlive Redis.
 *
 * ## Why this is one process with two consumers, and not a sixth service
 *
 * WP3 item 6 allows either "extend `alert-processor`" or "add a small `incident-processor`".
 * This is the first, and the reasoning is that the two jobs are the *same* job: take a Kafka
 * topic, make it durable in Postgres, and do it under the delivery semantics ADR-000 settled.
 * A second process would duplicate the Postgres pool, the DLQ producer, the metrics endpoint,
 * the Dockerfile and the ownership of `migrations/` — all of it to gain independence that two
 * consumer groups inside one process already provide. The consumers have separate offsets and
 * separate failure domains; a stalled incident write does not hold up degradation persistence,
 * because each holds its own pooled connection.
 *
 * What a separate service *would* buy is independent scaling and independent deployment, and
 * neither is a live concern: incident events are two to three orders of magnitude rarer than
 * degradations (that ratio is the project's headline claim), so the load they add is noise. If
 * that ever stops being true, this file is the seam — the two consumers share nothing but
 * connections.
 *
 * The directory is still called `alert-processor` and the table is still `zone_alerts`. Both are
 * legacy names flagged for WP7; renaming a directory is a mechanical commit and renaming a table
 * is a migration plus every query in `api`, and neither buys anything the topic rename has not.
 */
async function main(): Promise<void> {
  logger.info('Starting GeoPulse persistence service (degradations + incidents)');

  const kafkaConsumer = new KafkaAlertConsumer();
  const redisClient = new RedisClient();
  const postgresClient = new PostgresClient();

  // One Kafka client for the incident consumer and its dead letter producer. The degradation
  // consumer keeps its own, because it was there first and its DLQ producer is already wired to
  // it; sharing more than this would couple two things whose whole point is to be separable.
  const incidentKafka = new Kafka({ clientId: 'incident-persister', brokers: [KAFKA_BROKER] });
  const incidentDeadLetter = new KafkaDeadLetterProducer(incidentKafka);
  const incidentConsumer = new KafkaIncidentConsumer({
    kafka: incidentKafka,
    deadLetter: incidentDeadLetter
  });

  try {
    await kafkaConsumer.connect();
    // Before the consumer: if we cannot dead-letter we cannot safely commit after a failure,
    // and that is worth discovering at startup.
    await incidentDeadLetter.connect();
    await incidentConsumer.connect();
    await redisClient.connect();
    await postgresClient.connect();
    // Before either consumer starts. The files are idempotent DDL applied in name order; see
    // migrate.ts for why this is not left to Postgres's initdb hook.
    const applied = await runMigrations(postgresClient.getClient());
    logger.info({ migrations: applied }, 'Schema ready');

    const alertProcessor = new AlertProcessor(redisClient.getClient(), postgresClient);
    const incidentRepository = new IncidentRepository(postgresClient.getClient());

    await kafkaConsumer.startConsuming(async (degradation) => {
      alertsConsumedTotal.inc();
      await alertProcessor.persistAlert(degradation);
    });

    await incidentConsumer.startConsuming(async (event) => {
      await incidentRepository.persist(event);
    });

    // Start metrics server
    const metricsPort = parseInt(process.env.METRICS_PORT || '9091');
    const metricsServer = require('http').createServer(async (req: any, res: any) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } else if (req.url === '/health') {
        // Reports what the service has actually done, not just that it is listening. A
        // persister that is connected to everything and has consumed nothing passes every
        // liveness check and is doing no work at all — which is what D10 looked like.
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'ok',
            incidents: { consumer: incidentConsumer.stats(), repository: incidentRepository.stats() }
          })
        );
      } else {
        res.writeHead(404).end();
      }
    });

    metricsServer.listen(metricsPort, () => {
      logger.info({ port: metricsPort }, 'Metrics server started');
    });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(
        { signal, incidents: incidentRepository.stats() },
        'Received shutdown signal'
      );
      // Consumers first: stop taking new work before tearing down what processes it.
      await kafkaConsumer.disconnect();
      await incidentConsumer.disconnect();
      await incidentDeadLetter.disconnect();
      await redisClient.disconnect();
      await postgresClient.disconnect();
      metricsServer.close();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ error: err }, 'Persistence service failed to start');
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
