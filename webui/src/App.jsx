import { useRef, useState } from 'react';
import { api } from './api.js';
import { useInterval } from './util.js';
import Metrics from './Metrics.jsx';
import Console from './Console.jsx';
import Burst from './Burst.jsx';
import ActivityLog from './ActivityLog.jsx';
import BenchmarkComparison from './BenchmarkComparison.jsx';

const HISTORY = 60;
const push = (arr, v) => [...arr.slice(-(HISTORY - 1)), v];

export default function App() {
  const [conn, setConn] = useState({ state: 'connecting' });
  const [stats, setStats] = useState(null);
  const [hist, setHist] = useState({ pending: [], avgMs: [], throughput: [] });
  const [log, setLog] = useState([]);
  const [benchmarkVersion, setBenchmarkVersion] = useState(0);
  const lastId = useRef(0);

  const addActivity = (entry) => {
    if (!entry) return;
    lastId.current = Math.max(lastId.current, entry.id || 0);
    setLog((items) => [entry, ...items.filter((item) => item.id !== entry.id)].slice(0, 100));
  };

  useInterval(async () => {
    try {
      const d = await api.stats();
      if (d.up) {
        setStats(d.stats);
        setConn({ state: 'up' });
        setHist((h) => ({
          pending: push(h.pending, d.stats.pending),
          avgMs: push(h.avgMs, d.stats.avgMs),
          throughput: push(h.throughput, d.stats.throughput),
        }));
      } else setConn({ state: 'down', error: d.error });
    } catch (e) {
      setConn({ state: 'bridge', error: e.message });
    }
  }, 1000);

  useInterval(async () => {
    try {
      const d = await api.activity(lastId.current);
      if (d.entries.length) {
        d.entries.forEach(addActivity);
      }
    } catch { /* the stats poll already reports connection problems */ }
  }, 1500);

  const up = conn.state === 'up';
  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>File server console</h1>
          <p className="sub">Read and write files on the server, watch its queue, and test how it handles bursts.</p>
        </div>
        <div className={`status ${conn.state}`} role="status">
          <span className="dot" aria-hidden="true" />
          {up && <span>Server running <small>{stats.mode.toLowerCase()} mode, {stats.workers} workers</small></span>}
          {conn.state === 'connecting' && <span>Connecting…</span>}
          {conn.state === 'down' && <span>File server is not running <small>{conn.error}</small></span>}
          {conn.state === 'bridge' && <span>Can’t reach the web bridge <small>{conn.error}</small></span>}
        </div>
      </header>

      <Metrics stats={stats} hist={hist} stale={!up} onReset={async () => { await api.reset(); }} />

      <div className="grid">
        <Console disabled={!up} onActivity={addActivity} />
        <Burst disabled={!up} onActivity={addActivity} onBenchmarkComplete={() => setBenchmarkVersion((v) => v + 1)} />
      </div>

      <ActivityLog entries={log} />

      <BenchmarkComparison refreshKey={benchmarkVersion} />
    </div>
  );
}
