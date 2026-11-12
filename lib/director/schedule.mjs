// schedule.mjs: keeps the AI director from holding the page's main thread while the 3D scene is drawing.
// Measured 12 Nov 2026 beside the scene (real GPU): 5.1 s mean a decision, 14.8 tokens/s, frame spikes up to 583 ms
// (7 over 100 ms) while the model generated. The model already runs in a Web Worker, so the main thread never
// generates; the spikes come from the model's GPU work sharing the GPU queue with the scene (a decode step or a prefill
// is one long submission the page's frame has to wait behind) plus the page's own small tasks landing on a frame.
// Three small tools, all pure and tested in Node:
//   yieldToMain()        let the browser draw before the next piece of work (scheduler.yield, else a MessageChannel hop)
//   whenIdle(fn)         run fn when the page is idle (requestIdleCallback with a timeout, else a timer)
//   createLoadMeter()    watches frame gaps; busy() says whether the scene is struggling right now
//   createPacer()        for the worker's token loop: while the scene is busy, wait a beat between tokens so the GPU
//                        gets gaps the scene's frames can use; otherwise only yield now and then
export function yieldToMain() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function') return globalThis.scheduler.yield();
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const c = new MessageChannel();
      c.port1.onmessage = () => { c.port1.close(); resolve(); };
      c.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });
}

/** fn() when the page is idle (at most `timeout` ms later). Resolves to fn's result; a throw rejects. */
export function whenIdle(fn, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const run = () => { try { resolve(fn()); } catch (e) { reject(e); } };
    if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(run, { timeout });
    else setTimeout(run, 0);
  });
}

/**
 * Frame-gap meter. Call frame(t) from requestAnimationFrame (t in ms). busy() is true while the mean gap over the last
 * `windowMs` is over `slowMs` (the scene is under 40 fps) or any gap in that window was over `spikeMs`.
 */
export function createLoadMeter({ windowMs = 1000, slowMs = 24, spikeMs = 50 } = {}) {
  let gaps = [], last = null, lastT = 0;
  const trim = (t) => { while (gaps.length && t - gaps[0][0] > windowMs) gaps.shift(); };
  return {
    frame(t) { if (last !== null) gaps.push([t, t - last]); last = t; lastT = t; trim(t); },
    busy(t = lastT) {
      trim(t);
      if (!gaps.length) return false;
      return gaps.some((g) => g[1] > spikeMs) || gaps.reduce((s, g) => s + g[1], 0) / gaps.length > slowMs;
    },
    gaps: () => gaps.map((g) => g[1]),
  };
}

/**
 * The worker's pacing between streamed tokens. pace(i) is awaited after token i: while busy() it sleeps `gapMs` after
 * every `busyEvery` tokens (the GPU idles a beat and the scene draws), else it only yields after every `calmEvery`.
 */
export function createPacer({ busy = () => false, gapMs = 8, busyEvery = 2, calmEvery = 8, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let slept = 0, yielded = 0;
  return {
    async pace(i) {
      if (busy()) { if (i % busyEvery === 0) { slept++; await sleep(gapMs); } }
      else if (i % calmEvery === 0) { yielded++; await yieldToMain(); }
    },
    stats: () => ({ slept, yielded }),
  };
}
