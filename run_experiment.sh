#!/bin/bash
# ---------------------------------------------------------
# run_experiment.sh
#
# Starts the server in the requested mode, then for each of the three
# fixed workloads (A: 50 requests, B: 100 requests, C: 500 requests)
# performs <runs> repeated, independent benchmark runs:
#
#   for each run:
#     1. RESET server stats
#     2. fire the fixed WRITE+READ workload
#     3. capture STATS
#     4. append one row to results/<mode>_results.csv
#
# Stops the server when done. Never overwrites previous CSV rows --
# it always APPENDS, so you can re-run this script to add more data
# points without losing earlier ones.
#
# Usage:
#   ./run_experiment.sh <sync|async> [runs_per_workload] [results_dir]
#
# Example (Stage 10.1's "at least 5 runs" requirement):
#   ./run_experiment.sh sync 5
#   ./run_experiment.sh async 5
# ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/bench_lib.sh"

MODE="$1"
RUNS="${2:-5}"
RESULTS_DIR="${3:-results}"

if [ "$MODE" != "sync" ] && [ "$MODE" != "async" ]; then
    echo "Usage: $0 <sync|async> [runs_per_workload] [results_dir]"
    exit 1
fi

mkdir -p "$RESULTS_DIR"
CSV_FILE="$RESULTS_DIR/${MODE}_results.csv"

# Write the CSV header only if the file doesn't exist yet, so repeated
# invocations keep appending to the same file instead of duplicating
# headers or wiping prior runs.
if [ ! -f "$CSV_FILE" ]; then
    echo "mode,workload_label,workload_requests,run,total_requests,completed,failed,read_count,write_count,avg_latency_ms,min_latency_ms,max_latency_ms,duration_sec,throughput_req_s" > "$CSV_FILE"
fi

echo "=== Starting server in $MODE mode ==="
cd "$SCRIPT_DIR" || exit 1
./server "$MODE" > "server_${MODE}_experiment.log" 2>&1 &
SERVER_PID=$!
sleep 0.5

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: server failed to start. Check server_${MODE}_experiment.log"
    exit 1
fi
echo "Server PID: $SERVER_PID"
echo ""

# Workload definitions: label, requests-per-side (pairs), total requests
declare -a WORKLOAD_LABELS=("50" "100" "500")
declare -a WORKLOAD_PAIRS=(25 50 250)

for idx in 0 1 2; do
    label="${WORKLOAD_LABELS[$idx]}"
    pairs="${WORKLOAD_PAIRS[$idx]}"
    total=$((pairs * 2))

    echo "--- Workload $label ($total requests: $pairs WRITE + $pairs READ) ---"

    for run in $(seq 1 "$RUNS"); do
        echo "  Run $run/$RUNS ..."

        # Fix 1/2/3 from Stage 8's correction rely on RESET so each
        # run's measurement window starts clean.
        send_cmd "RESET" > /dev/null

        fire_workload "$pairs" "exp_${label}_${run}"

        stats_text=$(send_cmd "STATS")

        total_req=$(get_stat_field "$stats_text" "Total workload requests")
        completed=$(get_stat_field "$stats_text" "Completed successfully")
        failed=$(get_stat_field "$stats_text" "Failed")
        read_count=$(get_stat_field "$stats_text" "READ requests")
        write_count=$(get_stat_field "$stats_text" "WRITE requests")
        avg_lat=$(get_stat_field "$stats_text" "Average latency")
        min_lat=$(get_stat_field "$stats_text" "Minimum latency")
        max_lat=$(get_stat_field "$stats_text" "Maximum latency")
        duration=$(get_stat_field "$stats_text" "Workload duration")
        throughput=$(get_stat_field "$stats_text" "Throughput")

        echo "$MODE,$label,$total,$run,$total_req,$completed,$failed,$read_count,$write_count,$avg_lat,$min_lat,$max_lat,$duration,$throughput" >> "$CSV_FILE"

        echo "    -> completed=$completed avg_latency=${avg_lat}ms throughput=${throughput}req/s"
    done
    echo ""
done

echo "=== Stopping server (PID $SERVER_PID) ==="
kill "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null

echo ""
echo "Done. Results appended to: $CSV_FILE"
echo "Row count (excluding header): $(( $(wc -l < "$CSV_FILE") - 1 ))"
