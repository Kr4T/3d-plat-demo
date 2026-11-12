// perf-gate.js: the 60 fps gate on the builder's stage. It feeds every frame's interval and CPU work to the controller
// (lib/perf/adaptive.mjs: step down at a p95 over 18 ms, back up with hysteresis) and applies the level it picks through
// stage.setQuality (pixel ratio, post passes, LOD bias, the sun's shadow). It hangs on stage.onFrame, so it runs the same
// while editing, in Walk and combat, and while the AI director's model is thinking.
// Measuring as the threejs-performance skill says: the frame interval for dropped frames, performance.now() around the
// frame's work for headroom; the r187 example webgpu_performance is the reference for reading the renderer per frame.
// Flags: ?perf shows the line (p95 · work · level · steps); ?adaptive=0 switches the gate off, ?adaptive=1 forces it on.
// It is off by default under ?still, ?audit and automation (navigator.webdriver): the gate's shots and the pixel tests
// compare images and must not change resolution on a slow machine. The real-GPU job passes ?adaptive=1.
// window.__builder.perf = { p95, preset, steps, ... } (read-only getters; configure(), set() and reset() for tests).
import { createAdaptive, LADDERS, tierOf } from '../lib/perf/adaptive.mjs';

export function installPerfGate(stage, { qs = new URLSearchParams(location.search), mount = document.body, config = {} } = {}) {
  const tier = tierOf(stage), ladder = LADDERS[tier];
  const asked = qs.get('adaptive');
  const enabled = asked === '1' ? true : asked === '0' ? false : !(qs.has('still') || qs.has('audit') || navigator.webdriver);
  // off: one level, so the p95 is still measured and nothing ever steps
  const ctl = createAdaptive({ levels: enabled ? ladder.length : 1, config });
  let last = 0, started = false; const t0 = performance.now();
  const apply = () => { try { stage.setQuality(ladder[ctl.level]); } catch (e) { console.error('perf gate', e); } };

  const perf = {
    enabled, tier, ladder,
    get p95() { return ctl.state().p95; },
    get work95() { return ctl.state().work95; },
    get level() { return ctl.level; },
    get preset() { return ladder[ctl.level].name; },
    get steps() { return ctl.state().steps; },
    get pixelRatio() { return stage.renderer.getPixelRatio(); },
    state: () => ({ ...ctl.state(), tier, preset: ladder[ctl.level].name, enabled, pixelRatio: stage.renderer.getPixelRatio(), seconds: (performance.now() - t0) / 1000 }),
    configure: (c) => ctl.configure(c),
    set(level) { const s = ctl.set(level, performance.now()); if (s) apply(); return s; },
    reset() { ctl.reset(performance.now()); },
  };
  const publish = () => { if (window.__builder && window.__builder.perf !== perf) window.__builder.perf = perf; };
  publish();

  // ?perf: one line under the status area, as the ?hud line (builder/hud.js)
  let el = null, acc = 0;
  if (qs.has('perf')) {
    el = document.createElement('div');
    el.id = 'perf-hud'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:absolute;left:8px;top:8px;max-width:calc(100% - 16px);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'color:rgba(243,239,232,.85);background:rgba(10,12,20,.6);padding:4px 8px;border-radius:6px;pointer-events:none;z-index:5;overflow-wrap:anywhere';
    el.textContent = enabled ? 'fps gate …' : 'fps gate off';
    mount.appendChild(el);
  }
  const line = () => { const s = ctl.state(); return `p95 ${s.p95.toFixed(1)} ms · work ${s.work95.toFixed(1)} ms · ${ladder[s.level].name} (${s.level}/${ladder.length - 1}) · ${stage.renderer.getPixelRatio().toFixed(2)}x · ${s.steps.length} steps${enabled ? '' : ' · gate off'}`; };

  const onVisible = () => { last = 0; ctl.reset(performance.now()); }; // a hidden tab draws no frames: its gap is not a slow frame
  document.addEventListener('visibilitychange', onVisible);
  const off = stage.onFrame((dt) => {
    const now = performance.now(), interval = last ? now - last : 0; last = now;
    publish();
    // loading (the scene's files, the first shader builds) is not judged: the window starts 1.5 s after the builder is ready
    if (!started) { if (!window.__BUILDER_READY__) return; started = true; ctl.reset(now + 1500); }
    // the frame just finished: its interval, and the CPU work the stage timed for it
    const step = ctl.sample(interval, stage.workMs, now);
    if (step) apply();
    if (el) { acc += dt; if (acc >= 0.5) { acc = 0; el.textContent = line(); } }
  });
  return { perf, dispose() { off(); document.removeEventListener('visibilitychange', onVisible); el?.remove(); } };
}
