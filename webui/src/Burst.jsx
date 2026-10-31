import { useMemo, useState } from 'react';
import { api } from './api.js';
import { fmtInt, fmtMs } from './util.js';

// Pack requests into lanes so each lane is one connection slot in flight at a time.
function pack(requests) {
  const ends = [];
  const placed = requests.slice().sort((a, b) => a.start - b.start).map((r) => {
    let lane = ends.findIndex((e) => e <= r.start);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = r.start + r.ms;
    return { ...r, lane };
  });
  return { placed, lanes: ends.length };
}

function Timeline({ run }) {
  const { placed, lanes } = useMemo(() => pack(run.requests), [run]);
  const W = 1000;
  const laneH = Math.max(5, Math.min(20, Math.floor(240 / lanes)));
  const H = lanes * laneH;
  const total = run.summary.wallMs;
  const x = (t) => (t / total) * W;
  return (
    <>
      <div className="tl">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Timeline of ${run.summary.count} requests across ${lanes} connection lanes`}>
          {placed.map((r, i) => (
            <rect key={i} className={r.ok ? (r.op === 'WRITE' ? 'w' : 'r') : 'f'} x={x(r.start)} y={r.lane * laneH + 1} width={Math.max(1.5, x(r.ms))} height={laneH - 2} rx="1">
              <title>{`${r.op} ${r.file}: started at ${fmtMs(r.start)} ms, took ${fmtMs(r.ms)} ms${r.ok ? '' : ' (failed)'}`}</title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="axis"><span>0 ms</span><span>{fmtMs(total / 2)} ms</span><span>{fmtMs(total)} ms</span></div>
      <div className="legend">
        <span><i style={{ background: 'var(--write)' }} />Write</span>
        <span><i style={{ background: 'var(--read)' }} />Read</span>
        <span><i style={{ background: 'var(--bad)' }} />Failed</span>
        <span>Each row is one connection slot. All writes finish before the reads begin.</span>
      </div>
    </>
  );
}

export default function Burst({ disabled, onBenchmarkComplete, onActivity }) {
  const [pairs, setPairs] = useState(50);
  const [inflight, setInflight] = useState(8);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');

  const start = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.burst(pairs, inflight);
      setRun(result);
      if (result.activity && onActivity) onActivity(result.activity);
      if (result.benchmark?.file && onBenchmarkComplete) onBenchmarkComplete();
    }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const s = run && run.summary;

  return (
    <section className="panel" aria-label="Burst test">
      <div className="panel-head"><h2>Burst test</h2></div>
      <div className="panel-body">
        <div className="row">
          <div className="field">
            <label htmlFor="pairs">File pairs (1–250)</label>
            <input id="pairs" type="number" min="1" max="250" value={pairs} onChange={(e) => setPairs(Math.max(1, Math.min(250, Number(e.target.value) || 1)))} />
          </div>
          <div className="field">
            <label htmlFor="inflight">In flight (1–128)</label>
            <input id="inflight" type="number" min="1" max="128" value={inflight} onChange={(e) => setInflight(Math.max(1, Math.min(128, Number(e.target.value) || 1)))} />
          </div>
          <button className="primary" disabled={disabled || busy} onClick={start}>{busy ? 'Running…' : `Run ${pairs * 2} requests`}</button>
        </div>
        <p className="explain">Writes {pairs} small files, then reads them all back, keeping {inflight} requests in flight. Files are named burst_1.txt onward and are overwritten on each run. Successful runs are automatically added to the SYNC/ASYNC comparison history.</p>
        {error && <div className="error" role="alert">{error}</div>}

        {s && (
          <div style={{ marginTop: 16 }}>
            <ul className="summary">
              <li><span>Requests </span><b>{fmtInt(s.count)}</b></li>
              <li><span>Total time </span><b>{fmtMs(s.wallMs)} ms</b></li>
              <li><span>Median </span><b>{fmtMs(s.p50Ms)} ms</b></li>
              <li><span>95th percentile </span><b>{fmtMs(s.p95Ms)} ms</b></li>
              <li><span>Slowest </span><b>{fmtMs(s.maxMs)} ms</b></li>
              <li><span>Failed </span><b>{s.failed}</b></li>
            </ul>
            {run.benchmark && (
              <p className="explain" role="status">Saved to {run.benchmark.file} · {run.benchmark.mode.toUpperCase()} · workload {run.benchmark.workload} · run #{run.benchmark.run}. Comparison table updated.</p>
            )}
            <Timeline run={run} />
            <p className="explain">
              These times are measured by the web bridge from connect to close, so they include waiting for a free worker.
              The server’s own latency is shown in Live statistics. The server accepts about 10 waiting connections at once;
              above roughly 8 in flight you will see requests stall for a full second while TCP retries.
            </p>
          </div>
        )}
        {!s && !error && <p className="empty" style={{ marginTop: 16 }}>Run a burst to see every request laid out on a timeline.</p>}
      </div>
    </section>
  );
}
