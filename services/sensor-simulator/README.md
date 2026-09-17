# GeoPulse Sensor Simulator

A Node.js/TypeScript service that simulates geo-distributed sensors and publishes deterministic load events to Kafka.

## 🎯 Purpose

This service generates realistic sensor events for testing the GeoPulse event-driven system. It simulates multiple geographic zones with varying load patterns and publishes events to Kafka for downstream processing.

## 🏗️ Architecture

```
Sensor Simulator
├── Zone Generator (deterministic geographic distribution)
├── Load Generator (realistic load patterns with scenarios)
├── Kafka Producer (publishes to raw.zone.events)
└── Event Orchestrator (manages simulation flow)
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker (for Kafka)
- Kafka broker running at `localhost:9092`

### 1. Start Kafka Infrastructure
```bash
# From project root
cd infra
docker-compose up -d
```

### 2. Install Dependencies
```bash
cd services/sensor-simulator
npm install
```

### 3. Run the Simulator

**Development mode (with auto-reload):**
```bash
npm run dev:watch
```

**Production mode:**
```bash
npm run build
npm start
```

## ⚙️ Configuration

The simulator can be configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NUM_ZONES` | 10 | Number of geographic zones to simulate |
| `SCENARIO` | normal | Scenario type: normal, spike, drop |
| `LOG_EVERY_N` | 100 | Log progress every N events |
| `SIM_START_EPOCH_MS` | 1768478400000 | Simulated epoch the run starts at (2026-01-15T12:00:00Z) |
| `SIM_STEP_MS` | 1000 | Simulated ms per tick; one event per zone per tick |
| `SPEED_MULTIPLIER` | 1 | Simulated ms per real ms. 60 = a simulated minute every real second |
| `KAFKA_BROKER` | localhost:9092 | Kafka broker address |

### Simulated time

Every zone reads one shared virtual clock (`src/virtualClock.ts`). Event time is a pure function
of the tick count from `SIM_START_EPOCH_MS` — nothing on an emitted event comes from `Date.now()`
— so a run is reproducible and two zones can never drift apart. Per-zone sensor lag is still
applied, so events arrive out of order across zones, but it is a bounded offset (0–20 ms), not a
rate.

`SPEED_MULTIPLIER` changes how long a run takes in real time and nothing about what it contains:
a 60x run emits exactly the same events, with exactly the same timestamps, as a 1x run. The
stream processor needs 60 s of *event* time to confirm `STRESSED`, so 60x makes that observable
within a second.

There is no `EVENTS_PER_SECOND` any more — it conflated sampling density with simulation speed.
The real event rate is derived:

```
events per real second = NUM_ZONES * (1000 / SIM_STEP_MS) * SPEED_MULTIPLIER
```

### Example Configurations

**High-volume normal scenario** (50 zones, 4 samples/simulated second → 200 events/s):
```bash
NUM_ZONES=50 SIM_STEP_MS=250 SCENARIO=normal npm run dev
```

**Spike scenario at 60x, for watching state transitions without waiting:**
```bash
NUM_ZONES=20 SPEED_MULTIPLIER=60 SCENARIO=spike npm run dev
```

**Low-volume monitoring** (5 zones, 2 samples/simulated second → 10 events/s):
```bash
NUM_ZONES=5 SIM_STEP_MS=500 SCENARIO=normal LOG_EVERY_N=50 npm run dev
```

## 📊 Event Schema

Events are published to Kafka topic `raw.zone.events` with the following schema:

```json
{
  "eventId": "uuid",
  "zoneId": "Z-<number>",
  "latitude": number,
  "longitude": number,
  "load": number (0.0 to 1.0),
  "eventTimestamp": epoch_ms,
  "producedAt": epoch_ms
}
```

### Key Fields
- **eventId**: Unique UUID for each event
- **zoneId**: Deterministic zone identifier (Z-1, Z-2, etc.)
- **latitude/longitude**: Geographic coordinates
- **load**: Normalized load value (0.0 to 1.0)
- **eventTimestamp**: Simulated sensor time
- **producedAt**: Actual send time

## 🎭 Scenarios

### Normal
- Base load with realistic daily patterns
- 10% random noise for realism
- Time-of-day variations (business hours, night time)

### Spike
- Periodic load spikes every 30 seconds
- Spike multiplier: 3x base load
- Alternates between normal and spike states

### Drop
- Periodic load drops every 45 seconds
- Drop multiplier: 0.2x base load
- Alternates between normal and drop states

## 🔍 Verification

### Using Kafka CLI

**List topics:**
```bash
# Enter Kafka container
docker exec -it geopulse-kafka bash

# List topics
kafka-topics --bootstrap-server localhost:9092 --list
```

**Consume events:**
```bash
# Consume from raw.zone.events topic
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic raw.zone.events \
  --from-beginning \
  --max-messages 10
```

**Format JSON output:**
```bash
# Pretty-print JSON events
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic raw.zone.events \
  --from-beginning \
  --max-messages 5 \
  --value-deserializer org.apache.kafka.common.serialization.StringDeserializer | \
  jq '.'
```

**Monitor in real-time:**
```bash
# Continuous monitoring
kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic raw.zone.events \
  --from-beginning
```

### Expected Output Format
```json
{
  "eventId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "zoneId": "Z-1",
  "latitude": 40.7128,
  "longitude": -74.0060,
  "load": 0.684,
  "eventTimestamp": 1707123456789,
  "producedAt": 1707123456890
}
```

## 📈 Monitoring

The simulator provides real-time logging:

```
🚀 Initializing GeoPulse Sensor Simulator...
📊 Configuration: 10 zones, 50 events/sec
🎭 Scenario: normal
📝 Logging every 100 events
📍 Generated 10 zones with geographic distribution
✅ Connected to Kafka broker: localhost:9092
✅ Simulator initialized and ready
▶️ Starting sensor simulation...
📊 Progress: 100 events | 48.2 events/sec | Zone Z-1 load: 0.684
```

## 🛑 Stopping the Simulator

Press `Ctrl+C` to gracefully stop the simulator. It will:
- Stop event generation
- Disconnect from Kafka
- Show simulation summary

## 🏗️ Implementation Details

### Deterministic Generation
- Zone positions use Fibonacci spiral distribution
- Load patterns are deterministic but realistic
- Same configuration always produces same events

### Kafka Integration
- Uses `zoneId` as message key for proper partitioning
- Batches events by zone for efficient publishing
- Automatic topic creation
- Connection retry logic

### Performance
- Event generation: ~50,000 events/sec (configurable)
- Memory efficient zone management
- Non-blocking event publishing

## 🧪 Testing Scenarios

1. **Normal Operation**: Verify steady event flow with realistic patterns
2. **Spike Detection**: Test downstream processing of load spikes
3. **Drop Detection**: Validate handling of load drops
4. **High Volume**: Stress test with 100+ zones at high frequency
5. **Graceful Shutdown**: Verify clean shutdown and connection handling

## 📁 Project Structure
```
sensor-simulator/
├── src/
│   ├── types.ts          # TypeScript interfaces
│   ├── config.ts         # Configuration management
│   ├── zoneGenerator.ts  # Geographic zone generation
│   ├── loadGenerator.ts  # Load value generation
│   ├── kafkaProducer.ts  # Kafka integration
│   ├── sensorSimulator.ts # Main orchestrator
│   └── index.ts         # Application entry point
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 Troubleshooting

**Kafka Connection Issues:**
- Ensure Kafka is running: `docker-compose ps`
- Check broker address: `localhost:9092`
- Verify topic creation: `kafka-topics --list`

**Performance Issues:**
- Raise `SIM_STEP_MS` or lower `SPEED_MULTIPLIER` (both reduce the real event rate)
- Decrease `NUM_ZONES`
- Check system resources

**Event Validation:**
- Use Kafka CLI to consume and inspect events
- Verify JSON schema compliance
- Check timestamp ordering