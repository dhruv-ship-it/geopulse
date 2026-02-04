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
    console.error('❌ Failed to start simulator:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the application
main();