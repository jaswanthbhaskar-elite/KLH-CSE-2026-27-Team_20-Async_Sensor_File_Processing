#!/bin/bash
# ---------------------------------------------------------
# monitor_server.sh
#
# Finds the running ./server process and prints a small live summary
# of its /proc/<PID>/status, refreshed every couple of seconds.
# Handles "server not running" cleanly instead of crashing or
# printing confusing errors.
#
# Usage:
#   ./monitor_server.sh            # continuous monitoring (Ctrl+C to stop)
#   ./monitor_server.sh --once     # print one snapshot and exit
# ---------------------------------------------------------

MODE="${1:---loop}"

find_server_pid() {
    # Look for a process whose command line contains "./server" or
    # ends in "/server" with an argument (sync/async). We search
    # /proc directly rather than relying on pgrep/ps being present
    # or behaving identically across systems.
    local pid
    for p in /proc/[0-9]*; do
        [ -r "$p/cmdline" ] || continue
        pid="${p#/proc/}"
        # cmdline is NUL-separated; turn NULs into spaces for matching.
        local cmd
        cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
        if [[ "$cmd" == *"server"* ]] && [[ "$cmd" != *"monitor_server"* ]]; then
            echo "$pid"
            return 0
        fi
    done
    return 1
}

print_snapshot() {
    local pid
    pid=$(find_server_pid)

    if [ -z "$pid" ]; then
        echo "Server is NOT running (no matching process found under /proc)."
        return 1
    fi

    if [ ! -d "/proc/$pid" ]; then
        echo "Server process (PID $pid) disappeared between detection and read."
        return 1
    fi

    echo "=== Server Monitor (PID $pid) ==="
    echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    if [ -r "/proc/$pid/status" ]; then
        # Pull out the fields most relevant to an OS course viva:
        #   State    -- Running / Sleeping / etc
        #   Threads  -- confirms the worker pool + responder are live
        #   VmRSS    -- actual physical memory currently used
        #   VmSize   -- total virtual memory mapped
        grep -E '^(State|Threads|VmRSS|VmSize|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' \
            "/proc/$pid/status" 2>/dev/null
    else
        echo "(Could not read /proc/$pid/status -- process may have just exited.)"
    fi

    echo ""
    if [ -r "/proc/$pid/fd" ]; then
        local fd_count
        fd_count=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
        echo "Open file descriptors : $fd_count"
    fi

    if [ -r "/proc/$pid/stat" ]; then
        # Field 3 of /proc/PID/stat is the single-character process state
        local stat_state
        stat_state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)
        echo "Process state (raw)   : $stat_state"
    fi

    echo "-----------------------------------"
}

if [ "$MODE" == "--once" ]; then
    print_snapshot
    exit $?
fi

echo "Monitoring server... (Ctrl+C to stop)"
echo ""
while true; do
    clear
    print_snapshot
    sleep 2
done
