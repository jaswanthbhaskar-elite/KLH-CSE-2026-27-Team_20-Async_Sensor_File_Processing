async function call(path, body) {
  const init = body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch('/api/' + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  stats: () => call('stats'),
  activity: (since) => call('activity?since=' + since),
  read: (file) => call('read', { file }),
  write: (file, content) => call('write', { file, content }),
  reset: () => call('reset', {}),
  bench: (op, file, size) => call('bench', { op, file, size }),
  burst: (pairs, concurrency) => call('burst', { pairs, concurrency }),
  benchmarkSummary: () => call('benchmark-summary'),
};
