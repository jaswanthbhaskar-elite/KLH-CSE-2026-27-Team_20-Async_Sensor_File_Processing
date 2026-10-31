import { useState } from 'react';
import { api } from './api.js';
import { byteLen, fmtMs } from './util.js';

const REQUEST_LIMIT = 1023;

export default function Console({ disabled, onActivity }) {
  const [file, setFile] = useState('note.txt');
  const [content, setContent] = useState('Hello from the web console');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);

  const [benchFile, setBenchFile] = useState('bench.dat');
  const [benchSize, setBenchSize] = useState(1048576);

  const room = REQUEST_LIMIT - byteLen(`WRITE ${file} `);
  const used = byteLen(content);
  const over = used > room;

  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      const response = await fn();
      if (response.activity && onActivity) onActivity(response.activity);
      setResult({ kind, ...response });
    }
    catch (e) { setResult({ kind, ok: false, text: e.message, local: true }); }
    finally { setBusy(''); }
  };

  const BENCH_SIZES = [[1024, '1 KB'], [102400, '100 KB'], [1048576, '1 MB'], [16777216, '16 MB']];

  return (
    <section className="panel" aria-label="Read and write files">
      <div className="panel-head"><h2>Files</h2></div>
      <div className="panel-body">
        <div className="field">
          <label htmlFor="file">File name</label>
          <input id="file" type="text" className="mono" value={file} spellCheck={false} autoComplete="off" onChange={(e) => setFile(e.target.value.trim())} />
        </div>
        <div className="field">
          <label htmlFor="content">Content (one line)</label>
          <input id="content" type="text" className="mono" value={content} spellCheck={false} autoComplete="off" onChange={(e) => setContent(e.target.value)} />
          <div className={`count ${over ? 'over' : ''}`}>{used} of {room} bytes</div>
        </div>
        <div className="row">
          <button className="primary" disabled={disabled || !!busy || over || !file} onClick={() => run('Write', () => api.write(file, content))}>
            {busy === 'Write' ? 'Writing…' : 'Write file'}
          </button>
          <button disabled={disabled || !!busy || !file} onClick={() => run('Read', () => api.read(file))}>
            {busy === 'Read' ? 'Reading…' : 'Read file'}
          </button>
        </div>

        <div className={`result ${result && !result.ok ? 'fail' : ''}`} aria-live="polite">
          {!result && <p className="empty">Write a file, then read it back. The server’s reply appears here.</p>}
          {result && (
            <>
              <div className="meta">
                <b>{result.ok ? `${result.kind} succeeded` : `${result.kind} failed`}</b>
                {typeof result.ms === 'number' && <span>{fmtMs(result.ms)} ms</span>}
                {result.kind === 'Read' && result.ok && <span>{result.bytes} bytes</span>}
              </div>
              <pre>{result.text || (result.error ? `Connection error: ${result.error}` : result.ok ? '(empty file)' : '')}</pre>
              {result.truncated && <div className="note">The server returns at most {REQUEST_LIMIT} bytes per read, so this may be only the start of the file.</div>}
            </>
          )}
        </div>

        <details>
          <summary>Large-file benchmark</summary>
          <p className="small" style={{ margin: '8px 0 0' }}>The server creates or reads the data itself, so nothing large crosses the network.</p>
          <div className="row">
            <div className="field"><label htmlFor="bf">File name</label><input id="bf" type="text" className="mono" value={benchFile} onChange={(e) => setBenchFile(e.target.value.trim())} /></div>
            <div className="field"><label htmlFor="bs">Size</label>
              <select id="bs" value={benchSize} onChange={(e) => setBenchSize(Number(e.target.value))}>
                {BENCH_SIZES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <button disabled={disabled || !!busy || !benchFile} onClick={() => run('Benchmark write', () => api.bench('write', benchFile, benchSize))}>{busy === 'Benchmark write' ? 'Writing…' : 'Create file'}</button>
            <button disabled={disabled || !!busy || !benchFile} onClick={() => run('Benchmark read', () => api.bench('read', benchFile))}>{busy === 'Benchmark read' ? 'Reading…' : 'Read it back'}</button>
          </div>
        </details>
      </div>
    </section>
  );
}
