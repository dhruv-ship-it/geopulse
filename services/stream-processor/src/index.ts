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
    console.error('❌ Failed to start stream processor:', error);
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