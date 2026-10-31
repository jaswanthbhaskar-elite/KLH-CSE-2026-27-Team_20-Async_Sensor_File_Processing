#!/bin/bash
# ---------------------------------------------------------
# gui/dashboard.sh
#
# Stage 13: a lightweight demonstration dashboard.
#
# This is DELIBERATELY plain bash + the existing STATS text
# protocol -- no web server, no new client library, no extra
# stack. It talks to the real running C server over the SAME
# TCP socket and the SAME STATS command every other tool in
# this project uses; it does not read or write any file the
# server touches, and it cannot perform file I/O on the
# server's behalf. If the server is not running, the dashboard
# has nothing to show and says so -- it never fabricates status.
#
# Usage:
#   ./gui/dashboard.sh              (refreshes every second, Ctrl+C to stop)
#   ./gui/dashboard.sh --once       (single snapshot, useful for scripts/screenshots)
# ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../bench_lib.sh"

MODE="${1:---loop}"

render_dashboard() {
    local stats_text
    stats_text=$(send_cmd "STATS" 2>/dev/null)

    if [ -z "$stats_text" ]; then
        echo "┌─────────────────────────────────────────┐"
        echo "│   ASYNCHRONOUS FILE PROCESSING SERVER    │"
        echo "├─────────────────────────────────────────┤"
        echo "│ Status            : NOT RUNNING          │"
        echo "│ (no response from $BENCH_HOST:$BENCH_PORT)"
        echo "└─────────────────────────────────────────┘"
        return 1
    fi

    local server_mode workers pending completed failed avg_lat max_lat throughput duration

    server_mode=$(get_stat_field "$stats_text" "Mode")
    workers=$(get_stat_field "$stats_text" "Worker threads")
    pending=$(get_stat_field "$stats_text" "Pending requests")
    completed=$(get_stat_field "$stats_text" "Completed successfully")
    failed=$(get_stat_field "$stats_text" "Failed")
    avg_lat=$(get_stat_field "$stats_text" "Average latency")
    max_lat=$(get_stat_field "$stats_text" "Maximum latency")
    throughput=$(get_stat_field "$stats_text" "Throughput")
    duration=$(get_stat_field "$stats_text" "Workload duration")

    printf "┌─────────────────────────────────────────┐\n"
    printf "│   ASYNCHRONOUS FILE PROCESSING SERVER    │\n"
    printf "├─────────────────────────────────────────┤\n"
    printf "│ Status            : RUNNING              │\n"
    printf "│ Mode              : %-22s│\n" "$server_mode"
    printf "│ Workers           : %-22s│\n" "$workers"
    printf "│ Pending Requests  : %-22s│\n" "$pending"
    printf "│ Completed         : %-22s│\n" "$completed"
    printf "│ Failed            : %-22s│\n" "$failed"
    printf "│                                           │\n"
    printf "│ Avg Latency       : %-22s│\n" "${avg_lat} ms"
    printf "│ Max Latency       : %-22s│\n" "${max_lat} ms"
    printf "│ Throughput        : %-22s│\n" "${throughput} req/s"
    printf "│ Workload Duration : %-22s│\n" "${duration} sec"
    printf "└─────────────────────────────────────────┘\n"
}

if [ "$MODE" == "--once" ]; then
    render_dashboard
    exit $?
fi

echo "Dashboard polling $BENCH_HOST:$BENCH_PORT every 1s (Ctrl+C to stop)..."
sleep 1
while true; do
    clear
    render_dashboard
    sleep 1
done
