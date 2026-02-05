import { createClient, RedisClientType } from 'redis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6380';

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

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
    console.log(`Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.disconnect();
    this.connected = false;
    console.log('Disconnected from Redis');
  }

  getClient(): RedisClientType {
    return this.client;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
