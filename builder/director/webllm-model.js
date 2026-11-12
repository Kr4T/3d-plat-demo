// webllm-model.js: the page's side of the model worker (llm-worker.js). loadBrowserModel(spec) starts the worker, loads
// the pinned model and resolves to a model object for lib/director/director.mjs:
//   { id, decide(req) -> { text, mode, tokens, tokensPerSecond, ... }, interrupt(), unload(),
//     info: { loadMs, warmMs, mode, warmUp, cached, downloadBytes } }
// `warm` is a decide request the worker runs before it reports ready (the slow first generation), so the first decision
// the game waits for is already a fast one.
// Nothing from WebLLM is imported here: the runtime is fetched by the worker only, when a model is wanted.
export function loadBrowserModel(spec, { onProgress = null, warm = null, workerUrl = new URL('./llm-worker.js', import.meta.url) } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(workerUrl, { type: 'module' }); } catch (e) { reject(e); return; }
    const waiting = new Map();
    let n = 0, ready = false;
    const model = {
      id: spec.id, info: null,
      decide(req) {
        return new Promise((res, rej) => { const k = ++n; waiting.set(k, { res, rej }); worker.postMessage({ type: 'decide', n: k, req }); });
      },
      setBusy(on) { worker.postMessage({ type: 'busy', on: !!on }); },
      interrupt() { worker.postMessage({ type: 'interrupt' }); },
      unload() { worker.postMessage({ type: 'unload' }); setTimeout(() => worker.terminate(), 500); },
    };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'ready') { ready = true; model.info = { loadMs: m.loadMs, warmMs: m.warmMs, mode: m.mode, warmUp: m.warmUp, cached: m.cached, downloadBytes: m.downloadBytes }; resolve(model); }
      else if (m.type === 'answer') { waiting.get(m.n)?.res(m); waiting.delete(m.n); }
      else if (m.type === 'fail') { waiting.get(m.n)?.rej(new Error(m.message)); waiting.delete(m.n); }
      else if (m.type === 'error') { if (!ready) { reject(new Error(m.message)); worker.terminate(); } else console.warn('director model:', m.message); }
    };
    worker.onerror = (e) => { const err = new Error(e.message || 'the model worker failed to start'); if (!ready) reject(err); for (const w of waiting.values()) w.rej(err); waiting.clear(); };
    worker.postMessage({ type: 'load', spec: { id: spec.id, url: spec.url, lib: spec.lib, libIntegrity: spec.libIntegrity, stopTokenIds: [...spec.stopTokenIds] }, warm });
  });
}
