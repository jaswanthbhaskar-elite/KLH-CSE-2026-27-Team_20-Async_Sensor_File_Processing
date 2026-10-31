#!/bin/bash
# ---------------------------------------------------------
# compare_stats.sh
#
# Reads two raw STATS captures (produced by benchmark.sh) and
# prints a side-by-side SYNC vs ASYNC comparison table.
#
# Every value is extracted directly from the two files you pass
# in -- nothing here is hard-coded or invented. If a file is
# missing a line, that field prints as "N/A" rather than a
# fabricated number.
#
# Usage:
#   ./compare_stats.sh sync_stats.txt async_stats.txt
# ---------------------------------------------------------

SYNC_FILE="$1"
ASYNC_FILE="$2"

if [ -z "$SYNC_FILE" ] || [ -z "$ASYNC_FILE" ]; then
    echo "Usage: $0 <sync_stats_file> <async_stats_file>"
    exit 1
fi

if [ ! -f "$SYNC_FILE" ] || [ ! -f "$ASYNC_FILE" ]; then
    echo "Error: one or both stats files not found."
    exit 1
fi

# Extracts the numeric value after the first ':' on the line
# matching $2 (a label) in file $1. Prints "N/A" if not found.
get_val() {
    local file="$1"
    local label="$2"
    local val
    val=$(grep "$label" "$file" | head -n1 | awk -F: '{print $2}' | tr -d ' \t\r')
    if [ -z "$val" ]; then
        echo "N/A"
    else
        echo "$val"
    fi
}

s_req=$(get_val "$SYNC_FILE" "Total workload requests")
a_req=$(get_val "$ASYNC_FILE" "Total workload requests")

s_comp=$(get_val "$SYNC_FILE" "Completed successfully")
a_comp=$(get_val "$ASYNC_FILE" "Completed successfully")

s_avg=$(get_val "$SYNC_FILE" "Average latency")
a_avg=$(get_val "$ASYNC_FILE" "Average latency")

s_min=$(get_val "$SYNC_FILE" "Minimum latency")
a_min=$(get_val "$ASYNC_FILE" "Minimum latency")

s_max=$(get_val "$SYNC_FILE" "Maximum latency")
a_max=$(get_val "$ASYNC_FILE" "Maximum latency")

s_dur=$(get_val "$SYNC_FILE" "Workload duration")
a_dur=$(get_val "$ASYNC_FILE" "Workload duration")

s_thr=$(get_val "$SYNC_FILE" "Throughput")
a_thr=$(get_val "$ASYNC_FILE" "Throughput")

printf "\n========= SYNC VS ASYNC =========\n\n"
printf "%-22s %-12s %-12s\n" "Metric" "SYNC" "ASYNC"
printf -- "------------------------------------------------\n"
printf "%-22s %-12s %-12s\n" "Requests"           "$s_req"  "$a_req"
printf "%-22s %-12s %-12s\n" "Completed"          "$s_comp" "$a_comp"
printf "%-22s %-12s %-12s\n" "Avg Latency (ms)"   "$s_avg"  "$a_avg"
printf "%-22s %-12s %-12s\n" "Min Latency (ms)"   "$s_min"  "$a_min"
printf "%-22s %-12s %-12s\n" "Max Latency (ms)"   "$s_max"  "$a_max"
printf "%-22s %-12s %-12s\n" "Duration (sec)"     "$s_dur"  "$a_dur"
printf "%-22s %-12s %-12s\n" "Throughput (req/s)" "$s_thr"  "$a_thr"
printf "\n===============================================\n"
