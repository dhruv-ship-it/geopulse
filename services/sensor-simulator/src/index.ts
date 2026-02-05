import 'dotenv/config';
import { logger } from './logger';
import { SensorSimulator } from './sensorSimulator';

/**
 * Main entry point for the sensor simulator
 */
async function main(): Promise<void> {
  const simulator = new SensorSimulator();
  
  try {
    await simulator.initialize();
    await simulator.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start simulator');
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