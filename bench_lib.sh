#!/bin/bash
# ---------------------------------------------------------
# bench_lib.sh
#
# Shared helper functions for benchmark.sh, run_experiment.sh and
# benchmark_filesize.sh. Not meant to be run directly -- source it:
#
#   source ./bench_lib.sh
#
# Keeping this logic in one place means every script fires requests
# and parses STATS the same way, which is itself part of keeping the
# sync-vs-async comparison fair (Stage 9's fairness requirement
# extends naturally to "the benchmarking tooling behaves identically
# for both modes too").
# ---------------------------------------------------------

BENCH_HOST="${BENCH_HOST:-127.0.0.1}"
BENCH_PORT="${BENCH_PORT:-8080}"

# All benchmark WRITE/READ/BENCHWRITE/BENCHREAD traffic reads and
# writes files under this directory, not the project root -- a run
# of Workload C alone touches 250 files, so keeping them corralled
# in one place (and out of `ls .`) matters. The server itself has no
# concept of this directory; it's purely a benchmarking convention
# enforced by these scripts always passing paths like
# "test_files/bench_1.txt" as the filename.
BENCH_DIR="${BENCH_DIR:-test_files}"
mkdir -p "$BENCH_DIR"

# Sends a single line request and prints the raw response.
# Usage: send_cmd "STATS"
send_cmd() {
    local cmd="$1"
    printf "%s\n" "$cmd" | timeout 10 nc "$BENCH_HOST" "$BENCH_PORT"
}

# Fires a WRITE+READ workload of a given size (in "pairs") against the
# server: <pairs> WRITE requests (concurrent), wait, then <pairs> READ
# requests (concurrent) on the same files, wait.
#
# Total requests fired = 2 * pairs. E.g. pairs=25 -> 50 total requests
# (Workload A), pairs=50 -> 100 total (Workload B), pairs=250 -> 500
# total (Workload C).
#
# IMPORTANT: this function tracks the exact PIDs of the 'nc' processes
# it backgrounds and waits ONLY on those PIDs -- never a bare 'wait'.
# A bare 'wait' waits for ALL background jobs of the current shell,
# which, when this function is called from a script that also started
# the server itself in the background (like run_experiment.sh does),
# would include the server process -- and since the server runs
# forever, a bare 'wait' would hang indefinitely. This bit us during
# development; fixed here so it can never regress.
#
# Usage: fire_workload <pairs> <filename_prefix>
fire_workload() {
    local pairs="$1"
    local prefix="${2:-bench}"
    local pids=()

    pids=()
    for i in $(seq 1 "$pairs"); do
        printf "WRITE %s/%s_%d.txt Benchmark payload number %d\n" "$BENCH_DIR" "$prefix" "$i" "$i" \
            | timeout 10 nc "$BENCH_HOST" "$BENCH_PORT" > /dev/null &
        pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null

    pids=()
    for i in $(seq 1 "$pairs"); do
        printf "READ %s/%s_%d.txt\n" "$BENCH_DIR" "$prefix" "$i" \
            | timeout 10 nc "$BENCH_HOST" "$BENCH_PORT" > /dev/null &
        pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null
}

# Fires a BENCHWRITE+BENCHREAD workload for large-file testing
# (Stage 10.3). <count> BENCHWRITE requests of <size_bytes> each
# (concurrent), wait, then <count> BENCHREAD requests on those same
# files (concurrent), wait. Uses the benchmark-specific protocol
# commands so no large payload is ever sent over the network.
#
# Same PID-tracking discipline as fire_workload() above, for the
# same reason.
#
# Usage: fire_filesize_workload <count> <size_bytes> <filename_prefix>
fire_filesize_workload() {
    local count="$1"
    local size_bytes="$2"
    local prefix="${3:-fsz}"
    local pids=()

    pids=()
    for i in $(seq 1 "$count"); do
        printf "BENCHWRITE %s/%s_%d.txt %d\n" "$BENCH_DIR" "$prefix" "$i" "$size_bytes" \
            | timeout 30 nc "$BENCH_HOST" "$BENCH_PORT" > /dev/null &
        pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null

    pids=()
    for i in $(seq 1 "$count"); do
        printf "BENCHREAD %s/%s_%d.txt\n" "$BENCH_DIR" "$prefix" "$i" \
            | timeout 30 nc "$BENCH_HOST" "$BENCH_PORT" > /dev/null &
        pids+=($!)
    done
    wait "${pids[@]}" 2>/dev/null
}

# Extracts the numeric value after the first ':' on the line matching
# a label in a STATS text blob (either a file path or already-captured
# text passed via stdin). Prints "" if not found -- callers decide how
# to handle a miss (never silently substitute a fabricated number).
#
# Usage: get_stat_field "$stats_text" "Average latency"
get_stat_field() {
    local text="$1"
    local label="$2"
    echo "$text" | grep "$label" | head -n1 | awk -F: '{print $2}' | tr -d ' \t\r'
}

# Sends RESET, then STATS, and prints ONLY the STATS response.
# Used at the start of every repeated benchmark run so each run's
# numbers reflect only that run's workload, not any run before it.
reset_and_get_baseline() {
    send_cmd "RESET" > /dev/null
}
