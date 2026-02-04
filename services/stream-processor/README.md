# GeoPulse Stream Processor

A Node.js/TypeScript service that consumes raw sensor events from Kafka and derives stable operational states using event-time sliding windows and a state machine.

## 🎯 Purpose

This service implements the core intelligence of GeoPulse - transforming raw sensor data into meaningful operational states (NORMAL/STRESSED/CRITICAL) using time-based reasoning and hysteresis-aware state transitions.

## 🏗️ Architecture

```
Stream Processor
├── Kafka Consumer (raw.zone.events)
├── Time Window Manager (1m & 5m sliding windows)
├── State Machine (NORMAL → STRESSED → CRITICAL)
└── Alert Emitter (console only for Phase 2)
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker (for Kafka)
- Kafka broker running at `localhost:9092`
- Sensor simulator running (Phase 1)

### 1. Install Dependencies
```bash
cd services/stream-processor
npm install
```

### 2. Run the Processor

**Development mode:**
```bash
npm run dev
```

**Development with auto-reload:**
```bash
npm run dev:watch
```

**Production mode:**
```bash
npm run build
npm start
```

## 🧠 Core Logic

### Sliding Windows
- **1-minute window**: Used for CRITICAL state detection
- **5-minute window**: Used for STRESSED state detection
- **Event-time based**: Uses `eventTimestamp`, not processing time
- **Bucketed by second**: O(1) update and eviction
- **Automatic expiration**: Old buckets removed efficiently

### State Machine
Exact transition rules with hysteresis:

**NORMAL → STRESSED**
- Condition: `avg5m ≥ 0.75`
- Confirmation: Must hold for ≥ 60 seconds
- Hysteresis: Timer resets if condition breaks

**STRESSED → CRITICAL**
- Condition: `avg1m ≥ 0.90`
- Confirmation: Must hold for ≥ 20 seconds
- Hysteresis: Timer resets if condition breaks

**CRITICAL → STRESSED**
- Condition: `avg5m ≤ 0.80`
- Immediate transition (no confirmation needed)

**STRESSED → NORMAL**
- Condition: `avg5m ≤ 0.65`
- Immediate transition (no confirmation needed)

**⚠️ Direct NORMAL → CRITICAL transitions are NOT allowed**

### Alert Emission
- **Only on state changes**: No continuous alerts
- **Deduplication**: Prevents duplicate alerts for same transition
- **Console output**: JSON-formatted alerts for Phase 2

## 📊 Alert Format

```json
{
  "zoneId": "Z-3",
  "previousState": "STRESSED",
  "currentState": "CRITICAL",
  "avg1m": 0.92,
  "avg5m": 0.81,
  "detectedAt": 1707123456789
}
```

## 🎯 Integration with Phase 1

### Running with Sensor Simulator
1. Start Kafka infrastructure: `cd infra && docker-compose up -d`
2. Start sensor simulator: `cd services/sensor-simulator && npm run dev`
3. Start stream processor: `cd services/stream-processor && npm run dev`

### Expected Behavior
- Processor consumes events from `raw.zone.events`
- Maintains per-zone state in memory
- Logs window metrics and state transitions
- Emits alerts only when states change
- Handles out-of-order events correctly (event-time semantics)

## 🔍 Monitoring Output

### Startup Logs
```
🚀 Initializing GeoPulse Stream Processor...
✅ Connected to Kafka broker: localhost:9092
✅ Subscribed to topic: raw.zone.events
✅ Consumer group: zone-stream-processor
✅ Stream processor initialized and ready
▶️ Started consuming messages
```

### Processing Logs
```
📊 Progress: 1000 events | 450.2 events/sec
   Zone Z-1: load=0.684, avg1m=0.652, avg5m=0.589, state=NORMAL
```

### State Transition Alerts
```
🚨 STATE TRANSITION ALERT 🚨
{
  "zoneId": "Z-3",
  "previousState": "NORMAL",
  "currentState": "STRESSED",
  "avg1m": 0.78,
  "avg5m": 0.76,
  "detectedAt": 1707123456789
}
──────────────────────────────────────────
```

### Summary Logs
```
🌍 Zone State Summary:
   Z-1: NORMAL (1m:0.523, 5m:0.487)
   Z-2: STRESSED (1m:0.821, 5m:0.765)
   Z-3: CRITICAL (1m:0.943, 5m:0.812)
```

## ⚙️ Configuration

Environment variables:
- `KAFKA_BROKER`: Kafka broker address (default: localhost:9092)

## 🧪 Testing Scenarios

### Normal Operation
- Verify steady state maintenance with low load
- Check proper window calculations
- Confirm no false alerts

### State Transitions
- **NORMAL → STRESSED**: Increase load to avg5m ≥ 0.75 for 60+ seconds
- **STRESSED → CRITICAL**: Further increase to avg1m ≥ 0.90 for 20+ seconds
- **CRITICAL → STRESSED**: Reduce load to avg5m ≤ 0.80
- **STRESSED → NORMAL**: Further reduce to avg5m ≤ 0.65

### Hysteresis Testing
- Break conditions during confirmation periods
- Verify timers reset properly
- Confirm no premature transitions

## 📁 Project Structure
```
stream-processor/
├── src/
│   ├── types.ts           # TypeScript interfaces
│   ├── timeWindowManager.ts # Efficient window operations
│   ├── stateMachine.ts    # State transition logic
│   ├── kafkaConsumer.ts   # Kafka integration
│   ├── streamProcessor.ts # Main orchestrator
│   └── index.ts          # Application entry point
├── package.json
├── tsconfig.json
└── README.md
```

## 🔧 Troubleshooting

**No events consumed:**
- Check Kafka connectivity
- Verify topic exists: `kafka-topics --list`
- Ensure sensor simulator is running

**Incorrect state transitions:**
- Check window calculations
- Verify event timestamps are correct
- Review state machine logic

**Performance issues:**
- Monitor event processing rate
- Check memory usage
- Review window eviction logic

## 🛑 Stopping the Processor

Press `Ctrl+C` to gracefully stop the processor. It will:
- Stop consuming events
- Disconnect from Kafka
- Show processing summary