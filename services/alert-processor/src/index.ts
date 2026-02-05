import 'dotenv/config';
import { logger } from './logger';
import { KafkaAlertConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { PostgresClient } from './postgresClient';
import { AlertProcessor } from './alertProcessor';

async function main(): Promise<void> {
  logger.info('Starting GeoPulse Alert Processor');

  const kafkaConsumer = new KafkaAlertConsumer();
  const redisClient = new RedisClient();
  const postgresClient = new PostgresClient();

  try {
    await kafkaConsumer.connect();
    await redisClient.connect();
    await postgresClient.connect();

    const alertProcessor = new AlertProcessor(redisClient.getClient(), postgresClient);

    await kafkaConsumer.startConsuming(async (alert) => {
      // As per Phase 4 rules: side-effect only, no business logic
      await alertProcessor.persistAlert(alert);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received shutdown signal');
      await kafkaConsumer.disconnect();
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received termination signal');
      await kafkaConsumer.disconnect();
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });

  } catch (err) {
    logger.fatal({ error: err }, 'Alert processor failed to start');
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
