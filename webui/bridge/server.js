#!/usr/bin/env node
'use strict';
/**
 * Bridge: HTTP/JSON  <->  Asynchronous File Processing Server (raw TCP, port 8080)
 *
 * - Zero npm dependencies (only Node built-ins). Needs Node >= 16.
 * - Serves the built React app from ../dist and exposes /api/* for it.
 * - The C server is NOT modified. Every API call becomes exactly one
 *   one-shot TCP request in the server's own text protocol, e.g.
 *   "READ notes.txt", "WRITE notes.txt hello", "STATS", "RESET".
 * - It validates file names and content first, because the C server
 *   passes names straight to open() (so "../x" would escape its directory)
 *   and treats the request as a single line of at most 1023 bytes.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const CFG = {
  serverHost: process.env.AFPS_HOST || '127.0.0.1',
  serverPort: Number(process.env.AFPS_PORT || 8080),
  webHost: process.env.WEB_HOST || '0.0.0.0',
  webPort: Number(process.env.WEB_PORT || 3000),
  staticDir: process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'),
  resultsDir: process.env.RESULTS_DIR || path.resolve(__dirname, '..', '..', 'results'),
};

const REQUEST_LIMIT = 1023;      // server.c: recv(..., BUFFER_SIZE - 1)
const MAX_BENCH_BYTES = 16 * 1024 * 1024;
const MAX_BURST_PAIRS = 250;
let burstInProgress = false;

// ---------------------------------------------------------------- TCP client
function tcpRequest(line, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const startPerf = performance.now();
    const startedAt = Date.now();
    const chunks = [];
    let finished = false;
    const sock = net.connect({ host: CFG.serverHost, port: CFG.serverPort });

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        transportError: error || null,
        text,
        bytes: Buffer.byteLength(text),
        startedAt,
        startPerf,
        ms: performance.now() - startPerf,
        // The C server reports its own failures as "ERROR: ..." text.
        ok: !error && !text.startsWith('ERROR'),
      });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    sock.on('connect', () => sock.write(line));
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('error', (e) => finish(e.code || e.message));
  });
}

// ---------------------------------------------------------------- validation
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function badName(name, forWrite) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    return 'File name must be 1-64 characters: letters, digits, dot, dash or underscore. No slashes, spaces or "..".';
  }
  // server.c locates WRITE data with strstr(request, filename); a name that is
  // a fragment of the word WRITE would be found inside the command itself.
  if (forWrite && 'WRITE'.includes(name)) {
    return `"${name}" collides with the WRITE keyword in the server's parser. Choose another name.`;
  }
  return null;
}

function badContent(name, content) {
  if (typeof content !== 'string') return 'Content must be text.';
  if (/[\r\n\0]/.test(content)) return 'Content must be a single line (the server protocol ends a request at the first newline).';
  const room = REQUEST_LIMIT - Buffer.byteLength(`WRITE ${name} `);
  if (Buffer.byteLength(content) > room) return `Content is too long for this file name: the server accepts at most ${room} bytes per WRITE.`;
  return null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- activity log
const activity = [];
let activitySeq = 0;
function record(entry) {
  const saved = { id: ++activitySeq, at: Date.now(), ...entry };
  activity.push(saved);
  if (activity.length > 150) activity.shift();
  return saved;
}

// ---------------------------------------------------------------- STATS parsing
const STAT_KEYS = {
  'Mode': 'mode', 'Worker threads': 'workers', 'Pending requests': 'pending',
  'Total workload requests': 'total', 'Completed successfully': 'completed', 'Failed': 'failed',
  'READ requests': 'reads', 'WRITE requests': 'writes',
  'Average latency (ms)': 'avgMs', 'Minimum latency (ms)': 'minMs', 'Maximum latency (ms)': 'maxMs',
  'Workload duration (sec)': 'durationSec', 'Throughput (req/sec)': 'throughput',
};
function parseStats(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = STAT_KEYS[line.slice(0, i).trim()];
    if (!key) continue;
    const v = line.slice(i + 1).trim();
    out[key] = key === 'mode' ? v : Number(v);
  }
  return 'mode' in out && 'completed' in out ? out : null;
}

// ---------------------------------------------------------------- BENCHMARK CSV parsing & aggregation
function findResultsDir() {
  const candidates = [
    process.env.AFPS_RESULTS_DIR,
    process.env.RESULTS_DIR,
    CFG.resultsDir,
    path.resolve(__dirname, '..', '..', 'results'),
    path.resolve(process.cwd(), 'results'),
    path.resolve(process.cwd(), '..', 'results'),
    '/home/jaswanth/async_file_server/results',
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return CFG.resultsDir;
}

function parseBenchmarkCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${path.basename(filePath)}`, rows: [] };
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `Failed to read ${path.basename(filePath)}: ${err.message}`, rows: [] };
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { ok: false, error: `${path.basename(filePath)} is empty or missing data rows`, rows: [] };
  }

  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const colIdx = {
    mode: header.indexOf('mode'),
    workload: header.indexOf('workload_label'),
    workloadReqs: header.indexOf('workload_requests'),
    run: header.indexOf('run'),
    total: header.indexOf('total_requests'),
    completed: header.indexOf('completed'),
    failed: header.indexOf('failed'),
    avgLat: header.indexOf('avg_latency_ms'),
    minLat: header.indexOf('min_latency_ms'),
    maxLat: header.indexOf('max_latency_ms'),
    dur: header.indexOf('duration_sec'),
    thr: header.indexOf('throughput_req_s'),
  };

  if (colIdx.workload === -1) colIdx.workload = 1;
  if (colIdx.avgLat === -1) colIdx.avgLat = 9;
  if (colIdx.maxLat === -1) colIdx.maxLat = 11;
  if (colIdx.dur === -1) colIdx.dur = 12;
  if (colIdx.thr === -1) colIdx.thr = 13;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((s) => s.trim());
    if (parts.length <= Math.max(colIdx.workload, colIdx.avgLat, colIdx.maxLat, colIdx.thr)) continue;

    const wlStr = parts[colIdx.workload];
    const wlNum = Number(wlStr);
    const avgLat = Number(parts[colIdx.avgLat]);
    const maxLat = Number(parts[colIdx.maxLat]);
    const dur = Number(parts[colIdx.dur]);
    const thr = Number(parts[colIdx.thr]);

    if (!wlStr || isNaN(avgLat) || isNaN(maxLat) || isNaN(thr)) continue;

    rows.push({
      mode: colIdx.mode !== -1 ? parts[colIdx.mode] : '',
      workload: isNaN(wlNum) ? wlStr : wlNum,
      workloadStr: wlStr,
      avgLat,
      maxLat,
      dur: isNaN(dur) ? 0 : dur,
      thr,
    });
  }

  return { ok: true, rows };
}

function calcMedian(arr) {
  if (!arr || !arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) {
    return sorted[(n - 1) / 2];
  }
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

const round3 = (n) => (typeof n === 'number' && !isNaN(n) ? Number(n.toFixed(3)) : 0);

function aggregateRuns(rows) {
  const groups = new Map();

  for (const r of rows) {
    const key = String(r.workload);
    if (!groups.has(key)) {
      groups.set(key, {
        workload: r.workload,
        lats: [],
        maxLats: [],
        thrs: [],
        durs: [],
      });
    }
    const g = groups.get(key);
    g.lats.push(r.avgLat);
    g.maxLats.push(r.maxLat);
    g.thrs.push(r.thr);
    g.durs.push(r.dur);
  }

  const result = {};
  for (const [key, g] of groups.entries()) {
    const count = g.lats.length;
    if (count === 0) continue;

    const latSum = g.lats.reduce((a, b) => a + b, 0);
    const thrSum = g.thrs.reduce((a, b) => a + b, 0);
    const durSum = g.durs.reduce((a, b) => a + b, 0);

    result[key] = {
      workload: g.workload,
      runs: count,
      meanLat: round3(latSum / count),
      medLat: round3(calcMedian(g.lats)),
      maxLat: round3(Math.max(...g.maxLats)),
      meanThr: round3(thrSum / count),
      medThr: round3(calcMedian(g.thrs)),
      meanDur: round3(durSum / count),
    };
  }

  return result;
}

function appendDashboardBenchmark(stats, workloadRequests) {
  if (!stats || !stats.mode || !Number.isFinite(stats.completed) || !Number.isFinite(stats.failed)) {
    throw new HttpError(502, 'The server returned incomplete benchmark statistics; results were not saved.');
  }

  const mode = String(stats.mode).trim().toLowerCase();
  if (mode !== 'sync' && mode !== 'async') {
    throw new HttpError(502, `Unexpected server mode: ${stats.mode}`);
  }

  const resultsDir = findResultsDir();
  fs.mkdirSync(resultsDir, { recursive: true });
  const filePath = path.join(resultsDir, `${mode}_results.csv`);
  const header = 'mode,workload_label,workload_requests,run,total_requests,completed,failed,read_count,write_count,avg_latency_ms,min_latency_ms,max_latency_ms,duration_sec,throughput_req_s';

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    fs.writeFileSync(filePath, `${header}\n`, 'utf8');
  }

  // Use the number of prior rows for this workload as the next run number.
  const existing = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const priorRuns = existing.slice(1).filter((line) => Number(line.split(',')[1]) === workloadRequests).length;
  const row = [
    mode,
    workloadRequests,
    workloadRequests,
    priorRuns + 1,
    stats.total ?? (stats.completed + stats.failed),
    stats.completed,
    stats.failed,
    stats.reads ?? 0,
    stats.writes ?? 0,
    stats.avgMs ?? 0,
    stats.minMs ?? 0,
    stats.maxMs ?? 0,
    stats.durationSec ?? 0,
    stats.throughput ?? 0,
  ].join(',');

  fs.appendFileSync(filePath, `${row}\n`, 'utf8');
  return { mode, run: priorRuns + 1, file: path.basename(filePath), resultsDir };
}

function getBenchmarkSummary() {
  const resultsDir = findResultsDir();
  const syncFile = path.join(resultsDir, 'sync_results.csv');
  const asyncFile = path.join(resultsDir, 'async_results.csv');

  const syncParsed = parseBenchmarkCsv(syncFile);
  const asyncParsed = parseBenchmarkCsv(asyncFile);

  if (!syncParsed.ok && !asyncParsed.ok) {
    return {
      ok: false,
      error: `Benchmark CSV files not found or invalid in ${resultsDir}. (${syncParsed.error}; ${asyncParsed.error})`,
      workloads: [],
      files: {
        sync: { path: syncFile, exists: false, error: syncParsed.error },
        async: { path: asyncFile, exists: false, error: asyncParsed.error },
      },
    };
  }

  const syncAgg = syncParsed.ok ? aggregateRuns(syncParsed.rows) : {};
  const asyncAgg = asyncParsed.ok ? aggregateRuns(asyncParsed.rows) : {};

  const allKeys = Array.from(new Set([...Object.keys(syncAgg), ...Object.keys(asyncAgg)]));
  allKeys.sort((a, b) => {
    const na = Number(a), nb = Number(b);
    return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
  });

  const workloads = allKeys.map((key) => {
    const s = syncAgg[key] || null;
    const a = asyncAgg[key] || null;
    const runs = s && a && s.runs === a.runs ? s.runs : s ? s.runs : a ? a.runs : 0;

    return {
      workload: !isNaN(Number(key)) ? Number(key) : key,
      label: `${key} requests`,
      runs,
      sync: s,
      async: a,
    };
  });

  return {
    ok: true,
    lastUpdated: new Date().toISOString(),
    resultsDir,
    files: {
      sync: { path: syncFile, exists: syncParsed.ok, runs: syncParsed.ok ? syncParsed.rows.length : 0, error: syncParsed.error || null },
      async: { path: asyncFile, exists: asyncParsed.ok, runs: asyncParsed.ok ? asyncParsed.rows.length : 0, error: asyncParsed.error || null },
    },
    workloads,
  };
}

// ---------------------------------------------------------------- API actions
// Runs fn over items with at most `limit` in flight; preserves result order.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

const api = {
  'GET /api/stats': async () => {
    const r = await tcpRequest('STATS', 3000);
    if (r.transportError) return { up: false, error: r.transportError === 'ECONNREFUSED' ? 'nothing is listening on ' + CFG.serverHost + ':' + CFG.serverPort : r.transportError };
    const stats = parseStats(r.text);
    return stats ? { up: true, stats } : { up: false, error: 'Unexpected STATS reply' };
  },

  'GET /api/benchmark-summary': async () => {
    return getBenchmarkSummary();
  },

  'GET /api/activity': async (_b, url) => {
    const since = Number(url.searchParams.get('since') || 0);
    return { entries: activity.filter((e) => e.id > since) };
  },

  'POST /api/read': async (body) => {
    const err = badName(body.file, false);
    if (err) throw new HttpError(400, err);
    const r = await tcpRequest(`READ ${body.file}`);
    const truncated = r.ok && r.bytes >= REQUEST_LIMIT;
    const activityEntry = record({ op: 'READ', file: body.file, ok: r.ok, ms: r.ms, bytes: r.bytes, note: r.ok ? '' : (r.transportError || r.text) });
    return { ok: r.ok, text: r.text, bytes: r.bytes, ms: r.ms, truncated, error: r.transportError, activity: activityEntry };
  },

  'POST /api/write': async (body) => {
    const err = badName(body.file, true) || badContent(body.file, body.content);
    if (err) throw new HttpError(400, err);
    const r = await tcpRequest(body.content === '' ? `WRITE ${body.file}` : `WRITE ${body.file} ${body.content}`);
    const activityEntry = record({ op: 'WRITE', file: body.file, ok: r.ok, ms: r.ms, bytes: Buffer.byteLength(body.content), note: r.ok ? '' : (r.transportError || r.text) });
    return { ok: r.ok, text: r.text, ms: r.ms, error: r.transportError, activity: activityEntry };
  },

  'POST /api/reset': async () => {
    const r = await tcpRequest('RESET', 3000);
    const activityEntry = record({ op: 'RESET', file: '', ok: r.ok, ms: r.ms, bytes: r.bytes, note: '' });
    return { ok: r.ok, text: r.text, activity: activityEntry };
  },

  // BENCHWRITE / BENCHREAD: the server generates / reads the bytes itself.
  'POST /api/bench': async (body) => {
    const err = badName(body.file, false);
    if (err) throw new HttpError(400, err);
    let line;
    if (body.op === 'write') {
      const size = Math.floor(Number(body.size));
      if (!(size > 0) || size > MAX_BENCH_BYTES) throw new HttpError(400, 'Size must be between 1 byte and 16 MB.');
      line = `BENCHWRITE ${body.file} ${size}`;
    } else if (body.op === 'read') {
      line = `BENCHREAD ${body.file}`;
    } else throw new HttpError(400, 'op must be "write" or "read".');
    const r = await tcpRequest(line, 60000);
    const activityEntry = record({ op: line.split(' ')[0], file: body.file, ok: r.ok, ms: r.ms, bytes: r.bytes, note: r.ok ? r.text : (r.transportError || r.text) });
    return { ok: r.ok, text: r.text, ms: r.ms, error: r.transportError, activity: activityEntry };
  },

  // N WRITEs, then N READs of the same files, with `concurrency` requests in flight.
  // Each completed dashboard run is also persisted to the active mode's CSV so
  // the SYNC/ASYNC comparison table uses the same measurements automatically.
  'POST /api/burst': async (body) => {
    if (burstInProgress) throw new HttpError(409, 'A benchmark is already running. Please wait for it to finish.');
    burstInProgress = true;
    try {
      const pairs = Math.max(1, Math.min(MAX_BURST_PAIRS, Math.floor(Number(body.pairs) || 25)));
      // server.c calls listen(fd, 10): more than ~10 connections arriving in the same
      // instant overflow the kernel accept queue and wait for TCP SYN retransmits (1 s, 3 s, 7 s),
      // which measures the TCP backlog, not the server. So keep a window of requests in flight.
      const concurrency = Math.max(1, Math.min(128, Math.floor(Number(body.concurrency) || 8)));
      const probe = await tcpRequest('RESET', 3000);
      if (probe.transportError || !probe.ok) throw new HttpError(503, 'The file server is not running or could not reset its statistics; benchmark was not started.');
      const base = performance.now();
      const one = async (op, i) => {
        const name = `burst_${i}.txt`;
        const r = await tcpRequest(op === 'WRITE' ? `WRITE ${name} burst payload ${i}` : `READ ${name}`);
        return { op, file: name, start: r.startPerf - base, ms: r.ms, ok: r.ok };
      };
      const idx = Array.from({ length: pairs }, (_, i) => i + 1);
      const writes = await runPool(idx, concurrency, (i) => one('WRITE', i));
      const reads = await runPool(idx, concurrency, (i) => one('READ', i));
      const requests = writes.concat(reads);
      const wallMs = performance.now() - base;
      const lat = requests.map((q) => q.ms).sort((a, b) => a - b);
      const failed = requests.filter((q) => !q.ok).length;
      const summary = {
        count: requests.length, failed, wallMs,
        avgMs: lat.reduce((a, b) => a + b, 0) / lat.length,
        p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95), maxMs: lat[lat.length - 1],
        reqPerSec: requests.length / (wallMs / 1000),
      };

      const statsReply = await tcpRequest('STATS', 5000);
      if (statsReply.transportError) throw new HttpError(502, 'Benchmark ran, but server statistics could not be retrieved; comparison results were not saved.');
      const stats = parseStats(statsReply.text);
      if (!stats) throw new HttpError(502, 'Benchmark ran, but the server returned unreadable statistics; comparison results were not saved.');
      const expected = pairs * 2;
      if (stats.total !== expected || stats.completed + stats.failed !== expected || stats.pending !== 0) {
        throw new HttpError(502, `Benchmark finished with incomplete server statistics (${stats.completed + stats.failed}/${expected} completed); results were not added to the comparison table.`);
      }
      const saved = appendDashboardBenchmark(stats, expected);
      const activityEntry = record({
        op: 'BURST',
        file: `${pairs} writes + ${pairs} reads`,
        mode: saved.mode,
        workload: expected,
        completed: stats.completed,
        failed,
        ok: failed === 0,
        ms: wallMs,
        bytes: 0,
        note: `Run #${saved.run} · ${concurrency} in flight`,
        details: requests.map(({ op, file, ms, ok }) => ({ op, file, ms, ok })),
      });
      return { pairs, concurrency, requests, summary, activity: activityEntry, benchmark: { ...saved, workload: expected, stats } };
    } finally {
      burstInProgress = false;
    }
  },
};

// ---------------------------------------------------------------- HTTP plumbing
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.map': 'application/json',
};

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(new HttpError(400, 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  const file = path.normalize(path.join(CFG.staticDir, rel));
  if (!file.startsWith(path.normalize(CFG.staticDir))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (path.extname(rel)) { res.writeHead(404); return res.end('Not found'); }
      return fs.readFile(path.join(CFG.staticDir, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(500); return res.end('Frontend not built. Run: npm run build (in webui/)'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'Unknown API route');
      const body = req.method === 'POST' ? await readBody(req) : {};
      return sendJson(res, 200, await handler(body, url));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    if (!e.status) console.error(e);
  }
});

server.listen(CFG.webPort, CFG.webHost, () => {
  console.log(`Web UI on http://${CFG.webHost}:${CFG.webPort}  ->  file server at ${CFG.serverHost}:${CFG.serverPort}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
