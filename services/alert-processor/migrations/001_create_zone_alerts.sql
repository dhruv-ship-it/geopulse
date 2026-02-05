-- Migration: Create zone_alerts table for GeoPulse Phase 5
-- This table stores durable historical alert data

CREATE TABLE IF NOT EXISTS zone_alerts (
  id SERIAL PRIMARY KEY,
  zone_id VARCHAR(10) NOT NULL,
  previous_state VARCHAR(20) NOT NULL,
  current_state VARCHAR(20) NOT NULL,
  avg1m DOUBLE PRECISION NOT NULL,
  avg5m DOUBLE PRECISION NOT NULL,
  timestamp BIGINT NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_zone_alerts_zone_id ON zone_alerts(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_alerts_timestamp ON zone_alerts(timestamp);
CREATE INDEX IF NOT EXISTS idx_zone_alerts_state ON zone_alerts(current_state);

-- Composite index for time-range queries by zone
CREATE INDEX IF NOT EXISTS idx_zone_alerts_zone_timestamp ON zone_alerts(zone_id, timestamp);
