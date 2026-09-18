# ADR-004 — Partition the correlation stage on coarse H3 cells, and batch the consumer

**Status.** Accepted (WP3, items 1–5 and 7). Item 6 (Postgres persistence) and item 8 (the
`stream-processor` producer change) are not yet built; this ADR fixes the keying they must use.
**Context.** `docs/01-ARCHITECTURE.md` §6 and §4.2, `docs/02-PHASE-1-CORRELATION.md` WP3.
**Relates to.** ADR-001 supplies the cell geometry. ADR-002 and ADR-003 are the algorithm this
partitioning has to feed. ADR-007 is why no record timestamp is set on the produced messages.

---

## Context

The existing pipeline partitions `raw.zone.events` by `zoneId`, and for the per-zone stage that
is exactly right: every event for a zone lands on one partition, one consumer owns that zone's
windows and state machine, and throughput scales linearly with partition count. Nothing is shared
between zones, so nothing has to be coordinated.

**Correlation breaks that property, and it breaks it at the root.** To decide whether Z-0147 and
Z-0148 belong to the same incident, one process has to see both. Hashing by `zoneId` distributes
geographic neighbours across partitions *uniformly at random* — it is not merely unhelpful, it is
precisely the opposite of what the work needs. A correlation consumer reading one `zoneId`
partition sees a random sample of the fleet and can correlate nothing.

So the correlation stage needs a different key, and the choice of key is the central
distributed-systems decision in Phase 1.

A second, smaller decision rides along with it, because it is forced by the same fact about the
workload: a regional fault does not produce one degradation, it produces a **burst**. In the
reference scenario — 400 zones, seed 42 — a `regional-anomaly` degrades 62 zones within a few
seconds of event time (`benchmarks/results/d10-after-fix.txt`). How the consumer reads that burst
decides what its output looks like.

## Decision

**Key `zone.degradations` by `h3CoarseCell` (H3 resolution 3, ~60 km edge), and key
`zone.incidents` by the coarse cell of the incident, fixed at the incident's first event.**

Correlation is *local*: an incident's members are within one H3 res-5 ring of each other, tens of
kilometres at most. A partition key at a resolution much coarser than a plausible incident radius
therefore keeps nearly every incident inside a single partition, while still splitting the world
into enough pieces to parallelise over.

**Consume with `eachBatch`, not `eachMessage`, and reconcile once per batch.**

The per-message alternative folds a 62-zone burst in one zone at a time, reconciling after each:
one `OPENED` followed by 61 `GREW` events, every one of them published to Kafka, written to
Redis, and eventually persisted to Postgres, each describing a state the next one immediately
obsoletes. `eachBatch` folds the whole burst in and reconciles once — one `OPENED` carrying all
62 members.

That is not a throughput optimisation with a correctness cost attached. The output is *better*:
the events describe the fault rather than the arrival order of the messages that revealed it.
Throughput is a side effect, and the real prize is that a human looking at `zone.incidents` sees
one thing happen once.

**Phase 1 runs one correlation consumer.** The keying is what makes more than one possible later;
running more than one now would buy nothing at this data volume and would immediately raise the
boundary problem below in its sharpest form.

## Alternatives considered

**Key by `zoneId`, as the rest of the pipeline does.** Rejected: it is the failure mode described
above. Geographic neighbours scatter uniformly, and no consumer ever holds two adjacent zones.

**Single partition, single consumer, no keying at all.** One process sees everything; correlation
is trivially correct. Rejected as the *permanent* answer and accepted as the current one — the
topic is keyed and multi-partition so that the scaling story is real rather than aspirational,
but only one consumer runs today. Being explicit about this matters: "it does not scale yet, here
is the key that makes it scale, and here is what I would have to solve first" is a defensible
position; discovering at scale that the key was wrong is not.

**Broadcast every degradation to every consumer.** Each consumer sees everything and filters.
Correct, and O(N) network amplification in the consumer count. Viable only while degradations are
rare, which is exactly when correlation matters least. Rejected.

**Key by the fine detection cell (res 5, ~8 km edge).** More partitions, better balance —
and an incident radius is routinely larger than a res-5 cell, so *most* incidents would straddle
a boundary rather than a small minority. The whole value of the scheme comes from the key being
much coarser than the thing being correlated. Rejected.

**Key `zone.incidents` by `incidentId`.** The natural-looking choice, and the same mistake in a
new place: it scatters one region's incidents across every partition, so a consumer rebuilding
regional state has to read all of them. Worse, an incident's own events would spread across
partitions, and a lifecycle stream read out of order is unreadable — a `MERGED` that arrives
before its `OPENED` refers to an incident the consumer has never heard of. Rejected, and the
engine fixes each incident's key at its first event so that this cannot happen by accident as an
incident grows across a cell boundary.

**Two-level: correlate locally per coarse cell, then merge across boundaries.** This is the
complete answer and it is deferred, not rejected. Each local incident that touches its cell
boundary is republished to a `boundary.incidents` topic keyed by the *parent* cell, where a second
correlation stage merges across boundaries — structurally the same move as a distributed spatial
join, or Pregel-style label propagation across partition boundaries. Deferred because Phase 1
runs one consumer, where the boundary problem cannot yet bite, and because building the merge
stage before there is anything to measure would be building it blind.

**`eachMessage` with a batched *flush*** — fold per message, but hold the emitted events and
publish them together. Rejected because it does not actually help: the 62 events are already
computed by then, and the consolidation this is after happens at `reconcile`, not at `publish`.
Suppressing them after the fact would mean deciding which of 62 correct events to discard, which
is strictly harder than not generating 61 of them.

## Consequences

**An incident straddling two coarse cells is seen as two incidents by two consumers.** Phase 1
accepts this, and it is the limitation to be able to state before being asked. How often it
happens is a function of coarse-cell size against incident radius and is a number to measure in
WP6b, not to estimate here. Today, with one consumer, it does not occur at all — one process sees
every partition — so the cost is deferred along with the scaling.

**Batching changes incident *names*, and this is worth understanding precisely.** Incident ids are
`SHA-256(scheme | openedAt | seed members)` (ADR-003), and `openedAt` is the watermark of the
reconcile that opened the incident. A coarser reconcile cadence therefore changes which watermark
an incident opens at, and can change its seed set — a component that formed and dissolved inside
one batch is never seen, and one that grew from three members to five inside a batch opens with
five. So:

- For a fixed message order **and a fixed batching**, output is byte-identical, ids included.
  `correlationEngine.test.ts` asserts exactly that, and it is the property the eval harness
  (WP6b) replays against.
- Two live runs over the same stream may name incidents differently, because batch boundaries are
  a broker fetch artefact. The set of incidents, their membership and their lifecycle do not
  differ in kind.

The alternative — reconciling on a fixed event-time cadence so the schedule is independent of
batching — was considered and not taken: it makes the *sweep* schedule deterministic (which
`CorrelationWindow.tick` already does) but not the fold, since a sweep still happens at whatever
watermark the batch ends on. It would add a second timing concept for a determinism guarantee
that measurement does not need, because measurement replays through the core directly.

**Delivery is at-least-once.** Offsets are resolved only after the batch has been published and
written (defect D1's lesson, ADR-000), so a crash in between redelivers. Every downstream write
is an idempotent overwrite keyed by a deterministic incident id, so a redelivered batch converges
to the same state, and a duplicate on `zone.incidents` is byte-identical to the event before it.

**The engine's state is in memory, and a redelivered batch emits nothing.** This is the
non-obvious consequence of at-least-once over a *stateful* consumer, and it is why
`IncidentDispatcher` exists. Re-folding a batch is idempotent — `admit` takes maxima, `activate`
re-runs unions, `reconcile` is a function of the current partition — so the second fold produces
the same state and therefore no transitions. Events from a failed flush would be lost silently.
They are held until a flush succeeds instead. A process *crash* still loses them, and the
correlation window with them; the window refills within `CORRELATION_WINDOW_MS` of stream time.
The fix, when it is worth it, is to snapshot engine state to a compacted topic, and it belongs
with the multi-consumer design rather than bolted onto a single-consumer Phase 1.

**A large batch has to heartbeat.** A fold longer than the session timeout gets the consumer
evicted mid-batch, which redelivers the work to somebody else and presents as a slow consumer
getting slower. The batch is sliced at `CORRELATION_MAX_BATCH_SIZE` with a heartbeat between
slices.
