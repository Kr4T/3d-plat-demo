// ai_director.mjs: the AI Director behaviour's runtime (behaviours/ai_director/behaviour.json; the contract is
// lib/behaviours/index.mjs on the walk branch: attach(ctx, item, params) -> { onParams?, dispose }).
// A creator adds the behaviour to a character (the nemesis in Encore) or to the world; this starts the director for the
// page with the behaviour's settings (lib/director/settings.mjs). It draws nothing in 3D. The game still connects its
// own state and actions with window.__director.connect({ getState, apply, zones }), and, with pace "waves", calls
// window.__director.decide() between waves. One director per page: a second item carrying the behaviour is ignored.
// NOT YET RUN inside the behaviour core: lib/behaviours/index.mjs is not on this branch's base (12 Nov 2026).
let live = null;

import { directorOff } from '../combat/game-mode.mjs';

export const SETTLE_FRAMES = 90, BUSY_FRAME = 0.05, RETRY_MS = 1500; // frames after ready before asking for idle; a frame over 50 ms is busy

export function attach(ctx, item, params) {
  if (live) { console.warn(`ai_director: already running on ${live.uid}; ignored on ${item?.uid}`); return { dispose() {} }; }
  const me = { uid: item?.uid ?? 'world', api: null, gone: false, started: false };
  live = me;
  let p = params, frames = 0, slow = 0, asked = false;
  // the page's facts, replaceable in tests (ctx.director: { load, ready, idle, off, desktopGpu, busy })
  const env = ctx?.director || {};
  const off = () => (env.off ? env.off() : directorOff());
  const ready = () => (env.ready ? env.ready() : globalThis.__BUILDER_READY__ === true);
  const idle = env.idle || ((fn) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(fn, { timeout: 6000 }) : setTimeout(fn, 1200)));
  const desktopGpu = () => (env.desktopGpu ? env.desktopGpu() : !!globalThis.navigator?.gpu && !globalThis.matchMedia?.('(pointer: coarse)').matches && !new URLSearchParams(globalThis.location?.search || '').has('webgl'));
  // busy: the frames are slow (a drop, a compile, the first draws), or a prewarm compile says so (builder/prewarm.js, when it lands)
  const busy = () => (env.busy ? env.busy() : slow > 0 || !!globalThis.__PREWARM_BUSY__);
  const start = () => {
    if (me.started || me.gone) return; me.started = true;
    if (globalThis.__director) return; // the page's own (?director): no second one
    const mount = ctx?.hud?.root?.ownerDocument?.body || globalThis.document?.body;
    Promise.resolve(env.load ? env.load() : ctx?.loadDirector ? ctx.loadDirector() : import('../../builder/director/boot.js'))
      .then((m) => m.boot({ settings: p, mount, host: me.uid }))
      .then((api) => { if (me.gone) api.stop(); else me.api = api; })
      .catch((e) => console.warn(`ai_director: ${e.message}`));
  };
  // When it starts (the coordinator's default, 12 Nov 2026). ?director=off: never. A page with no Walk (the director's own
  // test page): at once. In the builder on a desktop with WebGPU: at page idle after the first view is drawn, so the model
  // (about 1 GB the first visit, cached by the browser after) downloads while the visitor looks around, never during the
  // first frames or a busy moment: after __BUILDER_READY__ and SETTLE_FRAMES calm frames an idle callback is asked for, and
  // if the page is busy when it comes it is asked again RETRY_MS later. The rules decide until the model is in. On a phone
  // or WebGL (the rules director, nothing to download): when PLAY first starts the game.
  const askIdle = () => { asked = true; idle(() => { if (me.gone || me.started) return; if (busy()) { setTimeout(askIdle, env.retryMs ?? RETRY_MS); return; } start(); }); };
  if (!off() && !ctx?.walk) start();
  return {
    get started() { return me.started; },
    update(dt = 0) {
      if (me.started || me.gone || off()) return;
      if (ctx?.walk?.running) { if (!desktopGpu()) start(); else if (!asked) askIdle(); return; } // PLAY before the idle start: ask now
      if (!desktopGpu() || !ready()) return;
      slow = dt > BUSY_FRAME ? 20 : Math.max(0, slow - 1); // 20 calm frames after a slow one
      if (++frames >= SETTLE_FRAMES && !asked) askIdle();
    },
    onParams(np) { p = np; me.api?.configure(np); },
    dispose() { me.gone = true; me.api?.stop(); if (live === me) live = null; },
  };
}
