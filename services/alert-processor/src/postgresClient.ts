import { Pool, PoolConfig } from 'pg';

const DB_CONFIG: PoolConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  // 5434: both 5432 and 5433 are held by other projects on the dev machine. Postgres already
  // fails loudly on a wrong connection because it demands a password; this is only about
  // being able to start at all.
  port: parseInt(process.env.POSTGRES_PORT || '5434', 10),
  database: process.env.POSTGRES_DB || 'geopulse',
  user: process.env.POSTGRES_USER || 'geopulse',
  password: process.env.POSTGRES_PASSWORD || 'geopulse',
  max: parseInt(process.env.POSTGRES_POOL_SIZE || '5', 10)
};

export interface ZoneAlertRow {
  zone_id: string;
  previous_state: string;
  current_state: string;
  avg1m: number;
  avg5m: number;
  timestamp: number;
}

/**
 * PostgreSQL access for durable persistence.
 *
 * ## A pool, not a single Client
 *
 * This service runs two independent Kafka consumers — `zone.degradations` and `zone.incidents` —
 * in one process (see `index.ts` for why one process). A `pg.Client` serialises every query onto
 * one connection, so the two consumers would queue behind each other and an incident write
 * holding a transaction open would stall degradation persistence entirely. That is precisely the
 * coupling that choosing one process over two was supposed to avoid, reintroduced one layer
 * down. A pool gives each consumer its own connection and keeps the two failure domains as
 * separate as the consumer groups already are.
 *
 * The pool is small on purpose. Postgres is not the bottleneck here and a large pool mostly buys
 * a larger number of connections to leak when something goes wrong.
 */
export class PostgresClient {
  private pool: Pool;
  private isConnected: boolean = false;

  constructor() {
    console.log(
      `Postgres target: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database} as ${DB_CONFIG.user}`
    );
    this.pool = new Pool(DB_CONFIG);
    // A pool emits errors for idle connections the server drops. Unhandled, they are an
    // uncaught 'error' event and the process exits — which is a service outage caused by a
    // connection nobody was using.
    this.pool.on('error', (err) => {
      console.error('Idle Postgres client error:', err);
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      // A pool connects lazily, which would defer a bad password or a missing database until
      // the first message arrives. One round trip here makes it a startup failure instead.
      await this.pool.query('SELECT 1');
      this.isConnected = true;
      console.log('✅ PostgreSQL pool connected');
    } catch (err) {
      console.error('❌ Failed to connect to PostgreSQL:', err);
      throw err; // Fail loudly as per requirements
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    try {
      await this.pool.end();
      this.isConnected = false;
      console.log('✅ PostgreSQL pool closed');
    } catch (err) {
      console.error('❌ Error disconnecting from PostgreSQL:', err);
      throw err;
    }
  }

  /**
   * Insert a zone degradation into PostgreSQL
   * Append-only operation - no updates, no deletes
   */
  async insertAlert(alert: ZoneAlertRow): Promise<void> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      INSERT INTO zone_alerts (zone_id, previous_state, current_state, avg1m, avg5m, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    const values = [
      alert.zone_id,
      alert.previous_state,
      alert.current_state,
      alert.avg1m,
      alert.avg5m,
      alert.timestamp
    ];

    try {
      await this.pool.query(query, values);
    } catch (err) {
      console.error('❌ Failed to insert degradation into PostgreSQL:', err);
      throw err; // Fail loudly - do not silently skip writes
    }
  }

  getClient(): Pool {
    return this.pool;
  }

  isReady(): boolean {
    return this.isConnected;
  }
}
