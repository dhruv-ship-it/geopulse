// import 'dotenv/config';
import express, { Application } from 'express';
import { logger } from './logger';
import { RedisClient } from './redisClient';
import { PostgresClient } from './postgresClient';
import zonesRouter from './routes/zones';
import alertsRouter from './routes/alerts';
import analyticsRouter from './routes/analytics';

const PORT = process.env.PORT || 3000;
const app: Application = express();

// Middleware
app.use(express.json());

// Request ID middleware
app.use((req, res, next) => {
  (req as any).id = require('crypto').randomUUID();
  logger.info({ requestId: (req as any).id, method: req.method, path: req.path }, 'Incoming request');
  next();
});

// Redis client instance
const redisClient = new RedisClient();

// PostgreSQL client instance (Phase 5)
const postgresClient = new PostgresClient();

// Middleware to attach clients to request
app.use((req, res, next) => {
  (req as any).redisClient = redisClient.getClient();
  (req as any).postgresClient = postgresClient;
  next();
});

// Routes
app.use('/zones', zonesRouter);
app.use('/alerts', alertsRouter);
app.use('/analytics', analyticsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'geopulse-api',
    timestamp: Date.now()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ error: err, requestId: (req as any).id, method: req.method, path: req.path }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error'
  });
});

/**
 * Start the API server
 */
async function startServer(): Promise<void> {
  try {
    // Connect to Redis
    await redisClient.connect();
    
    // Connect to PostgreSQL (Phase 5)
    await postgresClient.connect();
    
    // Start server
    app.listen(PORT, () => {
      logger.info({ port: PORT }, 'GeoPulse API server started');
      logger.info({ healthCheck: `http://localhost:${PORT}/health` }, 'Health check available');
      logger.info({ zoneEndpoints: [
        'GET /zones/:zoneId',
        'GET /zones?state=CRITICAL',
        'GET /zones/near?lat=0&lon=0&radiusKm=50'
      ]}, 'Zone endpoints:');
      logger.info({ alertEndpoints: [
        'GET /alerts/:zoneId',
        'GET /alerts/recent?limit=20',
        'GET /alerts?state=CRITICAL'
      ]}, 'Alert endpoints:');
      logger.info({ analyticsEndpoints: [
        'GET /analytics/zones/:zoneId/alerts?from=&to=',
        'GET /analytics/alerts/recent?limit=50',
        'GET /analytics/zones/top-critical?days=7'
      ]}, 'Analytics endpoints (PostgreSQL-backed):');
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received shutdown signal');
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received termination signal');
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });
    
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
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
startServer();