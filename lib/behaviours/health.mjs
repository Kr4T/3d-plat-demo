// health.mjs: the `health` behaviour (behaviours/health/behaviour.json; targets character, animal, piece). Hit points that
// combo_attack's hits take away (lib/combat/world.mjs land) and regen gives back after a pause (lib/combat/health.mjs). The
// item gets a hurtbox in the walk's Rapier world while Play runs (lib/combat/hits.mjs: a sensor capsule sized from its
// component's footprint and height, following the item). At 0 it dies: a `death` event, and with `dissolve` it sinks into
// the ground over 1.2 s and is hidden. All of it is play-time state: when Play ends the health is full again and the item is
// back where the document has it (the walk's own sync puts it back).
// A hurt target shows a small bar over its head in Play (a page element placed from the camera; not shown at full health,
// at death or when Play ends).
import { Vector3 } from 'three';
import { combatWorld } from '../combat/world.mjs';
import { createHealth } from '../combat/health.mjs';
import { scaleOf } from '../runtime/scene-view.mjs';

export const SINK = 1.2; // seconds

const _v = new Vector3();
/** Where a world point is on the page: { x, y } in CSS pixels of the canvas's rect, visible false behind the camera or off it. */
export function screenPoint(camera, rect, p) {
  _v.set(p[0], p[1], p[2]).project(camera);
  const visible = _v.z > -1 && _v.z < 1 && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1;
  return { x: rect.left + ((_v.x + 1) / 2) * rect.width, y: rect.top + ((1 - _v.y) / 2) * rect.height, visible };
}

/** The bar over a hurt target (a page element, not a 3D object): made on first need, only in a browser. */
function makeBar(uid, host) {
  if (!globalThis.document) return null;
  const el = document.createElement('div'); el.className = 'health-bar'; el.dataset.health = uid; el.setAttribute('role', 'meter'); el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
  el.style.cssText = 'position:fixed;width:72px;height:8px;margin:-4px 0 0 -36px;border-radius:4px;background:rgba(20,22,30,.6);border:1px solid rgba(255,255,255,.7);overflow:hidden;pointer-events:none;z-index:20;display:none';
  const fill = document.createElement('div'); fill.style.cssText = 'height:100%;width:100%;background:#e5484d;transition:width .15s linear';
  el.appendChild(fill); (host || document.body).appendChild(el);
  return { el, fill };
}

/** The hurtbox of an item: a capsule round its footprint (or 0.35 m), as tall as the piece (or 1.8 m), scaled with it. */
export function hurtboxOf(def, item) {
  const k = (def ? scaleOf(def, item.params || {}) : 1) * (item.transform?.s || 1);
  const fp = def?.footprint?.outline;
  let r = 0.35;
  if (Array.isArray(fp) && fp.length) { const xs = fp.map((q) => q[0]), zs = fp.map((q) => q[1]); r = Math.max(0.15, Math.min(1.5, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2)); }
  const h = Array.isArray(def?.footprint?.height) ? def.footprint.height[1] : def?.params?.find?.((q) => q.name === 'height')?.default || 1.8;
  return { radius: r * k, height: Math.max(0.3, h * k) };
}

export function attach(ctx, item, params = {}) {
  const w = combatWorld(ctx);
  const def = ctx.registry?.get?.(item.component) || null;
  const health = createHealth({ hp: params.hp, max: params.max, regen: params.regen });
  let p = { ...params }, wasPlaying = false, sink = null, bar = null;
  const barState = () => ({ shown: w.playing() && !health.dead && !sink && health.hp < health.max, fraction: health.fraction });
  // drawn late in the frame (w.late): the bar is placed from the camera the walk set this frame, not the orbit camera
  function showBar() { if (!barState().shown) { if (bar) bar.el.style.display = 'none'; return; } if (!w.late(`health-bar ${item.uid}`, drawBar)) drawBar(); }
  function drawBar() {
    const b = barState();
    if (!b.shown) { if (bar) bar.el.style.display = 'none'; return; }
    const cam = ctx.stage?.camera, canvas = ctx.stage?.renderer?.domElement; if (!cam || !canvas?.getBoundingClientRect) return;
    bar ||= makeBar(item.uid, canvas.parentElement); if (!bar) return;
    const at = w.positionOf(item.uid), s = screenPoint(cam, canvas.getBoundingClientRect(), [at[0], at[1] + t.box().height + 0.2, at[2]]);
    bar.el.style.display = s.visible ? 'block' : 'none'; bar.el.style.left = `${s.x}px`; bar.el.style.top = `${s.y}px`;
    bar.fill.style.width = `${Math.round(b.fraction * 100)}%`; bar.el.setAttribute('aria-valuenow', String(Math.round(b.fraction * 100)));
  }
  const off = w.register(item.uid, 'health', health);
  const t = w.targets.get(item.uid);
  t.box = () => ({ p: w.positionOf(item.uid), ...hurtboxOf(def, ctx.find?.(item.uid) || item) });
  t.player = (item.behaviours || []).some((b) => b.type === 'player');
  const offDeath = w.events.on('kill', (e) => {
    if (e.uid !== item.uid) return;
    w.events.emit('death', { uid: item.uid });
    if (p.dissolve !== false && !t.player) sink = { t: 0, from: w.positionOf(item.uid), yaw: w.yawOf(item.uid), depth: t.box().height };
  });
  const handle = {
    uid: item.uid, health,
    state: () => ({ hp: health.hp, max: health.max, dead: health.dead, sinking: !!sink, bar: barState() }),
    update(dt) {
      const playing = w.playing();
      if (playing && !wasPlaying) { health.reset({ hp: p.hp }); sink = null; ctx.view?.hide?.(item.uid, false); }
      if (!playing && wasPlaying) { health.reset({ hp: p.hp }); sink = null; ctx.view?.hide?.(item.uid, false); }
      wasPlaying = playing;
      if (!playing) { showBar(); return; }
      health.update(dt);
      const hits = w.hits();
      if (hits && !health.dead) { if (!hits.has(item.uid)) hits.add(item.uid, t.box()); else hits.move(item.uid, w.positionOf(item.uid)); }
      if (sink) {
        sink.t += dt;
        const k = Math.min(1, sink.t / SINK), y = sink.from[1] - sink.depth * k * k;
        ctx.view?.place?.(item.uid, [sink.from[0], y, sink.from[2]], sink.yaw);
        if (k >= 1) { ctx.view?.hide?.(item.uid, true); sink = null; }
      }
      showBar();
    },
    onParams(next) { p = { ...next }; health.set({ max: p.max, regen: p.regen }); },
    dispose() { off(); offDeath(); bar?.el.remove(); bar = null; },
  };
  return handle;
}
