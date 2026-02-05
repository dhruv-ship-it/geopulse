# GeoPulse - Geolocation Monitoring Platform

GeoPulse is a production observability platform for real-time geolocation monitoring with durable historical analytics.

## Architecture

### Data Flow
```
sensor-simulator → Kafka (sensor.events) → stream-processor → Redis (zone state)
                                                    ↓
                                            Kafka (zone.alerts) → alert-processor → Redis + PostgreSQL
                                                    ↓
                                            Express API (Redis for real-time, PostgreSQL for analytics)
```

## Services

| Service | Purpose | Data Store |
|---------|---------|------------|
| sensor-simulator | Generates deterministic geo-distributed sensor events | - |
| stream-processor | Sliding window aggregation, state machine | Redis |
| alert-processor | Consumes alerts, persists to Redis & PostgreSQL | Redis, PostgreSQL |
| api | Read-only HTTP endpoints | Redis, PostgreSQL |

## Phases

### Phase 1-4: Real-Time System (Complete)
- Sensor simulation with configurable zones
- Stream processing with time windows (1m, 5m)
- State machine (NORMAL → STRESSED → CRITICAL)
- Redis materialized state
- Alert publishing and Redis persistence

### Phase 5: PostgreSQL Analytics Layer (New)
Adds durable historical persistence and analytics.

**What's New:**
- PostgreSQL database for long-term alert storage
- Dual-write pattern: alerts go to both Redis (fast) and PostgreSQL (durable)
- Analytics endpoints for compliance and reporting

**PostgreSQL Schema:**
```sql
CREATE TABLE zone_alerts (
  id SERIAL PRIMARY KEY,
  zone_id VARCHAR(10) NOT NULL,
  previous_state VARCHAR(20) NOT NULL,
  current_state VARCHAR(20) NOT NULL,
  avg1m DOUBLE PRECISION NOT NULL,
  avg5m DOUBLE PRECISION NOT NULL,
  timestamp BIGINT NOT NULL
);
```

**Analytics Endpoints:**
- `GET /analytics/zones/:zoneId/alerts?from=&to=` - Historical alerts by zone
- `GET /analytics/alerts/recent?limit=50` - Recent global alerts
- `GET /analytics/zones/top-critical?days=7` - Zones with most critical alerts

## Data Ownership

| Data | Source |
|------|--------|
| Current zone state | Redis |
| Recent alerts (100/zone) | Redis |
| Historical alerts | PostgreSQL |
| Analytics | PostgreSQL |
| State transitions | Stream Processor |

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 18+

### Start Infrastructure
```bash
cd infra
docker-compose up -d
```

This starts:
- Zookeeper & Kafka (ports 2181, 9092)
- Redis (port 6380)
- PostgreSQL (port 5432)

### Environment Setup
```bash
cp .env.example .env
```

### Install Dependencies
```bash
cd services/sensor-simulator && npm install
cd services/stream-processor && npm install
cd services/alert-processor && npm install
cd services/api && npm install
```

### Start Services

1. **Stream Processor** (must be running first):
```bash
cd services/stream-processor
npm run dev
```

2. **Alert Processor**:
```bash
cd services/alert-processor
npm run dev
```

3. **API**:
```bash
cd services/api
npm run dev
```

4. **Sensor Simulator** (generates data):
```bash
cd services/sensor-simulator
npm run dev
```

## API Documentation

### Real-Time Endpoints (Redis-backed)
- `GET /health` - Health check
- `GET /zones/:zoneId` - Current zone state
- `GET /zones?state=CRITICAL` - Zones by state
- `GET /zones/near?lat=0&lon=0&radiusKm=50` - Geo query
- `GET /alerts/:zoneId` - Recent zone alerts
- `GET /alerts/recent?limit=20` - Recent global alerts
- `GET /alerts?state=CRITICAL` - Alerts by state

### Analytics Endpoints (PostgreSQL-backed)
- `GET /analytics/zones/:zoneId/alerts?from=&to=` - Historical alerts by zone
- `GET /analytics/alerts/recent?limit=50` - Recent global alerts (from DB)
- `GET /analytics/zones/top-critical?days=7` - Top zones by critical count

## Configuration

All services use environment variables for configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| KAFKA_BROKER | localhost:9092 | Kafka broker address |
| REDIS_HOST | localhost | Redis host |
| REDIS_PORT | 6380 | Redis port |
| POSTGRES_HOST | localhost | PostgreSQL host |
| POSTGRES_PORT | 5432 | PostgreSQL port |
| POSTGRES_DB | geopulse | PostgreSQL database |
| POSTGRES_USER | geopulse | PostgreSQL user |
| POSTGRES_PASSWORD | geopulse | PostgreSQL password |
| PORT | 3000 | API server port |
| ALERT_HISTORY_LIMIT | 100 | Max alerts per zone in Redis |
| ALERT_GLOBAL_LIMIT | 1000 | Max alerts in global Redis list |

## State Machine Rules

| Transition | Condition | Confirmation |
|------------|-----------|--------------|
| NORMAL → STRESSED | avg5m ≥ 0.75 | 60 seconds |
| STRESSED → CRITICAL | avg1m ≥ 0.90 | 20 seconds |
| STRESSED → NORMAL | avg5m ≤ 0.65 | immediate |
| CRITICAL → STRESSED | avg5m ≤ 0.80 | immediate |

## Development

### Build All Services
```bash
cd services/sensor-simulator && npm run build
cd services/stream-processor && npm run build
cd services/alert-processor && npm run build
cd services/api && npm run build
```

### Database Migrations
Migrations are in `services/alert-processor/migrations/` and run automatically on PostgreSQL container startup.

## License
MIT
