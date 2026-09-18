#!/usr/bin/env bash
# WP3 acceptance: one injected regional anomaly must produce exactly one incident.
#
# This is the project's central claim reduced to a number that a script can check. The whole
# thesis — "a single sensor going critical is noise; the signal is the geometry" — is false if
# 62 co-degrading adjacent zones come out as seven incidents, and unfalsifiable if nobody ever
# runs the check. Rule 1 in CLAUDE.md: the number has to come from a committed, re-runnable
# script with its raw output committed.
#
#   ./benchmarks/e2e-regional-anomaly.sh | tee benchmarks/results/wp3-e2e-regional.txt
#
# Brings the whole stack up from scratch (including a fresh Postgres volume, so the row counts
# are this run's and not an accumulation), waits for the simulator to finish its four simulated
# hours, then reports what each stage of the pipeline saw.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f ${ROOT}/infra/docker-compose.yml"

SCENARIO="${SCENARIO:-regional-anomaly}"
NUM_ZONES="${NUM_ZONES:-400}"
SEED="${SEED:-42}"
SPEED_MULTIPLIER="${SPEED_MULTIPLIER:-60}"
# How long to wait for the simulator to exit.
#
# Not four minutes, which is what four simulated hours at SPEED_MULTIPLIER=60 would suggest. The
# multiplier is a ceiling on how fast simulated time MAY run, not a promise: at 400 zones the
# simulator is throughput-bound at roughly 2,000 events/s, so it achieves about 5x and a full
# four-hour run takes around 45 real minutes. Measured, and printed below, because a benchmark
# that silently runs at a twelfth of its configured speed is a benchmark whose numbers mean
# something other than what its header says.
SIM_TIMEOUT_S="${SIM_TIMEOUT_S:-3600}"
# Event-time slack after the simulator stops, so the last degradations drain through the
# correlation window and the incident closes. The window is 120 s of event time and the close
# grace another 60 s; at 60x that is three real seconds, but the pipeline also has to drain.
DRAIN_S="${DRAIN_S:-45}"

psql_q() {
  $COMPOSE exec -T postgres psql -U geopulse -d geopulse -tAc "$1" 2>/dev/null | tr -d '\r'
}

echo "GeoPulse end-to-end acceptance — WP3"
echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "commit:    $(git -C "$ROOT" rev-parse --short HEAD)"
echo "scenario:  ${SCENARIO}, ${NUM_ZONES} zones, seed ${SEED}, speed ${SPEED_MULTIPLIER}x"
echo

echo "## Bringing the stack up from scratch"
echo
# Down with volumes: a Postgres volume carried over from a previous run would make every row
# count below an accumulation rather than a measurement.
$COMPOSE down -v >/dev/null 2>&1
SCENARIO="$SCENARIO" NUM_ZONES="$NUM_ZONES" SEED="$SEED" SPEED_MULTIPLIER="$SPEED_MULTIPLIER" \
  $COMPOSE up -d 2>&1 | grep -Ei 'error|created|started' | sed 's/^/  /'
echo

echo "## Waiting for the simulator to finish (timeout ${SIM_TIMEOUT_S}s)"
deadline=$(( $(date +%s) + SIM_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$($COMPOSE ps -a --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="simulator"{print $2}')
  [ "$state" = "exited" ] && break
  sleep 5
done
elapsed=$(( SIM_TIMEOUT_S - (deadline - $(date +%s)) ))
echo "  simulator state: ${state:-unknown} after ${elapsed}s"
if [ "${state:-}" != "exited" ]; then
  echo "  WARNING: the simulator had not finished. Everything below is a snapshot of an"
  echo "  incomplete run — in particular the incident will not have closed."
fi
SIM_EVENTS=$($COMPOSE logs simulator 2>/dev/null | grep -o '"eventCount":[0-9]*' | tail -1 | cut -d: -f2)
SIM_SECONDS=$($COMPOSE logs simulator 2>/dev/null | grep -o '"simulatedSeconds":[0-9]*' | tail -1 | cut -d: -f2)
if [ -n "${SIM_SECONDS:-}" ] && [ "${elapsed}" -gt 0 ]; then
  echo "  produced ${SIM_EVENTS:-?} events over ${SIM_SECONDS:-?} simulated seconds"
  echo "  achieved speed: $(( SIM_SECONDS / elapsed ))x real time (SPEED_MULTIPLIER=${SPEED_MULTIPLIER} is a ceiling, not a promise)"
fi
echo "  draining for ${DRAIN_S}s so the correlation window lapses and the incident closes"
sleep "$DRAIN_S"
echo

echo "## Ground truth — what was injected"
echo
META=$(ls -t "${ROOT}/evals/groundtruth/"*"${SCENARIO}"*.meta.json 2>/dev/null | head -1)
if [ -n "$META" ]; then
  echo "  file: ${META#"$ROOT"/}"
  node -e '
    const m = require(process.argv[1]);
    const anomalies = m.anomalies ?? [];
    console.log(`  anomalies injected: ${anomalies.length}`);
    for (const a of anomalies) {
      console.log(`    ${a.anomalyId}: ${(a.labelledZones ?? a.zones ?? []).length} labelled zones, radius ${a.radiusKm} km`);
    }
  ' "$META" 2>/dev/null || echo "  (could not parse)"
else
  echo "  NOT FOUND — the simulator did not write ground truth"
fi
echo

echo "## Stage by stage"
echo
echo "  stream-processor (degradations published):"
$COMPOSE logs stream-processor 2>/dev/null | grep -o '"degradationsPublished":[0-9]*' | tail -1 | sed 's/^/    /'
$COMPOSE logs stream-processor 2>/dev/null | grep -o '"recoveriesPublished":[0-9]*' | tail -1 | sed 's/^/    /'
echo "    state transitions on the topic:"
for t in STRESSED CRITICAL NORMAL; do
  n=$(psql_q "SELECT count(*) FROM zone_alerts WHERE current_state = '${t}';")
  z=$(psql_q "SELECT count(DISTINCT zone_id) FROM zone_alerts WHERE current_state = '${t}';")
  echo "      -> ${t}: ${n:-?} transitions across ${z:-?} distinct zones"
done
echo

echo "  correlation-engine (/health):"
curl -s --max-time 5 http://localhost:9093/health 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const h = JSON.parse(raw);
      console.log(`    geometry:   ${h.geometry}`);
      const e = h.engine ?? {};
      console.log(`    batches:    ${e.batches}, messages ${e.degradations + e.recoveries} (${e.degradations} degradations, ${e.recoveries} recoveries)`);
      console.log(`    ticks:      ${e.ticks} reconciled, ${e.ticksSkipped} fast-forwarded`);
      console.log(`    rejected:   ${e.rejected}, stale ${e.stale}`);
      console.log(`    incidents:  ${JSON.stringify(e.incidents)}`);
      console.log(`    consumer:   ${JSON.stringify(h.consumer)}`);
      console.log(`    dispatcher: ${JSON.stringify(h.dispatcher)}`);
    } catch {
      console.log("    (correlation-engine /health unreachable)");
    }
  });
'
echo

echo "## THE ANSWER — incidents in Postgres"
echo
$COMPOSE exec -T postgres psql -U geopulse -d geopulse -c \
  "SELECT incident_id, status, member_count, peak_severity,
          round(radius_km::numeric, 1) AS radius_km,
          opened_at, closed_at
     FROM incidents ORDER BY opened_at;" 2>/dev/null | sed 's/^/  /'

TOTAL=$(psql_q "SELECT count(*) FROM incidents;")
PEAK=$(psql_q "SELECT coalesce(max(member_count), 0) FROM incidents;")
MEMBERS=$(psql_q "SELECT count(DISTINCT zone_id) FROM incident_members;")
EVENTS=$(psql_q "SELECT count(*) FROM incident_events;")
DEGRADED=$(psql_q "SELECT count(DISTINCT zone_id) FROM zone_alerts WHERE current_state <> 'NORMAL';")

echo
echo "  incident timeline:"
$COMPOSE exec -T postgres psql -U geopulse -d geopulse -c \
  "SELECT event_type, count(*) FROM incident_events GROUP BY event_type ORDER BY 2 DESC;" \
  2>/dev/null | sed 's/^/  /'

echo
echo "================================================================"
echo "  incidents:                 ${TOTAL:-?}"
echo "  largest incident:          ${PEAK:-?} zones"
echo "  distinct zones in members: ${MEMBERS:-?}"
echo "  lifecycle events:          ${EVENTS:-?}"
echo "  distinct zones degraded:   ${DEGRADED:-?}"
if [ -n "${DEGRADED:-}" ] && [ -n "${TOTAL:-}" ] && [ "${TOTAL}" -gt 0 ] 2>/dev/null; then
  echo "  collapse:                  ${DEGRADED} degraded zones -> ${TOTAL} incident(s)"
fi
echo "================================================================"
echo
if [ "${TOTAL:-0}" = "1" ]; then
  echo "  PASS — one injected regional anomaly produced exactly one incident."
else
  echo "  FAIL — expected exactly 1 incident, got ${TOTAL:-?}."
  echo "  This is the acceptance criterion for WP3. Do not record any downstream"
  echo "  number until it passes; they would all be measuring the wrong thing."
fi
