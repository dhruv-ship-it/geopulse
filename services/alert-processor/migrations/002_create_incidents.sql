-- Migration: incident history for GeoPulse Phase 1 (WP3 item 6)
--
-- Three tables, because an incident is three different shapes of fact and one table would have
-- to lie about at least two of them:
--
--   incidents         one mutable row per incident — what it is NOW
--   incident_members  which zones were in it, and for how long — the membership interval
--   incident_events   the lifecycle stream, append-only — how it got that way
--
-- The upsert/append split is the point. `zone.incidents` is delivered at-least-once (see
-- IncidentDispatcher), so a redelivered batch replays events that were already applied.
-- `incidents` and `incident_members` are therefore idempotent upserts keyed by a deterministic
-- incident id (ADR-003) — applying an event twice leaves exactly the state applying it once
-- does. `incident_events` is the one table that would duplicate, so it carries a uniqueness
-- constraint that makes a replayed event a no-op rather than a second row in the timeline.

CREATE TABLE IF NOT EXISTS incidents (
  -- SHA-256 hex, truncated by the core to 32 chars. Deterministic, so a replay of the same
  -- stream writes the same key rather than a second incident.
  incident_id     VARCHAR(64) PRIMARY KEY,
  status          VARCHAR(16) NOT NULL,
  -- Event time, not wall clock. Every _at column here is event time except last_written_at.
  opened_at       BIGINT      NOT NULL,
  closed_at       BIGINT,
  updated_at      BIGINT      NOT NULL,
  peak_severity   DOUBLE PRECISION NOT NULL,
  member_count    INTEGER     NOT NULL,
  centroid_lat    DOUBLE PRECISION,
  centroid_lon    DOUBLE PRECISION,
  radius_km       DOUBLE PRECISION,
  -- WP4. NULL is a real answer here, not a missing one: fewer than three members with distinct
  -- join times cannot support a vector, and emitting a best fit anyway would be a number nobody
  -- should act on.
  bearing_deg     DOUBLE PRECISION,
  speed_kmh       DOUBLE PRECISION,
  -- Set on the losing incident of a merge. A consumer has to be able to follow the chain from
  -- an id it remembers to the incident that absorbed it.
  superseded_by   VARCHAR(64),
  -- Wall clock, and named so it cannot be mistaken for the others. updated_at answers "when did
  -- this incident last change"; this answers "when did this row last get written", which is the
  -- question an operator asks when they suspect the pipeline has stopped.
  last_written_at BIGINT      NOT NULL
);

-- The API's default listing is "recent incidents, newest first" (WP5, GET /incidents).
CREATE INDEX IF NOT EXISTS idx_incidents_opened_at ON incidents(opened_at DESC);

-- "What is live right now" without a sequential scan over everything that ever happened.
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

CREATE TABLE IF NOT EXISTS incident_members (
  incident_id VARCHAR(64) NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  zone_id     VARCHAR(32) NOT NULL,
  joined_at   BIGINT      NOT NULL,
  -- NULL while the zone is still a member. Set when it leaves — on recovery, on window expiry,
  -- or when the incident closes under it.
  left_at     BIGINT,
  PRIMARY KEY (incident_id, zone_id)
);

-- The reverse lookup: GET /zones/:zoneId/incidents. Without this it is a scan of every
-- membership row ever written, and membership rows outnumber incidents by the mean member count.
CREATE INDEX IF NOT EXISTS idx_incident_members_zone_id ON incident_members(zone_id);

CREATE TABLE IF NOT EXISTS incident_events (
  id           BIGSERIAL PRIMARY KEY,
  incident_id  VARCHAR(64) NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  event_type   VARCHAR(16) NOT NULL,
  member_count INTEGER     NOT NULL,
  event_time   BIGINT      NOT NULL
);

-- The timeline, in order, for one incident: GET /incidents/:id/timeline.
CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id, event_time);

-- What makes at-least-once safe for the one append-only table here.
--
-- (incident_id, event_type, event_time) is unique by construction, not by hope: the lifecycle
-- reconciles at one watermark at a time and emits at most one event of each type per incident
-- per reconcile, so two rows with this triple can only be the same event delivered twice. The
-- insert uses ON CONFLICT DO NOTHING against it, which turns a redelivery into a no-op instead
-- of a duplicated timeline entry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_events_dedup
  ON incident_events(incident_id, event_type, event_time);
