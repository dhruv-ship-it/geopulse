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

### Degradation emission

One message to `zone.degradations` per *state change*, in both directions, keyed by the zone's
**coarse H3 cell**. Nothing is published while a state holds, and a repeat transition inside a
second is suppressed.

Three things about that sentence are decisions, not details:

**It is not called an alert any more.** An alert is a claim that something is worth a human's
attention, and one sensor crossing a threshold is not that claim. This stage emits *observations
that a zone's degradation state changed*; deciding which of them add up to something worth
telling a person is `correlation-engine`'s job, and it is the whole thesis of the project
(`docs/01-ARCHITECTURE.md` §4.1).

**The key is the coarse cell, not the zone id.** Keying by `zoneId` is right for the stage
*upstream* — per-zone windowing needs all of a zone's events together — and exactly wrong here,
because it hashes geographic neighbours uniformly at random across partitions and correlation's
entire question is whether two zones are next to each other. ADR-004.

**Recoveries are published too.** A transition to `NORMAL` travels on this topic like any other.
Without it the correlation window holds a recovered zone as an incident member for the rest of
`CORRELATION_WINDOW_MS` — up to two minutes of an incident reported over ground that is already
fine — and incidents would only ever close on a timeout rather than on evidence.

## 📊 `ZoneDegradation` format

```json
{
  "zoneId": "Z-3",
  "h3Cell": "85283473fffffff",
  "h3CoarseCell": "83283ffffffffff",
  "latitude": 50.51,
  "longitude": 10.14,
  "previousState": "STRESSED",
  "currentState": "CRITICAL",
  "severity": 0.92,
  "avg1m": 0.92,
  "avg5m": 0.81,
  "eventTime": 1707123456789
}
```

`severity` is `max(avg1m, avg5m)`, clamped to [0, 1] — three states are not enough for an
incident spanning sixty zones to say how bad it is, and the max is the worst thing either window
the detector actually consults has to say. `src/severity.ts` has the argument against a mean.

`eventTime` is event time and nothing else: not `Date.now()`, and not the Kafka record timestamp,
which the producer deliberately does not set. Retention is evaluated against the record
timestamp, and this pipeline's event time sits at a fixed historical epoch — that mismatch
destroyed 5.76M messages as defect D10. ADR-007.

### What happens when a publish fails

Bounded retry, then the dead letter queue, then — only if the DLQ is also unreachable — a throw,
which stops the offset committing and lets the raw event be redelivered. A degradation is a fact
nothing re-emits, so it gets the expensive policy. The raw *sensor events* this service consumes
get the cheap one (retry, then drop-and-count), because each is one sample of a signal re-sampled
every second. Both halves of that are argued in `docs/adr/ADR-000-delivery-semantics-and-dlq.md`.

## 🎯 Integration with Phase 1

### Running it
The whole stack, including this service, comes up with `cd infra && docker compose up -d --build`.
To run it from source against that stack instead, stop the container and:

```bash
cd packages/spatial && npm install          # builds dist/ via prepare
cd packages/kafka-recovery && npm install   # likewise
cd services/stream-processor && npm install && npm run dev
```

The broker advertises `localhost:9092` to the host and `kafka:29092` inside the network, so both
work against the same data.

### Expected Behavior
- Processor consumes events from `raw.zone.events`
- Maintains per-zone state in memory, bounded by an event-time idle TTL (D5)
- Registers every zone it sees in `zones:registry`, including ones that never leave NORMAL —
  the correlation engine needs their positions to build the neighbour graph
- Publishes one `zone.degradations` message per state change, in both directions
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