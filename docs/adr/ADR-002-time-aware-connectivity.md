# ADR-002 — Incremental union-find with local rebuild on expiry, over a full recompute and over fully dynamic connectivity

**Status.** Accepted (WP2a — items 1 and 2 of WP2; `IncidentLifecycle` is WP2b).
**Context.** `docs/02-PHASE-1-CORRELATION.md` WP2, `docs/01-ARCHITECTURE.md` §5(b). Evidence:
`benchmarks/results/wp2-differential-fuzz.txt` (re-run with
`cd services/correlation-engine && npx jest differentialFuzz --verbose`).
**Relates to.** ADR-001 supplies the adjacency relation this operates over. ADR-003 (incident
identity) consumes the component partition this produces. ADR-005 supplies the event-time model.

---

## Context

An incident, in this system, is a connected component of a graph whose vertices are *zones
currently degraded* and whose edges are *H3 adjacency* (ADR-001). Both halves move:

- **Vertices arrive constantly.** Every degradation event either adds a member or renews one. At
  `SIM_STEP_MS=1000` a degrading zone emits a sample every simulated second.
- **Vertices leave.** A zone stops being a member `CORRELATION_WINDOW_MS` (120 s) after its most
  recent degradation, or immediately on a recovery event. Membership is decided in event time by
  `CorrelationWindow`, never by the wall clock, so a replay at 60× produces the same membership at
  the same instants as a replay at 1×.

So the structure has to answer "which components exist, and who is in each" continuously, under
both insertion and deletion.

**Union-find is the obvious tool and it is half a tool.** `union` plus `find` with path
compression and union by rank is O(α(n)) amortised, effectively constant, and it is exactly the
arrival path. What it does not have is a delete — and not as an oversight. Union-find is fast
precisely because it throws away the structure it merged over: it records *that* two elements
ended up in the same set and never which edge put them there. Remove the hub of a star and the
spokes still point at it, and nothing in the forest can say whether they were connected through
the hub or to each other. Deletion is not "unimplemented"; the information needed to do it was
deliberately discarded.

That is the decision this ADR records: what to do about deletes.

## Decision

**Keep union-find on the arrival path, and on deletion rebuild — but only the components that
lost a member.**

- **Arrival** (`activate`): make-set if new, then `union` with each active neighbour from
  `neighboursOf(zone)`. Path compression, union by rank. Re-run on every degradation, including
  refreshes, which is also how an edge the neighbour graph learned late gets picked up.
- **Deletion** (`compact` for a compaction tick, `deactivate` for a recovery — one code path,
  because a removal is a removal): collect the root of each departing member's component, tear
  those components down entirely, and rediscover each one's structure with a BFS over its
  surviving members. A component that lost nothing is not rebuilt, not walked, not read.

Cost of a removal batch is therefore **O(V + E) summed over the affected components**, not over
the active set.

**Each node carries a `next` pointer forming one circular list per component.** This is the piece
that makes the local rebuild possible at all: union-find can tell you whether two zones are
together but not *who else* is in there with them, and the rebuild needs precisely the survivors
of the component that just lost a member. Splicing two cycles on `union` is two pointer writes,
O(1), and — unlike a `Map<root, Set<member>>`, which has to move a set on every union — it stays
independent of which root union by rank happened to pick.

**Rebuild sorts its survivors before the BFS.** That costs O(k log k) on a small set and buys a
property worth much more: a rebuilt component is a function of *who survived* and the current
adjacency, never of the merge history of the component it replaced. Replay stability follows, and
so does the property the differential test leans on — that a rebuilt component is
indistinguishable from one built fresh.

### Why this is the right trade for *this* workload

The justification is two facts about the data, not an asymptotic argument in the abstract:

1. **Arrivals vastly outnumber expiries.** A zone that stays unhealthy re-degrades every sample
   interval (1 s) against a 120 s window, so it is refreshed on the order of 120 times for each
   time it leaves. Optimising deletion at the cost of insertion would be optimising the rare case.
2. **Components are small relative to the universe.** An incident covers tens of zones out of a
   fleet of thousands (`benchmarks/results/wp6a-degradation-check.txt`: 62 zones labelled for the
   reference regional anomaly, out of 400). Rebuilding one is cheap. Rebuilding all of them, every
   tick, is the thing being avoided.

Both are assumptions about the workload, so both are instrumented rather than asserted:
`stats().rebuilds` and `stats().rebuiltMembers` give the average component size actually being
paid for on the expiry path, and `maxRank` gives union by rank's height bound. If the workload
changes, those numbers say so before a benchmark does.

## Alternatives considered

### (a) Full recompute every tick — O(V + E) over the whole active set, every tick

**Rejected as the production path, adopted as the test oracle.** This is `NaiveConnectivity`, and
it is not dead code: it is the specification the optimised structure is tested against.

Against it: it throws away the entire result on every tick and rediscovers it, including for the
99% of components that did not change. Its cost is driven by total active membership, which is
exactly the quantity that grows during the storms this system exists to handle — the worse the
incident, the more it costs to reason about it.

For it: it is *obviously* correct. There is no incremental state to go stale, no merge order to
reason about, no expiry path to get wrong. You can read it in a minute and be sure it computes
connected components, because that is all it does.

Keeping it is what makes the optimised version defensible. `TimeAwareConnectivity` is fast because
it avoids recomputation, and every avoided recomputation is a place it can be subtly stale — and
those failures need a particular merge order, then a particular expiry, then a particular
re-arrival. Unit tests check the cases the author imagined. So both implementations answer one
`Connectivity` interface and are driven through the same `CorrelationWindow` with an identical
call sequence, with their partitions compared **after every operation**, not at the end: a stale
parent pointer can sit invisible for twenty operations before it decides a merge, and comparing
only the final state lets a later rebuild mask the bug that a rebuild happened to fix.

Measured (`benchmarks/results/wp2-differential-fuzz.txt`, seed 42):

| | |
|---|---|
| Sequences | 11,000 (10,000 random-graph + 1,000 over the real H3 graph + 1,000 reach-measuring) |
| Events applied | 551,871 |
| Partition comparisons | 551,871 |
| Component splits produced | 7,732 |
| Zones expired | 110,754 |
| Zones recovered early | 21,089 |
| Full teardowns (active set back to empty) | 5,305 |
| Largest component reached | 28 |
| **Divergences** | **0** |

The seed is pinned deliberately. A fuzz test that draws a fresh seed each run fails once on
someone else's machine and passes on the re-run, which gets a real bug filed as flakiness; pinned,
a failure reproduces exactly and buying new coverage is a deliberate act.

Two things had to be fixed before that table meant anything, and they are worth recording because
they are the failure mode of fuzz testing generally. fast-check biases array lengths small, so the
first version averaged **five events per sequence** — most of those 10,000 sequences never built a
multi-zone component at all. And nothing in the suite would have told us: a fuzz test that
explores nothing still passes. The generator now forces length (`size: 'max'` with a minimum), and
a second property asserts what the sequences actually *reach* — merges, splits, expiries,
recoveries, full teardowns — with floors well below current output, so a future change that guts
the fuzz fails there instead of passing everywhere.

### (b) Fully dynamic connectivity — Holm–de Lichtenberg–Thorup, or Euler-tour / link-cut trees

**Rejected: substantially more implementation complexity than our scale justifies.**

This is the structure that makes deletion genuinely cheap: O(log² n) amortised per update for
HDT, maintaining a hierarchy of spanning forests so that deleting a tree edge searches for a
replacement at each level. It is the correct answer when edge deletions are frequent, components
are large, and there is no cheaper structure available.

None of those three holds here. Deletions are rare relative to arrivals (fact 1 above), components
are tens of vertices (fact 2), and the cheaper structure is a BFS over a few dozen zones. HDT is
several hundred lines of intricate, hard-to-test machinery whose bugs are precisely the
hard-to-observe kind; trading a measured few-dozen-vertex rebuild for that is a bad trade at this
scale, and would be a worse one because it would be a *bad trade the author could not fully
verify*.

Naming it and saying why it is not needed is the point. The trigger for revisiting is explicit: if
`rebuiltMembers / rebuilds` climbs into the thousands, or `compaction_duration_ms` (WP3's metric)
becomes a material fraction of the compaction interval, the assumption behind this ADR has expired
and HDT becomes the next step.

### (c) Link-cut / Euler-tour trees alone

Rejected with (b), and for one extra reason: these maintain a *forest*, so they handle tree edges
well and non-tree edges (the ones that make a component 2-edge-connected) need the same
replacement-edge machinery HDT adds. Our graph has plenty of cycles — a dense zone field is
nothing but cycles — so the forest structure alone does not answer the question.

### (d) Keep union-find and never delete: let a component drain by aging out whole

Rejected. It amounts to "an incident ends when every member has expired", which merges two
distinct things: a fault that genuinely covered a large area, and a fault that moved. A
propagating anomaly (WP4) has members leaving the tail while new ones join the head, and under
this scheme it would accumulate every zone it had ever touched and never split. The propagation
vector — the measurement that makes the correlated view strictly more informative than the alerts
it replaced — would be computed over a footprint that includes zones that recovered twenty minutes
ago.

### (e) Recompute only when a query arrives, caching between writes

Rejected as an optimisation of the wrong axis. Queries are not the scarce resource — WP3 emits an
incident event on every change, so reads and writes arrive together. A lazy scheme would do the
same total work with an extra layer of invalidation logic to get wrong.

## Consequences

**What this costs.**

- **A member can outlive its deadline by up to one compaction interval.** Expiry runs on a
  `COMPACTION_INTERVAL_MS` (5 s) event-time cadence rather than exactly, because the alternative
  is a scan on every event. This is why 5 s sits two orders of magnitude below the 120 s window;
  it is a bounded lateness, and the bound is configuration.
- **An edge learned after both of its endpoints last degraded is not seen** until one of them
  degrades again or its component is rebuilt. Zones are discovered at runtime, so the graph does
  grow. The error is one-directional — it can only *miss* a merge, never invent one — and for a
  zone that is actively degrading the repair is at most one sample interval away. Tested
  explicitly rather than left as a comment.
- **The adjacency relation must be symmetric.** The incremental hot path only ever unions a
  joining zone against its own neighbour list, while a full recompute walks neighbours from every
  member; the two agree only if the relation reads the same in both directions. H3 grid distance
  is symmetric so `NeighbourGraph` satisfies it, and the fuzz suite asserts it over a real field
  rather than assuming it.
- **`representativeOf` is not an identity.** Which member ends up as a union-find root is an
  artefact of merge order, and a rebuild re-roots the component at its smallest survivor. Nothing
  downstream may key on it; a test pins that it really does move, so the temptation is closed off
  rather than documented. ADR-003 derives incident identity from the member set instead.
- **Two implementations to maintain.** `NaiveConnectivity` has to keep working for the oracle to
  keep meaning anything. Cheap — it is 60 lines with no state — and the shared contract suite runs
  against both, so a change that breaks one is caught.

**What it makes possible.**

- The whole core is pure: no I/O, no clock, no randomness. That is why 551,871 operations of
  differential testing run in about ten seconds, and why WP6b can replay a ground-truth scenario
  through exactly the code the service runs without standing up Kafka.
- Because the rebuild is a function of the surviving set alone, replay is exact. Two runs of the
  same event sequence produce the same partitions in the same order — load-bearing for every
  number WP6b will report.
