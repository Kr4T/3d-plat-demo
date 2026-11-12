// perf.mjs: spans and events for the drop-latency measurements (docs/gpu/drop-latency.md). The r187 references are the
// renderer's own counters (renderer.info, three.js manual "WebGPURenderer") and the User Timing API: every span is also a
// performance.measure, so the Chrome DevTools Performance panel shows the same names.
// A span is { name, t (ms, performance.now at its start), ms, detail }; an event is a named call to its listeners. Both are
// kept in a ring of the last 2,000, cheap enough to stay on in production (one array write per span).
const now = () => globalThis.performance?.now?.() ?? Date.now();
const RING = 2000;
const spans = [];
const listeners = new Map(); // event name -> Set<fn>

function push(name, t, ms, detail) {
  spans.push({ name, t, ms, ...(detail !== undefined ? { detail } : {}) });
  if (spans.length > RING) spans.splice(0, spans.length - RING);
  try { globalThis.performance?.measure?.(name, { start: t, duration: ms }); } catch { /* an old engine: the ring is enough */ }
}

export const perf = {
  now,
  /** Times a synchronous function. */
  span(name, fn, detail) { const t = now(); try { return fn(); } finally { push(name, t, now() - t, detail); } },
  /** Times an async function (start to settle: includes time yielded to the frame loop). */
  async spanAsync(name, fn, detail) { const t = now(); try { return await fn(); } finally { push(name, t, now() - t, detail); } },
  /** Records a span measured elsewhere. */
  add(name, t, ms, detail) { push(name, t, ms, detail); },
  /** The spans that started in [from, to). */
  spans(from = -Infinity, to = Infinity) { return spans.filter((s) => s.t >= from && s.t < to).map((s) => ({ ...s })); },
  on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name)?.delete(fn); },
  emit(name, data) { for (const fn of [...(listeners.get(name) || [])]) { try { fn(data); } catch (e) { console.error('perf listener', name, e); } } },
  clear() { spans.length = 0; },
};
