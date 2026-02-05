import 'dotenv/config';
import { logger } from './logger';
import { StreamProcessor } from './streamProcessor';

/**
 * Main entry point for the stream processor
 */
async function main(): Promise<void> {
  const processor = new StreamProcessor();
  
  try {
    await processor.initialize();
    await processor.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start stream processor');
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled Rejection');
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught Exception');
  process.exit(1);
});

// Start the application
main();