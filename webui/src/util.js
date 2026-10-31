import { useEffect, useRef } from 'react';

// Calls fn now and then every `ms`, never overlapping a slow call with the next one.
export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let alive = true, busy = false;
    const tick = async () => {
      if (busy || !alive) return;
      busy = true;
      try { await ref.current(); } finally { busy = false; }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => { alive = false; clearInterval(id); };
  }, [ms]);
}

export const fmtMs = (n) => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toLocaleString());
export const fmtInt = (n) => Math.round(n).toLocaleString();
export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const byteLen = (s) => new TextEncoder().encode(s).length;
