import 'dotenv/config';
import express, { Application } from 'express';
import { RedisClient } from './redisClient';
import { PostgresClient } from './postgresClient';
import zonesRouter from './routes/zones';
import alertsRouter from './routes/alerts';
import analyticsRouter from './routes/analytics';

const PORT = process.env.PORT || 3000;
const app: Application = express();

// Middleware
app.use(express.json());

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
  console.error('Unhandled error:', err);
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
      console.log(`GeoPulse API server listening on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Zone endpoints:`);
      console.log(`  GET /zones/:zoneId`);
      console.log(`  GET /zones?state=CRITICAL`);
      console.log(`  GET /zones/near?lat=0&lon=0&radiusKm=50`);
      console.log(`Alert endpoints:`);
      console.log(`  GET /alerts/:zoneId`);
      console.log(`  GET /alerts/recent?limit=20`);
      console.log(`  GET /alerts?state=CRITICAL`);
      console.log(`Analytics endpoints (PostgreSQL-backed):`);
      console.log(`  GET /analytics/zones/:zoneId/alerts?from=&to=`);
      console.log(`  GET /analytics/alerts/recent?limit=50`);
      console.log(`  GET /analytics/zones/top-critical?days=7`);
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived shutdown signal...');
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\nReceived termination signal...');
      await redisClient.disconnect();
      await postgresClient.disconnect();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
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
startServer();