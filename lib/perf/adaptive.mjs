// adaptive.mjs: the 60 fps gate's controller (pure: no DOM, no three.js; builder/perf-gate.js wires it to the stage).
// It watches the frame time over a rolling window and moves along a ladder of quality levels: level 0 is the preset as
// built, the last level is the floor.
//   down: the p95 of the frame interval is over `downMs` (18 ms: a 60 Hz frame is 16.7) on a full window, and the level
//         has been held for `dwellDownMs`. One level at a time; the window starts again after every step, so the next
//         decision is made on frames drawn at the new level only (and after `settleMs`: a step rebuilds passes).
//   up:   only on clear headroom, held without a break for `upSustainMs`, and after `dwellUpMs` at the level. Headroom is
//         a p95 interval under `upMs` (12 ms). A 60 Hz display never shows an interval under 16.7 ms (threejs-performance:
//         "the interval shows dropped frames but not headroom"), so when the window's fastest frames sit at the refresh
//         (p5 >= `cappedMs`) headroom is read from the frame's CPU work instead: work p95 under `upMs` and no dropped
//         frames (interval p95 under downMs - `capMargin`). CPU work does not see the GPU, so a step up is a probe:
//   no flapping: a step down within `probationMs` of a step up doubles the dwell before that level is tried again (up to
//         `maxDwellUpMs`); a level that survives its probation clears its penalty.
// Windows are counted in time, with a minimum number of frames, so a slow machine (a few frames a second) still decides.

export const DEFAULTS = Object.freeze({
  downMs: 18, upMs: 12, windowMs: 2000, minSamples: 5, settleMs: 600,
  dwellDownMs: 2500, dwellUpMs: 8000, upSustainMs: 5000,
  cappedMs: 15, capMargin: 0.4, probationMs: 15000, backoff: 2, maxDwellUpMs: 300000, evalMs: 250,
});

/** The ladders, per tier: what each level asks of the stage (builder/stage.js setQuality). Each level is the whole
 *  setting, so any jump is valid. pixelScale: a share of the preset's own pixel ratio (High 2, Phone 1.5; never under
 *  0.75x). off: post passes by name. lod: the factor on camera distance when a piece picks its LOD (2 = hands over at half
 *  the distance). shadows: the sun's shadow, off only on the floor. TRAA (High) and FXAA stay on at every level. */
export const LADDERS = Object.freeze({
  // High on WebGPU: SSR + GTAO + bloom + TRAA, CSM
  high: [
    { name: 'high', pixelScale: 1, off: [], lod: 1, shadows: true },
    { name: 'high-1', pixelScale: 0.85, off: [], lod: 1, shadows: true },
    { name: 'high-2', pixelScale: 0.85, off: ['ssr'], lod: 1, shadows: true },
    { name: 'high-3', pixelScale: 0.7, off: ['ssr', 'gtao'], lod: 1.5, shadows: true },
    { name: 'high-4', pixelScale: 0.6, off: ['ssr', 'gtao', 'bloom'], lod: 2, shadows: true },
    { name: 'high-5', pixelScale: 0.5, off: ['ssr', 'gtao', 'bloom'], lod: 2, shadows: false },
  ],
  // High on ?webgl (WebGL 2): bloom + FXAA, one shadow map
  'high-webgl': [
    { name: 'high-webgl', pixelScale: 1, off: [], lod: 1, shadows: true },
    { name: 'high-webgl-1', pixelScale: 0.85, off: [], lod: 1, shadows: true },
    { name: 'high-webgl-2', pixelScale: 0.7, off: [], lod: 1.5, shadows: true },
    { name: 'high-webgl-3', pixelScale: 0.6, off: ['bloom'], lod: 2, shadows: true },
    { name: 'high-webgl-4', pixelScale: 0.5, off: ['bloom'], lod: 2, shadows: false },
  ],
  // Phone (either backend): bloom + FXAA
  phone: [
    { name: 'phone', pixelScale: 1, off: [], lod: 1, shadows: true },
    { name: 'phone-1', pixelScale: 0.85, off: [], lod: 1, shadows: true },
    { name: 'phone-2', pixelScale: 0.7, off: [], lod: 1.5, shadows: true },
    { name: 'phone-3', pixelScale: 0.6, off: ['bloom'], lod: 2, shadows: true },
    { name: 'phone-4', pixelScale: 0.5, off: ['bloom'], lod: 2, shadows: false },
  ],
});

/** The ladder a stage runs on. */
export function tierOf({ preset, isWebGPU }) {
  return preset === 'phone' ? 'phone' : isWebGPU ? 'high' : 'high-webgl';
}

/** The nearest-rank percentile of the first n values of `sorted` (ascending). */
export function percentile(sorted, n, q) {
  if (!n) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
}

const CAP = 1024; // frames kept (a 2 s window at 240 Hz is 480)

/**
 * createAdaptive({ levels, config }) -> controller
 *   sample(intervalMs, workMs, nowMs) -> null | { from, to, t, p95, reason }   one call per frame
 *   state() -> { level, p95, work95, p5, samples, steps: [...] }
 *   reset(nowMs)          forget the window (the tab was hidden, a scene was loaded)
 *   set(level, nowMs)     jump to a level (tests, ?perf tools); counts as a step
 *   configure(partial)    change thresholds (tests)
 */
export function createAdaptive({ levels, config = {} } = {}) {
  if (!(levels >= 1)) throw new Error('createAdaptive: levels must be at least 1');
  const cfg = { ...DEFAULTS, ...config };
  const ts = new Float64Array(CAP), iv = new Float32Array(CAP), wk = new Float32Array(CAP), sortA = new Float32Array(CAP), sortB = new Float32Array(CAP);
  let head = 0, count = 0; // ring: the newest sample is at head - 1
  let level = 0, changedAt = null, windowFrom = null, lastEval = -Infinity, upSince = null, lastUpAt = null;
  let p95 = 0, work95 = 0, p5 = 0;
  const penalty = new Array(levels).fill(1); // the dwell multiplier before stepping up INTO level i
  const steps = [];

  const clear = (now) => { head = 0; count = 0; windowFrom = now; upSince = null; };
  function change(to, now, reason) {
    const step = { from: level, to, t: now, p95: +p95.toFixed(2), reason };
    if (to > level && lastUpAt !== null && now - lastUpAt < cfg.probationMs) penalty[level] = Math.min(penalty[level] * cfg.backoff, cfg.maxDwellUpMs / cfg.dwellUpMs); // the probe failed
    if (to < level) lastUpAt = now; else lastUpAt = null;
    level = to; changedAt = now; steps.push(step); if (steps.length > 200) steps.shift();
    clear(now + cfg.settleMs);
    return step;
  }
  /** Fills p95, work95, p5 from the samples inside the window; returns how many there were. */
  function measure(now) {
    let n = 0;
    for (let k = 0; k < count; k++) {
      const i = (head - 1 - k + CAP) % CAP;
      if (now - ts[i] > cfg.windowMs && n >= cfg.minSamples) break; // older than the window (but never fewer than minSamples frames)
      sortA[n] = iv[i]; sortB[n] = wk[i]; n++;
    }
    const a = sortA.subarray(0, n).sort(), b = sortB.subarray(0, n).sort();
    p95 = percentile(a, n, 0.95); p5 = percentile(a, n, 0.05); work95 = percentile(b, n, 0.95);
    return n;
  }

  return {
    get level() { return level; },
    sample(interval, work, now) {
      if (changedAt === null) { changedAt = now; windowFrom = now; }
      if (!(interval > 0) || now < windowFrom) return null; // settling after a step: these frames are not judged
      ts[head] = now; iv[head] = interval; wk[head] = work > 0 ? work : interval; head = (head + 1) % CAP; if (count < CAP) count++;
      if (now - lastEval < cfg.evalMs) return null;
      lastEval = now;
      const n = measure(now);
      if (now - windowFrom < cfg.windowMs || n < cfg.minSamples) return null; // the window is not full yet
      const held = now - changedAt;
      if (lastUpAt !== null && now - lastUpAt >= cfg.probationMs) { penalty[level] = 1; lastUpAt = null; } // the probe held
      if (p95 > cfg.downMs) {
        upSince = null;
        if (level < levels - 1 && held >= cfg.dwellDownMs) return change(level + 1, now, 'slow');
        return null;
      }
      const capped = p5 >= cfg.cappedMs;
      const headroom = capped ? (p95 <= cfg.downMs - cfg.capMargin && work95 < cfg.upMs) : p95 < cfg.upMs;
      if (!headroom || level === 0) { upSince = null; return null; }
      if (upSince === null) upSince = now - Math.min(cfg.windowMs, now - windowFrom); // the full window just measured was clear
      if (now - upSince >= cfg.upSustainMs && held >= cfg.dwellUpMs * penalty[level - 1]) return change(level - 1, now, capped ? 'headroom (cpu work, 60 Hz)' : 'headroom');
      return null;
    },
    state: () => ({ level, p95, work95, p5, samples: count, steps: steps.slice(), penalty: penalty.slice() }),
    reset(now) { clear(now); },
    set(to, now) { const t = Math.max(0, Math.min(levels - 1, to | 0)); if (t === level) return null; const s = change(t, now, 'set'); lastUpAt = null; return s; },
    configure(partial) { Object.assign(cfg, partial); return { ...cfg }; },
  };
}
