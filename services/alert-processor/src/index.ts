import 'dotenv/config';
import { logger } from './logger';
import { KafkaAlertConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { PostgresClient } from './postgresClient';
import { AlertProcessor } from './alertProcessor';
import { register, alertsConsumedTotal } from './metrics';

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
      // Increment alert consumption counter
      alertsConsumedTotal.inc();
      
      // As per Phase 4 rules: side-effect only, no business logic
      await alertProcessor.persistAlert(alert);
    });

    // Start metrics server
    const metricsPort = parseInt(process.env.METRICS_PORT || '9091');
    const metricsServer = require('http').createServer(async (req: any, res: any) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } else {
        res.writeHead(404).end();
      }
    });
    
    metricsServer.listen(metricsPort, () => {
      logger.info({ port: metricsPort }, 'Metrics server started');
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
