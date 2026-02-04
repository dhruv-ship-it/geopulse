import { createClient, RedisClientType } from 'redis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6380';

/**
 * Redis client for GeoPulse API service
 * Handles connection management for read operations
 */
export class RedisClient {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor() {
    this.client = createClient({
      url: `redis://${REDIS_HOST}:${REDIS_PORT}`
    });

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.client.connect();
      this.connected = true;
      console.log(`Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.client.disconnect();
      this.connected = false;
      console.log('Disconnected from Redis');
    } catch (error) {
      console.error('Error disconnecting from Redis:', error);
      throw error;
    }
  }

  /**
   * Get Redis client instance
   */
  getClient(): RedisClientType {
    return this.client;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}