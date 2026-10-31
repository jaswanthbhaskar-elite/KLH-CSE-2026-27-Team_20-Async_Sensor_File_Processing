#!/bin/bash
# ---------------------------------------------------------
# benchmark_filesize.sh
#
# Stage 10.3: measures how file SIZE affects READ/WRITE performance,
# independently of the request-count workloads in run_experiment.sh.
#
# Uses the BENCHWRITE/BENCHREAD protocol commands (see server.c),
# which generate/measure large payloads on the SERVER side rather
# than transmitting them over the network -- this is the "clean
# benchmark-specific mechanism" called for when large payloads would
# be impractical to push through the normal line-based text protocol.
#
# Usage:
#   ./benchmark_filesize.sh <size_label> <size_bytes> <count> <output_csv>
#
# Example (the three sizes suggested in the assignment):
#   ./server async &
#   ./benchmark_filesize.sh small  1024    10 results/filesize_async.csv
#   ./benchmark_filesize.sh medium 102400  10 results/filesize_async.csv
#   ./benchmark_filesize.sh large  1048576 10 results/filesize_async.csv
#
# Each invocation: RESET -> fire <count> BENCHWRITE + <count> BENCHREAD
# of <size_bytes> each -> capture STATS -> append one CSV row.
# Never overwrites previous rows in the CSV -- always appends, and
# writes the header only if the file doesn't already exist.
# ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/bench_lib.sh"

SIZE_LABEL="$1"
SIZE_BYTES="$2"
COUNT="${3:-10}"
OUTFILE="${4:-filesize_results.csv}"

if [ -z "$SIZE_LABEL" ] || [ -z "$SIZE_BYTES" ]; then
    echo "Usage: $0 <size_label> <size_bytes> [count] [output_csv]"
    echo "Example: $0 medium 102400 10 results/filesize_async.csv"
    exit 1
fi

if [ ! -f "$OUTFILE" ]; then
    mkdir -p "$(dirname "$OUTFILE")" 2>/dev/null
    echo "size_label,size_bytes,count,total_requests,completed,failed,avg_latency_ms,min_latency_ms,max_latency_ms,duration_sec,throughput_req_s" > "$OUTFILE"
fi

echo "=== File-size benchmark: $SIZE_LABEL (${SIZE_BYTES} bytes), $COUNT WRITE + $COUNT READ ==="
echo "Target: $BENCH_HOST:$BENCH_PORT"

send_cmd "RESET" > /dev/null

fire_filesize_workload "$COUNT" "$SIZE_BYTES" "fsz_${SIZE_LABEL}"

stats_text=$(send_cmd "STATS")

total_req=$(get_stat_field "$stats_text" "Total workload requests")
completed=$(get_stat_field "$stats_text" "Completed successfully")
failed=$(get_stat_field "$stats_text" "Failed")
avg_lat=$(get_stat_field "$stats_text" "Average latency")
min_lat=$(get_stat_field "$stats_text" "Minimum latency")
max_lat=$(get_stat_field "$stats_text" "Maximum latency")
duration=$(get_stat_field "$stats_text" "Workload duration")
throughput=$(get_stat_field "$stats_text" "Throughput")

echo "$SIZE_LABEL,$SIZE_BYTES,$COUNT,$total_req,$completed,$failed,$avg_lat,$min_lat,$max_lat,$duration,$throughput" >> "$OUTFILE"

echo ""
echo "$stats_text"
echo ""
echo "Appended row to: $OUTFILE"
