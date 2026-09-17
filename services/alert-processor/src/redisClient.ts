import { createClient, RedisClientType } from 'redis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6390';

/**
 * A dev credential, the same class of default as the committed Postgres one. Its job is not
 * secrecy — it is that a service pointed at the wrong Redis fails AUTH immediately instead of
 * silently reading and writing another project's data. Port 6380 is occupied by an unrelated
 * project's Redis on this machine; without a password, a GeoPulse service started while
 * geopulse-redis was down connected to it and corrupted both projects quietly.
 */
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'geopulse-dev';

export class RedisClient {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor() {
    // Log the resolved target before connecting: when a connection fails or lands somewhere
    // unexpected, the first question is always "which Redis was that?".
    console.log(`Redis target: ${REDIS_HOST}:${REDIS_PORT} (password auth)`);

    this.client = createClient({
      url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
      password: REDIS_PASSWORD
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
