# GeoPulse Alert Processor

Consumes `zone.alerts` Kafka topic and persists alert history in Redis.

Redis Keys:
- `alerts:zone:<ZONE_ID>` → LIST (LPUSH newest first, trimmed to `ALERT_HISTORY_LIMIT`)
- `alerts:global` → LIST (LPUSH newest first, trimmed to `ALERT_GLOBAL_LIMIT`)

Configuration (env):
- `KAFKA_BROKER` (default: `localhost:9092`)
- `REDIS_HOST` (default: `localhost`)
- `REDIS_PORT` (default: `6380`)
- `ALERT_HISTORY_LIMIT` (default: `100`)
- `ALERT_GLOBAL_LIMIT` (default: `1000`)

Run locally:

```
cd services/alert-processor
npm install
npm run dev
```
