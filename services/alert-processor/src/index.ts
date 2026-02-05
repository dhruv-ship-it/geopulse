import 'dotenv/config';
import { KafkaAlertConsumer } from './kafkaConsumer';
import { RedisClient } from './redisClient';
import { AlertProcessor } from './alertProcessor';

async function main(): Promise<void> {
  console.log('🚀 Starting GeoPulse Alert Processor...');

  const kafkaConsumer = new KafkaAlertConsumer();
  const redisClient = new RedisClient();

  try {
    await kafkaConsumer.connect();
    await redisClient.connect();

    const alertProcessor = new AlertProcessor(redisClient.getClient());

    await kafkaConsumer.startConsuming(async (alert) => {
      // As per Phase 4 rules: side-effect only, no business logic
      await alertProcessor.persistAlert(alert);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received shutdown signal...');
      await kafkaConsumer.disconnect();
      await redisClient.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received termination signal...');
      await kafkaConsumer.disconnect();
      await redisClient.disconnect();
      process.exit(0);
    });

  } catch (err) {
    console.error('❌ Alert processor failed to start:', err);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

main();
