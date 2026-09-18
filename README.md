# GeoPulse - Geolocation Monitoring Platform

GeoPulse is a production observability platform for real-time geolocation monitoring with durable historical analytics.

## Architecture

### Data Flow
```
sensor-simulator ─▶ Kafka raw.zone.events ─▶ stream-processor ─▶ Redis (zone state + registry)
                          (key: zoneId)              │
                                                     ▼
                                       Kafka zone.degradations ──┬─▶ alert-processor ─▶ Postgres
                                       (key: h3CoarseCell)       │      (degradation history)
                                                                 ▼
                                                        correlation-engine
                                                                 │
                                                                 ▼
                                                     Kafka zone.incidents ──┬─▶ Redis (live incidents)
                                                     (key: h3CoarseCell)    └─▶ alert-processor ─▶ Postgres
                                                                                 (incident history)
                                                                 │
                                                                 ▼
                                                            Express API
```

The partition key changes at `zone.degradations`, and that is the load-bearing decision in the
whole diagram. Per-zone windowing wants all of a zone's events on one partition, so
`raw.zone.events` is keyed by `zoneId`. Correlation wants the opposite: to decide whether two
zones belong to the same incident, one process has to see both, and hashing by `zoneId` scatters
geographic neighbours uniformly at random. Re-keying on the coarse H3 cell puts neighbours
together. See `docs/adr/ADR-004-coarse-cell-partitioning.md`.

## Services

| Service | Purpose | Data Store |
|---------|---------|------------|
| sensor-simulator | Deterministic geo-distributed sensor events, with injected faults and ground-truth labels | - |
| stream-processor | Per-zone sliding windows and state machine; emits `zone.degradations` | Redis |
| correlation-engine | Collapses adjacent co-degrading zones into incidents; emits `zone.incidents` | Redis |
| alert-processor | Persists both durable topics — degradations and incidents | Redis, PostgreSQL |
| api | Read-only HTTP endpoints | Redis, PostgreSQL |

Two shared packages, both `file:` dependencies rather than workspace members:
`packages/spatial` (H3 cells and the neighbour graph — two processes disagreeing about geometry
fails silently, so it cannot be copied) and `packages/kafka-recovery` (bounded retry, dead
lettering, and the offset discipline that makes them safe — see `docs/adr/ADR-000`).

## Phases

### Phase 1-4: Real-Time System (Complete)
- Sensor simulation with configurable zones
- Stream processing with time windows (1m, 5m)
- State machine (NORMAL → STRESSED → CRITICAL)
- Redis materialized state
- Alert publishing and Redis persistence

### Phase 6: Unit & Integration Testing (Complete)
- Jest-based unit tests for StateMachine logic
- Integration tests for Kafka → Redis alert flow
- Deterministic tests without external dependencies

### Phase 7: Observability with Prometheus (New)
Adds Prometheus-compatible metrics to measure system behavior without affecting runtime logic.

**Metrics Exposed:**
- **Stream Processor** (Port 9090): `sensor_events_processed_total`, `state_transitions_total`, `alerts_published_total`, `alert_publish_latency_ms`
- **Alert Processor** (Port 9091): `alerts_consumed_total`, `alerts_persisted_total{storage}`, `redis_alert_write_latency_ms`, `postgres_alert_write_latency_ms`
- **API Service** (Port 3000): `http_requests_total{method,route,status}`, `http_request_duration_ms{method,route}`

**How to Scrape:**
```yaml
scrape_configs:
  - job_name: 'geopulse'
    static_configs:
      - targets: 
        - 'localhost:9090'  # Stream Processor
        - 'localhost:9091'  # Alert Processor
        - 'localhost:3000'  # API Service
```

**Endpoint Access:**
- Stream Processor: `curl http://localhost:9090/metrics`
- Alert Processor: `curl http://localhost:9091/metrics`
- API Service: `curl http://localhost:3000/metrics`
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

### The whole stack, one command
```bash
cd infra && docker compose up -d --build
```

That brings up Zookeeper and Kafka (2181, 9092), Redis (6390, password required), PostgreSQL
(5434), creates the Kafka topics with their partition counts, starts all four pipeline services
and the API, and runs the simulator against `SCENARIO` — which defaults to `regional-anomaly`.
So the default `up` is the thing this project claims: one injected regional fault, one incident.

```bash
docker compose logs -f correlation-engine        # watch the incident open and grow
curl -s localhost:9093/health                    # what the engine believes right now
docker exec geopulse-postgres psql -U geopulse -d geopulse   -c "select incident_id, status, member_count from incidents;"
```

Other scenarios, without editing the compose file:
```bash
SCENARIO=multi-anomaly NUM_ZONES=800 docker compose up -d --build
```

Or bring the pipeline up with no load, which is what the eval harness wants:
```bash
docker compose up -d --build --scale simulator=0
```

Topics are not auto-created — every client has `allowAutoTopicCreation: false`, deliberately, so
a topic conjured with one partition cannot silently throw away the parallelism the keying was
designed to buy. The `kafka-bootstrap` container creates them and every service waits for it.

### Running a service on the host instead
The broker advertises two listeners: `kafka:29092` inside the compose network and
`localhost:9092` from the host. So a service can be stopped in Docker and run from source
against the same stack:
```bash
cd packages/spatial && npm install          # builds dist/ via prepare — do this first
cd packages/kafka-recovery && npm install   # likewise
cd services/correlation-engine && npm install && npm run dev
```
A "cannot find module '@geopulse/spatial'" failure means one of the first two steps was skipped.

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
| REDIS_PORT | 6390 | Redis port |
| REDIS_PASSWORD | geopulse-dev | Redis password; must match `--requirepass` in `infra/docker-compose.yml` |
| POSTGRES_HOST | localhost | PostgreSQL host |
| POSTGRES_PORT | 5434 | PostgreSQL port |
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
Migrations are in `services/alert-processor/migrations/` and are applied at startup by
`alert-processor`, which owns those tables. They used to be mounted into Postgres's
`docker-entrypoint-initdb.d`, which runs **only on an empty data directory** — so a migration
added later silently did not apply to anyone who already had a volume, and the only documented
fix was to delete the database. Every file is idempotent DDL, so re-applying the set is a no-op.
See `services/alert-processor/src/migrate.ts`, which is explicit that this is not a migration
tool and says what would replace it.

## License
MIT
