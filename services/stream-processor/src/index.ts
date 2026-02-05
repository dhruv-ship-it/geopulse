import 'dotenv/config';
import { logger } from './logger';
import { StreamProcessor } from './streamProcessor';
import { register } from './metrics';

/**
 * Main entry point for stream processor
 */
async function main(): Promise<void> {
  const processor = new StreamProcessor();
  
  try {
    await processor.initialize();
    await processor.start();
    
    // Start metrics server
    const metricsPort = parseInt(process.env.METRICS_PORT || '9090');
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