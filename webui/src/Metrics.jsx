import { useState } from 'react';
import { fmtInt, fmtMs } from './util.js';

function Spark({ values }) {
  if (values.length < 2) return <svg className="spark" aria-hidden="true" />;
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${24 - (v / max) * 22}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="25" x2="100" y2="25" />
      <polyline points={pts} />
    </svg>
  );
}

export default function Metrics({ stats, hist, stale, onReset }) {
  const [busy, setBusy] = useState(false);
  const s = stats;
  const dash = '–';
  const cells = [
    { label: 'Waiting in queue', value: s ? fmtInt(s.pending) : dash, hint: 'waiting for a worker', series: hist.pending, tone: s && s.pending > 0 ? 'warn' : '' },
    { label: 'Completed', value: s ? fmtInt(s.completed) : dash, hint: s ? `${fmtInt(s.reads)} reads, ${fmtInt(s.writes)} writes` : '' },
    { label: 'Failed', value: s ? fmtInt(s.failed) : dash, hint: s && s.failed ? 'see recent activity' : 'none so far', tone: s && s.failed > 0 ? 'bad' : '' },
    { label: 'Average latency', value: s ? fmtMs(s.avgMs) : dash, unit: 'ms', hint: s ? `slowest ${fmtMs(s.maxMs)} ms` : '', series: hist.avgMs },
    { label: 'Throughput', value: s ? fmtInt(s.throughput) : dash, unit: 'req/s', hint: s ? `over ${s.durationSec.toFixed(2)} s of activity` : '', series: hist.throughput },
  ];
  return (
    <section className="panel" aria-label="Live server statistics">
      <div className="panel-head">
        <h2>Live statistics</h2>
        <button className="quiet" disabled={busy || stale} onClick={async () => { setBusy(true); try { await onReset(); } finally { setBusy(false); } }}>
          Reset statistics
        </button>
      </div>
      <div className={`metrics ${stale ? 'stale' : ''}`}>
        {cells.map((c) => (
          <div key={c.label} className={`metric ${c.tone || ''}`}>
            <div className="label">{c.label}</div>
            <div className="value">{c.value}{c.unit && <span>{c.unit}</span>}</div>
            <div className="hint">{c.hint}</div>
            {c.series ? <Spark values={c.series} /> : <div className="spark" />}
          </div>
        ))}
      </div>
    </section>
  );
}
