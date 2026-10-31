import { fmtMs, fmtTime } from './util.js';

export default function ActivityLog({ entries }) {
  return (
    <section className="panel" aria-label="Recent activity">
      <div className="panel-head">
        <h2>Recent activity</h2>
        <span className="small">Live requests sent through this console</span>
      </div>
      <div className="panel-body" style={{ paddingTop: 8 }}>
        {entries.length === 0 ? (
          <p className="empty">No requests yet. Write or read a file, or run a burst benchmark.</p>
        ) : (
          <div className="logwrap">
            <table>
              <thead><tr><th>Time</th><th>Request</th><th>Mode</th><th>Workload / file</th><th>Result</th><th className="num">Time taken</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{fmtTime(e.at)}</td>
                    <td>{e.op}</td>
                    <td>{e.mode ? <span className={`tag-${e.mode}`}>{e.mode.toUpperCase()}</span> : '—'}</td>
                    <td className="mono">
                      {e.workload ? `${e.workload} requests` : (e.file || '—')}
                      {e.details?.length ? (
                        <details className="activity-details">
                          <summary>View {e.details.length} requests</summary>
                          <div className="activity-detail-wrap">
                            <table>
                              <thead><tr><th>#</th><th>Operation</th><th>File</th><th>Result</th><th className="num">Latency</th></tr></thead>
                              <tbody>{e.details.map((d, i) => (
                                <tr key={`${e.id}-${i}`}>
                                  <td>{i + 1}</td><td>{d.op}</td><td className="mono">{d.file}</td>
                                  <td><span className={d.ok ? 'ok' : 'no'}>{d.ok ? 'OK' : 'Failed'}</span></td>
                                  <td className="num">{fmtMs(d.ms)} ms</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          </div>
                        </details>
                      ) : null}
                    </td>
                    <td><span className={e.ok ? 'ok' : 'no'}>{e.ok ? 'OK' : 'Failed'}</span>{e.note ? <span className="small"> {e.note}</span> : null}</td>
                    <td className="num">{fmtMs(e.ms)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
