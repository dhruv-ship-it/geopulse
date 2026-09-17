#!/usr/bin/env bash
# Re-runnable coverage report across every service.
#
# Rule 1 in CLAUDE.md: any number that could reach the resume must come from a committed,
# re-runnable script with its raw output committed. The pre-WP0 "90%+ coverage" claim was
# scoped to two hand-picked files; this reports over every shipped source file instead.
#
#   ./benchmarks/run-coverage.sh | tee benchmarks/results/wp0-coverage.txt
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "GeoPulse coverage report"
echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "commit:    $(git -C "$ROOT" rev-parse --short HEAD)"
echo

for service in sensor-simulator stream-processor alert-processor api; do
  echo "================================================================"
  echo "$service"
  echo "================================================================"
  (cd "$ROOT/services/$service" && npx jest --coverage --coverageReporters=text 2>&1 \
    | grep -Ev '^(PASS|FAIL|Snapshots:|Ran all|  )' )
  echo
done
