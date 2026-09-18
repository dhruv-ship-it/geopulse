# ADR-003 — Incident identity: a hash of the facts, the older incident survives a merge, the largest fragment survives a split

**Status.** Accepted (WP2b — items 3, 4 and 5 of WP2).
**Context.** `docs/02-PHASE-1-CORRELATION.md` WP2, `docs/01-ARCHITECTURE.md` §7. Evidence:
`benchmarks/results/wp2b-incident-properties.txt` (re-run with
`cd services/correlation-engine && npx jest incidentProperties --verbose`).
**Relates to.** ADR-002 produces the component partition this consumes. ADR-001 supplies the
adjacency relation underneath it. ADR-005 supplies the event-time model the ids are stamped from.

---

## Context

ADR-002 ends with a partition: at any instant, the active zones are divided into connected
components. That is not yet an incident, and the gap between the two is the whole of this ADR.

A component is anonymous, instantaneous and set-valued. An incident is none of those. It has a
name someone can paste into a ticket, a history someone can read, and — crucially — an answer to
"is this the same thing I was looking at a minute ago". The component `{Z-1, Z-2, Z-3}` at 12:00
and the component `{Z-1, Z-2, Z-3, Z-4}` at 12:01 are two different sets. Whether they are one
incident or two is not a fact about the data; it is a decision.

Four decisions have to be made, and each has a defensible alternative:

1. **What is an incident called**, such that a replay of the same stream produces the same name?
2. **Two incidents become one.** Which name survives, and what do consumers of the other do?
3. **One incident becomes two.** Which fragment, if any, keeps the name?
4. **When does an incident end**, given that "member count dropped" is not the same as "over"?

## Decision

### 1. `incidentId = SHA-256(scheme | openedAt | sorted seed member ids)`, first 64 bits

Rendered `INC-` plus 16 hex characters. The preimage carries a version prefix
(`geopulse-incident-v1`) so a future change to the scheme is visibly a different scheme rather
than a silent reinterpretation of the same 16 characters.

The id is a **function of the facts that produced the incident**, and of nothing else. Two
processes reading the same stream name the incident identically without exchanging a message. A
replay at 60× names it the same as a replay at 1×. The eval harness (WP6b) joins detected
incidents to ground truth across two separate runs, and a name that depends on run order would
make that join impossible.

### 2. A merge is won by age

When one component carries two or more existing incidents — a bridging zone degraded between
them — the survivor is the incident with the **earlier `openedAt`**, ties broken by
**lexicographically smaller `incidentId`**.

- The survivor emits `MERGED`, carrying `mergedFrom: [loser ids]` and the full merged member set.
- Each loser emits `CLOSED` with `closeReason: "SUPERSEDED"` and `supersededBy: <survivor>`.

**What a consumer holding a loser's id is supposed to do**: follow the pointer. It receives a
terminal event that names its successor in the same batch, so a dashboard re-points, a ticket is
marked as merged into the survivor's ticket, and an alert route stops firing on the dead id. The
thing it must *not* have to do is notice that an id went quiet and guess why — that is why a
superseded incident gets an explicit terminal event and not silence.

### 3. A split is won by inheritance

When a bridging member expires and a component fractures, the fragment that **retained the most
of the incident's members** keeps the id. Ties break on total fragment size, then on canonical
order (the fragment whose lexicographically smallest member sorts first). Every other fragment
that still meets `INCIDENT_MIN_ZONES` opens a fresh incident carrying `splitFrom: <original>`;
fragments below the minimum simply stop being anybody's incident.

The surviving incident sees the departed fragment as an ordinary `SHRANK`, with the members that
left the incident in `removed` — they are still degraded, they are just no longer part of *this*
incident.

### 4. Three statuses, and two ways to end

`OPEN` (at or above `INCIDENT_MIN_ZONES`), `DRAINING` (below it, grace period running), `CLOSED`.

- A `DRAINING` incident that regrows returns to `OPEN` **with the same id**.
- A `DRAINING` incident that stays below the minimum for `INCIDENT_CLOSE_GRACE_MS` of event time
  closes with `GRACE_EXPIRED`.
- An incident whose members have **all** left closes immediately with `DISSOLVED`, without
  serving out the grace period.

## Alternatives considered

### Identity

| Option | Why it lost |
|---|---|
| **UUIDv4** | The obvious default, and it silently destroys replayability. Two runs of the same scenario produce different ids, so nothing can be compared across runs — not two benchmark runs, not detection against ground truth, not a re-processed Kafka partition against the first pass. Every measurement in `03-MEASUREMENT.md` depends on this not being a UUID. |
| **Monotonic counter** (`INC-1`, `INC-2`) | Readable, and stable *only* if every incident opens in the same order every time. That holds for a single-threaded replay and stops holding the moment two coarse-cell partitions are consumed concurrently (§6 of the architecture doc, and the whole scaling story). It also requires coordinated state to allocate, which a stateless consumer does not have. |
| **The union-find root** | Free — the structure already has one. Rejected outright: the root is an artefact of merge order and is re-picked on every rebuild, so the "id" would change while the incident did not. `TimeAwareConnectivity.representativeOf` carries a comment saying exactly this, and a test pins that the root really does move so nothing downstream is tempted. |
| **Hash of the *current* member set** | Content-addressed and elegant, and wrong for this: the id would change on every `GREW`, which is to say the incident would have no identity at all. Hashing the *seed* set fixes the name at birth. |
| **Hash of seed set + openedAt** | **Chosen.** |

**64 bits, not 128 or 256.** The population to separate is incidents that are live at the same
instant plus those recently closed — thousands a day on a busy deployment. A 64-bit id gives a
birthday collision probability that is negligible against that, and stays short enough to read in
a log line. The code disambiguates a collision deterministically rather than assuming it away
(below), so the consequence of being wrong about the arithmetic is a slightly odd id, not a
corrupted stream.

**The hole the property tests found.** The first draft argued that ids were unique without any
registry: the preimage contains `openedAt`, components of a partition are disjoint so no two
incidents share a seed set in one reconcile, and event time is a monotonic watermark. That
argument has a gap, and the property tests found it within five shrink steps — event time is
*monotonic*, not *strictly increasing*. A zone that recovers and re-degrades inside the same
millisecond closes an incident and opens an identical one at an unchanged watermark, minting the
same id twice. At `INCIDENT_MIN_ZONES = 1` that is a single pair of messages.

The fix is to keep the ids retired **at the current watermark instant** and disambiguate against
them by extending the preimage. The set is pruned as soon as event time moves past an entry,
because once `openedAt` can no longer be reproduced neither can the id — so it holds one instant's
closures rather than a growing graveyard. This is worth recording for two reasons: it is the
argument an interviewer will probe, and it is a clean example of a property test finding a defect
that unit tests and a careful correctness argument both missed.

### Merge

| Option | Why it lost |
|---|---|
| **Close both, open a third** | Set-theoretically the cleanest: the merged thing genuinely is neither of its parents. Rejected because it discards the history and the ticket of a fault someone is already working, and because a fault that spreads across a city would do this repeatedly — every bridging zone would retire the incident anyone had bookmarked. |
| **Larger incident wins** | Intuitive, and unstable. During a spreading fault the relative sizes of two incidents change from one batch to the next, so the identity would hop between them while an engineer watched. Size is a property of *now*; identity should be a property of *history*. |
| **Higher peak severity wins** | Same objection, plus it makes identity depend on a value the correlation layer does not own. |
| **Earlier `openedAt` wins, ties lexicographic** | **Chosen.** Age is monotone — it never changes after the fact — so the survivor of a merge is decided by information that cannot be revised. The lexicographic tie-break is not cosmetic: two incidents genuinely can open at the same event time, and without a *total* order the survivor would depend on iteration order and replays would disagree. |

### Split

| Option | Why it lost |
|---|---|
| **Close the original, open one incident per fragment** | The honest answer if you take "an incident is a set" literally: the set no longer exists, so neither should its name. Rejected because it pages everyone again about a fault they have been working for ten minutes, and because the most common cause of a split is not a fault dividing in two — it is one zone at the waist of a long incident going quiet for a sample interval. Treating a transient as a re-org is worse than a slightly impure identity. |
| **Keep the id on the fragment holding the seed members** | Attractively simple to explain. Rejected because seed members are exactly the zones that degraded *first*, which are often the first to recover; the id would routinely follow the dying half of an incident. |
| **Largest fragment by total size** | Nearly the chosen rule, and wrong at the edges. A fragment can be large because unrelated zones joined it in the same batch, so raw size can hand the identity to the half that inherited the least. |
| **Fragment that inherited the most members; ties on size, then canonical order** | **Chosen.** It answers the question actually being asked — which of these is most continuous with the thing that was there before — and it is total, so replays agree. |

### Ending

| Option | Why it lost |
|---|---|
| **Two statuses, close the moment the count drops below the minimum** | Produces a stutter of open/close pairs for a fault hovering at the threshold, which is the alert storm this project exists to remove, re-introduced at the incident layer. |
| **Two statuses, stay `OPEN` through the grace period** | Breaks the invariant that an `OPEN` incident has at least `INCIDENT_MIN_ZONES` members — an invariant the property tests assert and that any consumer reading `status` would reasonably assume. |
| **Three statuses: `OPEN` / `DRAINING` / `CLOSED`** | **Chosen.** `DRAINING` is precisely the state "below the threshold, not yet given up on", which is what a grace period *is*. It also gives a UI something honest to render: an incident that is subsiding looks different from one that is active. |
| **Serve the grace period even when every member has gone** | Uniform, and pointless. Identity is carried by live members; with none left there is no zone that could re-degrade and reclaim the id, so the grace period only delays a certain close. Closing at once with `DISSOLVED` is the honest report. |

## Consequences

**Identity survives shrinkage, not disappearance.** An incident that drops to one member and
regrows keeps its id; an incident whose every member leaves the correlation window and then comes
back gets a new one. That boundary is deliberate — asserting continuity across a gap in which *no
zone was degraded* would be claiming a causal link the data does not support — but it is a real
consequence: a fault that goes quiet for longer than `CORRELATION_WINDOW_MS` and returns is two
incidents. The alternative (keeping a ghost claim on the departed members so they can reclaim the
id) is specified in the module's comments as the extension to build if operational experience
says the boundary is in the wrong place.

**The retired-id set is per-process.** It spans a single watermark instant, so a restart can only
reissue an id if the exact same seed set opens at the exact same millisecond across the restart.
WP3 rebuilds live incidents from Redis at startup, which closes the larger part of this; the
residual case is noted here rather than engineered around.

**Downstream must treat `supersededBy` as a forwarding pointer, not a deletion.** A merged
incident's id remains meaningful — it is in tickets and chat logs — and the Postgres schema in
WP3 keeps the row with `superseded_by` set rather than deleting it. Anything that treats `CLOSED`
as "forget this" will lose the chain.

**`reconcile` takes the whole partition, not a delta.** Cost is O(active members + live
incidents) per call, which is tens of zones out of a fleet of thousands, and `membersReconciled`
in `stats()` keeps that assumption measurable. The alternative — the connectivity layer telling
the lifecycle what changed — would require it to describe every consequence of a local rebuild,
and the consequences of a rebuild are exactly the splits this module exists to detect. If active
membership ever grows enough for the walk to show up in `correlation_latency_ms`, the upgrade is
to reconcile only components whose member set changed, which needs a dirty-set from ADR-002's
rebuild path.

**One event per incident per reconcile.** A batch that adds and removes members at once produces
a single `GREW` carrying both `added` and `removed`, not one event per zone. This is what makes
`eachBatch` worth using in WP3, and it means a consumer must read `members` rather than trying to
accumulate deltas.

**Splits and merges are counted, not just handled.** `stats().splits`, `splitFragments`,
`superseded` and `idCollisions` exist so that the behaviour of these policies on real data is
measurable. If it turns out that 40% of incidents end superseded, that is a finding about the
adjacency radius, not about this ADR.
