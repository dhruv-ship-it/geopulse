import { Client, ClientConfig } from 'pg';

const DB_CONFIG: ClientConfig = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'geopulse',
  user: process.env.POSTGRES_USER || 'geopulse',
  password: process.env.POSTGRES_PASSWORD || 'geopulse',
};

export interface ZoneAlertRow {
  id: number;
  zone_id: string;
  previous_state: string;
  current_state: string;
  avg1m: number;
  avg5m: number;
  timestamp: number;
}

/**
 * PostgreSQL client for analytics queries
 * Phase 5: Read-only access to historical alert data
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
      throw err;
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
    }
  }

  /**
   * Get alerts for a specific zone within a time range
   */
  async getZoneAlerts(zoneId: string, from: number, to: number): Promise<ZoneAlertRow[]> {
    const query = `
      SELECT id, zone_id, previous_state, current_state, avg1m, avg5m, timestamp
      FROM zone_alerts
      WHERE zone_id = $1 AND timestamp >= $2 AND timestamp <= $3
      ORDER BY timestamp ASC
    `;
    
    const result = await this.client.query(query, [zoneId, from, to]);
    return result.rows;
  }

  /**
   * Get recent alerts globally
   */
  async getRecentAlerts(limit: number): Promise<ZoneAlertRow[]> {
    const query = `
      SELECT id, zone_id, previous_state, current_state, avg1m, avg5m, timestamp
      FROM zone_alerts
      ORDER BY timestamp DESC
      LIMIT $1
    `;
    
    const result = await this.client.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get zones sorted by number of CRITICAL alerts in the last N days
   */
  async getTopCriticalZones(days: number): Promise<{zone_id: string; critical_count: number}[]> {
    const query = `
      SELECT zone_id, COUNT(*) as critical_count
      FROM zone_alerts
      WHERE current_state = 'CRITICAL'
        AND timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${days} days') * 1000
      GROUP BY zone_id
      ORDER BY critical_count DESC
    `;
    
    const result = await this.client.query(query);
    return result.rows;
  }

  getClient(): Client {
    return this.client;
  }

  isReady(): boolean {
    return this.isConnected;
  }
}
