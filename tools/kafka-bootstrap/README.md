# kafka-bootstrap

Creates the GeoPulse Kafka topics explicitly instead of letting producers auto-create them.

## Why this exists

Every client used to run with `allowAutoTopicCreation: true`. Topics therefore appeared with
broker defaults, which means **one partition**. The pipeline keys messages by `zoneId` precisely
so that work can be spread across consumers — with one partition that keying buys nothing, and
the scaling story is not actually demonstrated.

Auto-creation is now off everywhere. That makes a missing topic a loud startup failure rather
than a silent single-partition topic.

## Usage

```bash
cd tools/kafka-bootstrap
npm install
npm run bootstrap        # create topics, then print broker state
npm run describe         # print broker state only, create nothing
```

Configuration:

| Variable | Default | Meaning |
|---|---|---|
| `KAFKA_BROKER` | `localhost:9092` | Broker to connect to. |
| `KAFKA_TOPIC_PARTITIONS` | `12` | Partition count for the main topics. |
| `KAFKA_REPLICATION_FACTOR` | `1` | Single-broker dev cluster. |

## Gotcha

`createTopics` will not change the partition count of a topic that already exists. If you ran the
pipeline before this tool existed, your topics have 1 partition. Delete and recreate them:

```bash
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 \
  --delete --topic raw.zone.events
npm run bootstrap
```

Verify independently:

```bash
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 \
  --describe --topic raw.zone.events
```
