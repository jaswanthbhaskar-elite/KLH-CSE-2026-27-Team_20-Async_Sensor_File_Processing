import { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

export default function BenchmarkComparison({ refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [timeAgo, setTimeAgo] = useState('');

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.benchmarkSummary();
      if (!res.ok && (!res.workloads || res.workloads.length === 0)) {
        setError(res.error || 'Failed to load benchmark results');
      } else {
        setData(res);
        setLastUpdated(new Date());
        setTimeAgo('Updated just now');
      }
    } catch (err) {
      setError(err.message || 'Error communicating with bridge');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData(false);
  }, [loadData, refreshKey]);

  // Update relative timestamp periodically
  useEffect(() => {
    if (!lastUpdated) return;
    const interval = setInterval(() => {
      const sec = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      if (sec < 60) {
        setTimeAgo('Updated just now');
      } else if (sec < 3600) {
        const m = Math.floor(sec / 60);
        setTimeAgo(`Updated ${m}m ago`);
      } else {
        setTimeAgo(`Updated at ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  const fmtLat = (val) => (typeof val === 'number' && !isNaN(val) ? `${val.toFixed(3)} ms` : '–');
  const fmtThr = (val) => (typeof val === 'number' && !isNaN(val) ? `${val.toFixed(3)} req/s` : '–');
  const fmtRuns = (val) => (typeof val === 'number' && !isNaN(val) ? val.toString() : '–');

  const workloads = data?.workloads || [];

  return (
    <section className="panel" aria-label="Sync vs Async Benchmark Comparison">
      <div className="panel-head">
        <div>
          <h2>SYNC vs ASYNC BENCHMARK COMPARISON</h2>
          <p className="sub">
            Stored experiment results from <span className="mono">results/sync_results.csv</span> and <span className="mono">results/async_results.csv</span> (parsed directly by bridge, independent of live stats).
          </p>
        </div>
        <div className="bench-actions">
          {timeAgo && <span className="bench-timestamp">{timeAgo}</span>}
          <button
            className="quiet"
            disabled={loading || refreshing}
            onClick={() => loadData(true)}
            title="Reload results from results/*.csv files"
          >
            {refreshing ? 'Refreshing…' : 'Refresh Results'}
          </button>
        </div>
      </div>

      <div className="panel-body" style={{ paddingTop: 8 }}>
        {error && (
          <div className="error" style={{ marginBottom: 12 }}>
            <span>Error loading benchmark data: {error}</span>
            <button className="quiet" style={{ marginLeft: 10 }} onClick={() => loadData(true)}>
              Retry
            </button>
          </div>
        )}

        {loading && !data && (
          <p className="empty">Loading benchmark comparison data…</p>
        )}

        {workloads.length > 0 && (
          <div className="bench-table-wrap">
            <table className="bench-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 120 }}>Workload</th>
                  <th className="num" style={{ minWidth: 60 }}>Runs</th>
                  <th className="num" style={{ minWidth: 120 }}>
                    <span className="tag-sync">SYNC</span> Avg Latency
                  </th>
                  <th className="num" style={{ minWidth: 120 }}>
                    <span className="tag-async">ASYNC</span> Avg Latency
                  </th>
                  <th className="num" style={{ minWidth: 100 }}>
                    <span className="tag-sync">SYNC</span> Median
                  </th>
                  <th className="num" style={{ minWidth: 100 }}>
                    <span className="tag-async">ASYNC</span> Median
                  </th>
                  <th className="num" style={{ minWidth: 95 }}>
                    <span className="tag-sync">SYNC</span> Max
                  </th>
                  <th className="num" style={{ minWidth: 95 }}>
                    <span className="tag-async">ASYNC</span> Max
                  </th>
                  <th className="num" style={{ minWidth: 130 }}>
                    <span className="tag-sync">SYNC</span> Throughput
                  </th>
                  <th className="num" style={{ minWidth: 130 }}>
                    <span className="tag-async">ASYNC</span> Throughput
                  </th>
                </tr>
              </thead>
              <tbody>
                {workloads.map((w) => {
                  const s = w.sync || {};
                  const a = w.async || {};
                  const thrGain = s.meanThr && a.meanThr ? ((a.meanThr - s.meanThr) / s.meanThr) * 100 : null;

                  return (
                    <tr key={w.workload}>
                      <td style={{ fontWeight: 600 }}>{w.label || `${w.workload} requests`}</td>
                      <td className="num">{fmtRuns(w.runs)}</td>
                      <td className="num">{fmtLat(s.meanLat)}</td>
                      <td className="num">{fmtLat(a.meanLat)}</td>
                      <td className="num">{fmtLat(s.medLat)}</td>
                      <td className="num">{fmtLat(a.medLat)}</td>
                      <td className="num">{fmtLat(s.maxLat)}</td>
                      <td className="num">{fmtLat(a.maxLat)}</td>
                      <td className="num">{fmtThr(s.meanThr)}</td>
                      <td className="num">
                        {fmtThr(a.meanThr)}
                        {thrGain !== null && thrGain > 0 && (
                          <span className="bench-badge-gain" title={`Async throughput is ${thrGain.toFixed(1)}% higher than Sync`}>
                            +{thrGain.toFixed(1)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && workloads.length === 0 && !error && (
          <p className="empty">No workload records found in the benchmark CSV files.</p>
        )}

        <div className="bench-notes">
          <h4>Operating Systems Analysis &amp; Insights</h4>
          <ul>
            <li>
              <strong>Throughput at Scale (Concurrency Benefit):</strong> Under high concurrency (500 requests), Async file processing achieves higher mean throughput (<strong>640.852 req/s</strong> vs <strong>608.683 req/s</strong>, a +5.3% gain) as multi-threaded worker pools overlap I/O wait times and disk latency.
            </li>
            <li>
              <strong>Latency Tradeoff (Dispatch Overhead):</strong> At light workloads (50 requests), Synchronous mode exhibits lower average latency (<strong>0.303 ms</strong> vs <strong>1.144 ms</strong>) because immediate inline execution eliminates thread synchronization, queue mutex contention, and context switching.
            </li>
            <li>
              <strong>Tail Latency Stabilization:</strong> At 50 requests, the Async server recorded a lower maximum latency spike (<strong>8.729 ms</strong> vs <strong>9.330 ms</strong> for Sync), demonstrating that request queue buffering mitigates outlier delays.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
