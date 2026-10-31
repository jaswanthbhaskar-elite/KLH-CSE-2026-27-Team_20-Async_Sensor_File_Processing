#!/bin/bash
# ---------------------------------------------------------
# analyze_results.sh
#
# Reads the CSV files produced by run_experiment.sh (one row per
# benchmark run) and computes, for each (workload, mode) group:
#   - mean throughput, median throughput
#   - mean latency, median latency
#   - maximum observed latency
#   - mean workload duration
#
# Every number comes directly from the CSV rows you pass in --
# nothing here is hard-coded or assumed.
#
# Usage:
#   ./analyze_results.sh results/sync_results.csv results/async_results.csv
# ---------------------------------------------------------

SYNC_CSV="$1"
ASYNC_CSV="$2"

if [ -z "$SYNC_CSV" ] || [ -z "$ASYNC_CSV" ]; then
    echo "Usage: $0 <sync_results.csv> <async_results.csv>"
    exit 1
fi

if [ ! -f "$SYNC_CSV" ] || [ ! -f "$ASYNC_CSV" ]; then
    echo "Error: one or both CSV files not found."
    exit 1
fi

# awk does all the actual number-crunching: mean/median throughput
# and latency, max latency, and mean duration, grouped by
# workload_label. Called once per CSV file.
#
# CSV columns (see run_experiment.sh header):
# mode,workload_label,workload_requests,run,total_requests,completed,
# failed,read_count,write_count,avg_latency_ms,min_latency_ms,
# max_latency_ms,duration_sec,throughput_req_s
analyze_csv() {
    local csv_file="$1"
    local mode_label="$2"

    awk -F, -v mode_label="$mode_label" '
        NR == 1 { next }  # skip header
        {
            wl = $2
            lat = $10 + 0
            maxlat = $12 + 0
            dur = $13 + 0
            thr = $14 + 0

            n[wl]++
            lat_sum[wl] += lat
            dur_sum[wl] += dur
            thr_sum[wl] += thr
            if (maxlat > maxlat_overall[wl] || n[wl] == 1) maxlat_overall[wl] = maxlat

            lat_list[wl, n[wl]] = lat
            thr_list[wl, n[wl]] = thr

            if (!(wl in seen)) { seen[wl] = 1; order[++oc] = wl }
        }
        END {
            for (i = 1; i <= oc; i++) {
                wl = order[i]
                count = n[wl]

                mean_lat = lat_sum[wl] / count
                mean_thr = thr_sum[wl] / count
                mean_dur = dur_sum[wl] / count

                # Build sorted arrays for median (simple insertion sort --
                # fine here since run counts are small, e.g. 5-20).
                for (a = 1; a <= count; a++) {
                    sorted_lat[a] = lat_list[wl, a]
                    sorted_thr[a] = thr_list[wl, a]
                }
                for (a = 2; a <= count; a++) {
                    keyl = sorted_lat[a]; keyt = sorted_thr[a]
                    b = a - 1
                    while (b >= 1 && sorted_lat[b] > keyl) {
                        sorted_lat[b+1] = sorted_lat[b]; b--
                    }
                    sorted_lat[b+1] = keyl
                    b = a - 1
                    while (b >= 1 && sorted_thr[b] > keyt) {
                        sorted_thr[b+1] = sorted_thr[b]; b--
                    }
                    sorted_thr[b+1] = keyt
                }
                if (count % 2 == 1) {
                    med_lat = sorted_lat[(count+1)/2]
                    med_thr = sorted_thr[(count+1)/2]
                } else {
                    med_lat = (sorted_lat[count/2] + sorted_lat[count/2+1]) / 2
                    med_thr = (sorted_thr[count/2] + sorted_thr[count/2+1]) / 2
                }

                printf "%s|%s|%d|%.3f|%.3f|%.3f|%.3f|%.3f|%.3f\n", \
                    mode_label, wl, count, mean_lat, med_lat, maxlat_overall[wl], mean_thr, med_thr, mean_dur
            }
        }
    ' "$csv_file"
}

echo "=========== BENCHMARK SUMMARY ==========="
echo ""
printf "%-10s %-7s %-6s %-14s %-14s %-14s %-14s\n" \
    "Workload" "Mode" "Runs" "Mean Lat(ms)" "Median Lat(ms)" "Max Lat(ms)" "Mean Thr(req/s)"
echo "-------------------------------------------------------------------------------------"

{
    analyze_csv "$SYNC_CSV" "SYNC"
    analyze_csv "$ASYNC_CSV" "ASYNC"
} | sort -t'|' -k2,2n -k1,1 | while IFS='|' read -r mode wl count mean_lat med_lat maxlat mean_thr med_thr mean_dur; do
    printf "%-10s %-7s %-6s %-14s %-14s %-14s %-14s\n" \
        "$wl" "$mode" "$count" "$mean_lat" "$med_lat" "$maxlat" "$mean_thr"
done

echo ""
echo "(Median throughput and mean workload duration are also computed;"
echo " re-run with --full for the extended table.)"

if [ "$3" == "--full" ] || [ "$1" == "--full" ]; then
    :
fi

if [[ "$*" == *"--full"* ]]; then
    echo ""
    echo "=========== FULL DETAIL ==========="
    printf "%-10s %-7s %-6s %-14s %-14s %-14s %-16s %-16s %-14s\n" \
        "Workload" "Mode" "Runs" "MeanLat(ms)" "MedLat(ms)" "MaxLat(ms)" "MeanThr(req/s)" "MedThr(req/s)" "MeanDur(s)"
    {
        analyze_csv "$SYNC_CSV" "SYNC"
        analyze_csv "$ASYNC_CSV" "ASYNC"
    } | sort -t'|' -k2,2n -k1,1 | while IFS='|' read -r mode wl count mean_lat med_lat maxlat mean_thr med_thr mean_dur; do
        printf "%-10s %-7s %-6s %-14s %-14s %-14s %-16s %-16s %-14s\n" \
            "$wl" "$mode" "$count" "$mean_lat" "$med_lat" "$maxlat" "$mean_thr" "$med_thr" "$mean_dur"
    done
fi

echo ""
echo "=========================================="
