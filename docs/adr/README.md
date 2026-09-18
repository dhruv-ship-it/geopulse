# Architecture Decision Records

One short record per decision that had a real alternative. Format:

```
# ADR-00N — Title
## Status
Accepted | Superseded by ADR-00M
## Context
What problem forced a decision.
## Decision
What we chose.
## Alternatives considered
Each one, and the specific reason it lost.
## Consequences
What this costs us, including what it makes harder later.
```

These are interview preparation as much as documentation. The "Alternatives considered"
section is the most important one — being able to name what you rejected and why is what
separates a defended decision from an arbitrary one.

| ADR | Title | Written in |
|---|---|---|
| ADR-000 | Delivery semantics for alert persistence, and what happens on failure | WP0 ✅ |
| ADR-001 | H3 hex cells for adjacency, over geohash, spatial trees and raw distance | WP1 ✅ |
| ADR-002 | Incremental union-find with local rebuild on expiry | WP2a ✅ |
| ADR-003 | Incident identity, merge and split semantics | WP2b ✅ |
| ADR-004 | Partitioning on coarse H3 cells, and batching the correlation consumer | WP3 ✅ |
| ADR-005 | Simulated event time: one virtual clock, bounded per-zone lag, adjustable speed | WP6a ✅ |
| ADR-006 | Ground truth by construction: one severity function, two thresholds | WP6a ✅ |
| ADR-007 | A Kafka record timestamp is not application event time | S2c ✅ |
