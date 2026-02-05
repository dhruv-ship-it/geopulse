import { Client, ClientConfig } from 'pg';

const DB_CONFIG: ClientConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'geopulse',
  user: process.env.POSTGRES_USER || 'geopulse',
  password: process.env.POSTGRES_PASSWORD || 'geopulse',
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
 * PostgreSQL client for durable alert persistence
 * Phase 5: Adds durable historical storage alongside Redis
 */
export class PostgresClient {
  private client: Client;
  private isConnected: boolean = false;

  constructor() {
    this.client = new Client(DB_CONFIG);
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    
    try {
      await this.client.connect();
      this.isConnected = true;
      console.log('✅ PostgreSQL client connected');
    } catch (err) {
      console.error('❌ Failed to connect to PostgreSQL:', err);
      throw err; // Fail loudly as per requirements
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    
    try {
      await this.client.end();
      this.isConnected = false;
      console.log('✅ PostgreSQL client disconnected');
    } catch (err) {
      console.error('❌ Error disconnecting from PostgreSQL:', err);
      throw err;
    }
  }

  /**
   * Insert a zone alert into PostgreSQL
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
      await this.client.query(query, values);
    } catch (err) {
      console.error('❌ Failed to insert alert into PostgreSQL:', err);
      throw err; // Fail loudly - do not silently skip writes
    }
  }

  getClient(): Client {
    return this.client;
  }

  isReady(): boolean {
    return this.isConnected;
  }
}
