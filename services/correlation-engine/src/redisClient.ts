import { createClient, RedisClientType } from 'redis';

import { logger } from './logger';

/**
 * Redis connection, same shape as the other services'.
 *
 * The password is a dev credential and its job is not secrecy. Port 6380 is occupied by an
 * unrelated project's Redis on the owner's machine; without a password, a GeoPulse service
 * started while geopulse-redis was down connected to it and corrupted both projects quietly.
 * AUTH turns that into an immediate, loud failure.
 */
export class RedisClient {
  private readonly client: RedisClientType;
  private connected = false;

  constructor(
    private readonly host: string,
    private readonly port: string,
    password: string
  ) {
    // Log the resolved target before connecting: when a connection fails or lands somewhere
    // unexpected, the first question is always "which Redis was that?".
    logger.info({ host, port, auth: 'password' }, 'Redis target resolved');

    this.client = createClient({
      url: `redis://${host}:${port}`,
      password
    });

    this.client.on('error', (error) => {
      logger.error({ error }, 'Redis client error');
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
    logger.info({ host: this.host, port: this.port }, 'Connected to Redis');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.disconnect();
    this.connected = false;
    logger.info('Disconnected from Redis');
  }

  getClient(): RedisClientType {
    return this.client;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
