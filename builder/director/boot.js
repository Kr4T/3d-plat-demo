// boot.js: starts the AI game director on a page (the builder with ?director, or the stand-alone builder/director/).
// Loaded lazily, after the page's first frames; the language model itself is loaded later still, in a worker, and the
// rules director decides until it is ready. Nothing here touches the 3D scene: the game is two functions.
//   ?director            auto: pick the tier for this device (lib/director/tier.mjs)
//   ?director=rules      rules only, no download      ?director=small | full   force a model
//   ?director=mock       the mock model (CI and e2e: no download, no GPU)
//   ?seed=7              replay a run (the seed is shown on the panel)      ?tick=6   seconds between decisions
//   ?pace=waves          no timer: a decision only when the game calls window.__director.decide() (between waves)
// A world that carries the AI Director behaviour (behaviours/ai_director, lib/behaviours/ai_director.mjs) starts this
// with the behaviour's settings instead of ?director; the URL options still win, for debugging.
// The game connects with   window.__director.connect({ getState, apply, zones? })   (see docs/NEXT.md for the shapes);
// until then a seeded stand-in game (lib/director/sim.mjs) feeds the panel, marked "simulated game".
// Every applied action is also sent as a window event 'director:action', and every spoken line as 'director:line'
// (detail: a voice-line record in the talk worker's format, with audio: null, for the TTS pipeline).
import { createDirector } from '../../lib/director/director.mjs';
import { createSim } from '../../lib/director/sim.mjs';
import { createMockModel } from '../../lib/director/mock-model.mjs';
import { pickTier, deviceClass } from '../../lib/director/tier.mjs';
import { PHONE_LIMITS } from '../../lib/director/guard.mjs';
import { DEFAULT_ZONES, decisionSchema, decisionGrammar, parseDecision, isName } from '../../lib/director/schema.mjs';
import { toVoiceLine } from '../../lib/director/banter.mjs';
import { systemPrompt, userPrompt } from '../../lib/director/prompt.mjs';
import { directorSettings } from '../../lib/director/settings.mjs';
import { createLoadMeter } from '../../lib/director/schedule.mjs';
import { createPanel, createSubtitles } from './panel.js';

export async function detectCaps() {
  let webgpu = false, f16 = false, lowGpu = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (a) {
      webgpu = true; f16 = a.features.has('shader-f16');
      // integrated or small graphics get the 0.8B model (lib/director/tier.mjs deviceClass)
      const i = a.info || {};
      lowGpu = deviceClass({ vendor: i.vendor, architecture: i.architecture, description: i.description, device: i.device, isFallbackAdapter: a.isFallbackAdapter ?? i.isFallbackAdapter, maxBufferSize: a.limits?.maxBufferSize, maxStorageBufferBindingSize: a.limits?.maxStorageBufferBindingSize }, navigator.deviceMemory);
    }
  } catch { /* no WebGPU */ }
  const mobile = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);
  return { webgpu, f16, mobile: !!mobile, deviceMemory: navigator.deviceMemory, saveData: !!navigator.connection?.saveData, lowGpu };
}
const randomSeed = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 999999);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// the states the Measure button asks about: fixed, so two machines measure the same work
const BENCH = [
  't 60 s | golden hour (17.5 h) | player hp 80/100 at lake_shore | enemies 2, tactic swarm | storm off | recent: ghost_killed x2, player_hit x1 | ready: spawn, tactic, sandstorm, taunt | mood: trickster',
  't 120 s | night (22 h) | player hp 18/100 at dunes | enemies 7, tactic flank | storm off | recent: player_hit x4 | ready: spawn, tactic, sandstorm, taunt | mood: cruel',
  't 200 s | midday (12 h) | player hp 100/100 at stage_front | enemies 0, tactic retreat | storm off | recent: ghost_killed x3 | ready: spawn, tactic, sandstorm, taunt | mood: storm_caller',
  't 260 s | dusk (19 h) | player hp 55/100 at boulevard | enemies 5, tactic swarm | storm on | recent: storm_started x1, player_hit x2 | ready: spawn, tactic, taunt; wait: sandstorm 31 s | mood: showman',
  't 320 s | morning (9 h) | player hp 92/100 at boulevard | enemies 1, tactic flank | storm off | recent: ghost_killed x4 | ready: spawn, tactic, sandstorm, taunt | mood: patient',
];

/**
 * settings: the AI Director behaviour's params (lib/director/settings.mjs) when a world carries the behaviour, or null
 * when the page was opened with ?director (the debug run: defaults, panel shown). URL options win over settings.
 */
export async function boot({ qs = new URLSearchParams(location.search), mount = document.body, settings = null, host = null } = {}) {
  let set = directorSettings(settings);
  const urlMode = (qs.get('director') || '').toLowerCase();
  const mode = ['rules', 'small', 'full', 'mock'].includes(urlMode) ? urlMode : set.model === 'auto' ? '' : set.model;
  const caps = await detectCaps();
  const tier = mode === 'mock' ? { tier: 'mock', model: null, autoload: false, why: 'mock model: no download, no GPU' } : pickTier(caps, ['rules', 'small', 'full'].includes(mode) ? mode : null);
  const pace = () => (['timer', 'waves'].includes(qs.get('pace')) ? qs.get('pace') : set.pace);   // waves: the game calls decide() between waves
  const tickS = () => Math.min(60, Math.max(1, Number(qs.get('tick')) || set.seconds));
  // between waves there are about 5 s of quiet (Encore): a waves decision gets 4 s, then the rules answer
  const timeoutMs = () => Math.max(200, Number(qs.get('timeout')) || (pace() === 'waves' ? 4000 : tickS() * 1000 - 500));
  let seed = parseInt(qs.get('seed'), 10) > 0 ? parseInt(qs.get('seed'), 10) : set.seed || randomSeed();
  let zones = DEFAULT_ZONES, sim = null, game = null, director = null, model = null, loading = null, paused = false, simTimer = null, lineNo = 0;
  const lines = [];                                   // the voice-line records spoken so far (last 50)

  // the scene's frame gaps (one rAF callback, no allocation worth the name): while the scene struggles the model paces itself
  const meter = createLoadMeter();
  let lastBusy = false;
  const watch = (t) => {
    meter.frame(t);
    const b = meter.busy(t);
    if (b !== lastBusy) { lastBusy = b; try { model?.setBusy?.(b); } catch { /* the worker is gone */ } }
    if (!stopped) requestAnimationFrame(watch);
  };
  let stopped = false;
  requestAnimationFrame(watch);
  const subs = createSubtitles(mount);
  const speak = (a) => {
    const v = toVoiceLine({ id: `${a.speaker}-d-${String(++lineNo).padStart(4, '0')}`, speaker: a.speaker, en: a.en, ar: a.ar });
    lines.push(v); if (lines.length > 50) lines.shift();
    subs.show(a, v.duration_s + 1.5);
    window.dispatchEvent(new CustomEvent('director:line', { detail: v }));
    return v;
  };
  const panel = createPanel(mount, {
    folded: caps.mobile && !qs.has('panel'),          // a phone starts with the one-line view (the why); ?panel opens it
    onLoad: () => load(),
    onMeasure: () => measure(),
    onSeed: () => { seed = randomSeed(); if (sim) useSim(); build(); },
    onPause: () => { paused = !paused; if (paused) director.stop(); else if (pace() === 'timer') director.start(); panel.setPaused(paused); },
  });
  panel.el.hidden = !(settings === null || set.panel || qs.has('director'));   // a world shows the panel only when it asks for it

  function build() {
    director?.stop();
    director = createDirector({
      getState: () => game.getState(),
      apply: (a) => { game.apply(a); window.dispatchEvent(new CustomEvent('director:action', { detail: structuredClone(a) })); if (a.type === 'taunt') speak(a); },
      seed, zones, model, busy: () => lastBusy, settings: set, limits: caps.mobile ? PHONE_LIMITS : undefined, intervalMs: tickS() * 1000, timeoutMs: timeoutMs(), onRecord: (r) => panel.record(r),
    });
    panel.setSeed(seed);
    if (pace() === 'timer' && !paused) director.start();
    api.director = director;
  }
  function useSim() {
    clearInterval(simTimer);
    sim = createSim({ seed, zones });
    game = { getState: sim.state, apply: sim.apply };
    simTimer = setInterval(() => { if (!paused) sim.step(1); }, 1000);
    panel.setSimulated(true);
  }

  // a decision request on one of the fixed states, in this world's line mode (the default zones: the measure is comparable)
  const benchRequest = (i, seed) => { const o = { lines: set.lines }; return { system: systemPrompt(o), user: userPrompt(BENCH[i % BENCH.length]), schema: decisionSchema(undefined, o), grammar: decisionGrammar(undefined, o), lines: set.lines, seed, maxTokens: 110, temperature: 0.9 }; };

  /** Download (first time) and start the tier's model in a worker; the rules keep deciding until it is ready. */
  function load() {
    if (model || loading || !tier.model) return loading || Promise.resolve(model);
    const spec = tier.model;
    panel.hideLoad();
    panel.setStatus('loading', `Loading ${spec.id.replace(/-MLC$/, '')} (${spec.downloadMB.toLocaleString('en')} MB the first time); the rules decide meanwhile.`, 0);
    api.loading = { modelId: spec.id, progress: 0 }; // for the game's badge (lib/combat/game-mode.mjs directorBadge): "AI loading 43%"
    loading = import('./webllm-model.js')
      .then((m) => m.loadBrowserModel(spec, { onProgress: (p) => { panel.setStatus('loading', p.text, p.progress); if (api.loading && Number.isFinite(p.progress)) api.loading.progress = p.progress; },
        // the warm-up: one real decision before the model takes over (the first generation is the slow one)
        warm: benchRequest(0, 1) }))
      .then((m) => {
        model = m; director.setModel(m); m.setBusy?.(lastBusy);
        api.info = { modelId: spec.id, downloadMB: spec.downloadMB, licence: spec.licence, ...m.info };
        panel.setStatus('model', `The model decides (${tier.why}). Licence ${spec.licence}. Runs in this browser; nothing is sent to a server.`);
        panel.perf(api.info); panel.showMeasure(true);
        return m;
      })
      .catch((e) => {
        panel.setStatus('error', `The model did not load (${String(e.message).slice(0, 140)}). The rules keep deciding.`);
        panel.offerLoad('Try the model again');
        return null;
      })
      .finally(() => { loading = null; api.loading = null; });
    return loading;
  }

  /** Ask the loaded model for `runs` decisions on fixed states (nothing is applied to the game) and report the speed. */
  async function measure(runs = 5) {
    if (!model || !model.info) return null;
    const was = director.running; director.stop();
    panel.busy(true, 'Measuring…');
    const gaps = []; let last = performance.now(), raf = 0;
    const frame = (t) => { gaps.push(t - last); last = t; raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
    const out = [];
    try {
      for (let i = 0; i < runs; i++) {
        const r = await model.decide(benchRequest(i, 1000 + i));
        out.push({ mode: r.mode, prefix: r.prefix, finish: r.finish, ms: r.ms, tokens: r.tokens, promptTokens: r.promptTokens, tokensPerSecond: r.tokensPerSecond, prefillTokensPerSecond: r.prefillTokensPerSecond, ttftMs: r.ttftMs, valid: parseDecision(r.text, { lines: set.lines }).ok, text: r.text });
      }
    } finally { cancelAnimationFrame(raf); panel.busy(false, 'Measure'); if (was && !paused && pace() === 'timer') director.start(); }
    gaps.sort((a, b) => a - b);
    const m = { model: model.id, ...api.info, mode: out[0]?.mode ?? null, runs: out.length, valid: out.filter((o) => o.valid).length,
      tokensPerSecond: Math.round(median(out.map((o) => o.tokensPerSecond)) * 10) / 10, msPerDecision: Math.round(median(out.map((o) => o.ms))),
      tokensPerDecision: Math.round(median(out.map((o) => o.tokens))), msWorst: Math.max(0, ...out.map((o) => o.ms)), underBudget: out.every((o) => o.ms < 4000), promptTokens: out[0]?.promptTokens ?? 0, ttftMs: Math.round(median(out.map((o) => o.ttftMs))),
      frameGapP95: Math.round(gaps[Math.floor(gaps.length * 0.95)] || 0), userAgent: navigator.userAgent, caps, decisions: out };
    api.metrics = m; panel.perf(api.info, m);
    return m;
  }

  const api = {
    seed: () => seed, settings: () => ({ ...set }), host, caps, tier, director: null, info: null, loading: null, metrics: null, lines, panel, subtitles: subs, load, measure,
    /** The game takes over from the stand-in: getState() and apply(action), and its own zone names if it has them. */
    connect({ getState, apply, zones: z } = {}) {
      if (typeof getState !== 'function' || typeof apply !== 'function') throw new Error('connect({ getState, apply }): two functions');
      clearInterval(simTimer); sim = null;
      zones = Array.isArray(z) && z.length >= 2 && z.length <= 12 && z.every(isName) ? [...z] : DEFAULT_ZONES;
      game = { getState, apply };
      panel.setSimulated(false); build();
    },
    /** One decision now. With pace "waves" this is the only way a decision happens: the game calls it between waves. */
    decide: () => director.tick(),
    /** Think ahead: call while the wave is still running (about 70% cleared, or its last ghost spawned); decide() at the
     * wave's end then commits that answer if it has arrived and still passes the guard, else the rules answer. */
    prepare: () => director.prepare(),
    /** New settings from the behaviour's card (the model tier is chosen once, at start). */
    configure(p) { set = directorSettings(p); panel.el.hidden = !(set.panel || qs.has('director')); if (set.seed && !(parseInt(qs.get('seed'), 10) > 0)) seed = set.seed; build(); },
    /** A line on demand: say('djinn', 'greeting'); cues are in lib/director/banter.mjs CUES. null when the world switched that speaker off. */
    async say(speaker, cue) { const l = await director.say(speaker, cue); if (l) speak(l); return l; },
    stop() { stopped = true; director.stop(); clearInterval(simTimer); panel.destroy(); subs.el.remove(); },
  };

  useSim(); build();
  if (tier.tier === 'mock') { model = createMockModel({ seed }); director.setModel(model); panel.setStatus('model', 'Mock model: canned answers for tests. No download, no GPU.'); }
  else if (tier.tier === 'rules') panel.setStatus('rules', `Rules director (${tier.why}). No model is downloaded.`);
  else if (tier.autoload) {
    panel.setStatus('rules', `Rules director for now; the model loads when the page is idle (${tier.why}).`);
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => load(), { timeout: 4000 });
  } else {
    panel.setStatus('offer', `Rules director (${tier.why}).`);
    panel.offerLoad(`Load AI model (${tier.model.downloadMB.toLocaleString('en')} MB)`);
  }
  window.__director = api;
  window.__DIRECTOR_READY__ = true;
  return api;
}
