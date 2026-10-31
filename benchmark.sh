#!/bin/bash
# ---------------------------------------------------------
# benchmark.sh
#
# Fires ONE workload run (WRITE+READ pairs) against a server already
# running, then queries STATS and saves the raw response.
#
# Usage:
#   ./benchmark.sh <output_stats_file> [pairs]
#
# <pairs> defaults to 25 (Workload A: 25 WRITE + 25 READ = 50 total),
# matching every earlier stage's benchmark. Pass 50 for Workload B
# (100 total) or 250 for Workload C (500 total).
#
# Example:
#   ./server sync &
#   ./benchmark.sh sync_stats.txt          # Workload A (50 requests)
#   ./benchmark.sh sync_stats_b.txt 50     # Workload B (100 requests)
#   ./benchmark.sh sync_stats_c.txt 250    # Workload C (500 requests)
#
# NOTE: this script does NOT reset server stats before firing the
# workload. If you need clean, repeatable per-run numbers (e.g. for
# 5 runs in a row), use run_experiment.sh instead, which sends RESET
# before every run automatically.
# ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/bench_lib.sh"

OUTFILE="${1:-stats_output.txt}"
PAIRS="${2:-25}"

echo "=== Benchmark: $PAIRS WRITE + $PAIRS READ ($((PAIRS * 2)) requests total) ==="
echo "Target: $BENCH_HOST:$BENCH_PORT"
echo ""

echo "Phase 1: firing $PAIRS WRITE requests concurrently..."
# (fire_workload does both phases; we call it directly so this script
#  stays a thin, readable wrapper around the shared logic)
echo "Phase 2 (READ) runs automatically after Phase 1 completes."
fire_workload "$PAIRS" "bench"
echo "Workload complete."
echo ""

echo "Querying STATS..."
send_cmd "STATS" > "$OUTFILE"

echo ""
echo "Saved stats to: $OUTFILE"
echo "----------------------------------------"
cat "$OUTFILE"
