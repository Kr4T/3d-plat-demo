// play/main.js: Encore, the game only. The Encore world (scenes/encore.json) straight into game mode, with none of the
// builder: no editor, chat, tray, tune card, save or server call. It is the same runtime the builder's PLAY uses (the stage,
// the scene view, Walk, the behaviour runtime with Equippable, Combo attack, Health, Hit reaction, Waves and the AI
// director), put together without the editing half:
//   the title card "ENCORE" with Play -> Walk starts -> Waves' 3-2-1 -> wave 1; the HUD, touch buttons, win and lose cards
//   and Again are the behaviours' own (lib/behaviours/waves.mjs, lib/combat/hud.mjs); the director as on the builder page
//   (lib/behaviours/ai_director.mjs: the model at page idle on a desktop with WebGPU, the rules on a phone, ?director=off)
// There is no way back to a builder here: leaving Walk (Escape) shows the title card again.
// Paths: everything is resolved from this file (ROOT = its parent folder), so the page works from any sub-folder (a GitHub
// Pages project site); nothing is fetched from the origin's root and no /api is called. Flags: the stage's (?q=phone|high,
// ?webgl, ?hud), ?lang=ar, ?director=off, ?scene=<path from the root> (default scenes/encore.json).
import { createStage } from '../builder/stage.js';
import { createHud } from '../builder/hud.js';
import { installPerfGate } from '../builder/perf-gate.js';
import { loadRegistry } from '../lib/runtime/registry.mjs';
import { createSceneView } from '../lib/runtime/scene-view.mjs';
import { createWalk } from '../builder/walk.js';
import { createBehaviours } from '../lib/behaviours/index.mjs';
import { createEvents } from '../lib/combat/world.mjs';
import { isGame } from '../lib/combat/game-mode.mjs';
import { sandBurst } from '../lib/behaviours/sand-shared.mjs';
import { openingView } from '../lib/scene/default-scene.mjs';
import { Strings, pageLanguage } from '../builder/editor-ui/strings.js';

const ROOT = new URL('../', import.meta.url); // the site's root: components/, materials/, scenes/, vendor/
const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const lang = pageLanguage(qs); document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
const TEXT = {
  line: { en: 'Hold the stage. Three waves of sand ghosts.', ar: 'اصمد على المسرح. ثلاث موجات من أشباح الرمل.' },
  play: { en: 'PLAY', ar: 'العب' }, loading: { en: 'Loading…', ar: 'جارٍ التحميل…' }, world: { en: 'Loading the world…', ar: 'جارٍ تحميل العالم…' },
  starting: { en: 'Starting…', ar: 'جارٍ البدء…' },
  noGame: { en: 'This build has no playable game: the scene has no player or no Waves (a public build made without its characters).', ar: 'لا لعبة في هذه النسخة: المشهد بلا لاعب أو بلا موجات.' },
  failed: { en: 'The game could not start', ar: 'تعذّر بدء اللعبة' },
};
const T = (k) => TEXT[k][lang] ?? TEXT[k].en;
const status = $('status'), startBtn = $('start'), title = $('title');
$('title-line').textContent = T('line'); startBtn.textContent = T('loading'); status.textContent = T('world');
const notice = (text) => { const n = $('notice'); n.firstElementChild.textContent = text || ''; n.hidden = !text; if (text) setTimeout(() => { if (n.firstElementChild.textContent === text) n.hidden = true; }, 6000); };
const fail = (e) => { window.__STAGE_ERROR__ = e?.message || String(e); status.hidden = false; status.textContent = `${T('failed')}: ${window.__STAGE_ERROR__}`; startBtn.disabled = true; };
addEventListener('error', (e) => { if (!window.__GAME_READY__) fail(e.error || e.message); });
addEventListener('unhandledrejection', (e) => { if (!window.__GAME_READY__) fail(e.reason); });

try {
  const view3d = $('view');
  const stage = await createStage(view3d, { qs });
  createHud(stage, { qs, mount: view3d });
  const registry = await loadRegistry(ROOT.href, globalThis.fetch.bind(globalThis));
  for (const r of registry.rejected || []) console.warn('registry rejected', r.ref, r.errors.join('; '));
  const view = createSceneView(stage, registry);
  installPerfGate(stage, { qs, mount: view3d });

  const scenePath = /^scenes\/[A-Za-z0-9_\-./]+\.json$/.test(qs.get('scene') || '') && !qs.get('scene').includes('..') ? qs.get('scene') : 'scenes/encore.json';
  const res = await fetch(new URL(scenePath, ROOT)); if (!res.ok) throw new Error(`${scenePath}: ${res.status}`);
  const doc = await res.json();
  const own = openingView(doc, view3d.clientWidth / Math.max(1, view3d.clientHeight));
  if (own) { stage.camera.position.set(...own.p); stage.controls.target.set(...own.target); stage.controls.update(); }
  stage.controls.enabled = false; // no orbiting the title card: the walk owns the camera in the game
  const drawn = await view.sync(doc); for (const m of drawn.missing || []) console.warn('not drawn', m);

  // Walk and the behaviour runtime, as builder/main.js wires them (the same ctx members the behaviours read)
  let listener = null;
  const audio = { listener() { if (!listener) { listener = new stage.THREE.AudioListener(); stage.camera.add(listener); } if (listener.context.state !== 'running') listener.context.resume().catch(() => {}); return listener; } };
  const walk = createWalk({ stage, view, registry, doc: () => doc, host: view3d, editing: null, onExit: () => showTitle() });
  const ctx = { view, stage, audio, physics: walk.physics, effects: (ref) => view.effect(ref), walk, registry, root: ROOT, doc: () => doc,
    hud: { caption: $('talk-caption'), notice: (m) => notice(m), strings: Strings(lang) }, notice: (text) => notice(text), events: createEvents() };
  ctx.fx = { sandBurst: (point, opts) => sandBurst(ctx, point, opts) };
  const behaviours = createBehaviours(ctx, registry); ctx.behaviours = behaviours;
  stage.onFrame((dt) => behaviours.update(dt));
  await behaviours.sync(doc);
  window.__game = Object.assign(window.__game || {}, { stage, view, registry, walk, behaviours, events: ctx.events, doc: () => structuredClone(doc), playable: isGame(doc) });

  let starting = false;
  function showTitle() { title.hidden = false; startBtn.disabled = false; startBtn.textContent = T('play'); document.body.classList.remove('walking'); stage.controls.enabled = false; startBtn.focus({ preventScroll: true }); }
  async function start() {
    if (starting || walk.running) return; starting = true; startBtn.disabled = true; startBtn.textContent = T('starting');
    audio.listener(); // inside the tap: a phone starts audio only from a gesture
    try { await walk.start(); title.hidden = true; document.body.classList.add('walking'); }
    catch (e) { console.error(e); notice(`${T('failed')}: ${e.message}`); showTitle(); }
    finally { starting = false; }
  }
  startBtn.addEventListener('click', start);
  addEventListener('keydown', (e) => { if (!title.hidden && !startBtn.disabled && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); start(); } });

  await new Promise((r) => { let n = 0; const off = stage.onFrame(() => { if (++n >= 8) { off(); r(); } }); });
  await view.settled?.();
  status.hidden = true;
  if (!isGame(doc)) { startBtn.disabled = true; startBtn.textContent = '—'; $('title-line').textContent = T('noGame'); }
  else showTitle();
  window.__BUILDER_READY__ = true; // the AI director's idle start waits for this (lib/behaviours/ai_director.mjs)
  window.__GAME_READY__ = true;
} catch (e) { fail(e); console.error(e); }
