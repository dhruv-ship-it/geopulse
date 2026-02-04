import express, { Application } from 'express';
import { RedisClient } from './redisClient';
import zonesRouter from './routes/zones';

const PORT = process.env.PORT || 3000;
const app: Application = express();

// Middleware
app.use(express.json());

// Redis client instance
const redisClient = new RedisClient();

// Middleware to attach Redis client to request
app.use((req, res, next) => {
  (req as any).redisClient = redisClient.getClient();
  next();
});

// Routes
app.use('/zones', zonesRouter);

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
    
    // Start server
    app.listen(PORT, () => {
      console.log(`GeoPulse API server listening on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Zone endpoints:`);
      console.log(`  GET /zones/:zoneId`);
      console.log(`  GET /zones?state=CRITICAL`);
      console.log(`  GET /zones/near?lat=0&lon=0&radiusKm=50`);
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nReceived shutdown signal...');
      await redisClient.disconnect();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\nReceived termination signal...');
      await redisClient.disconnect();
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