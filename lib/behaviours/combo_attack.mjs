// combo_attack.mjs: the `combo_attack` behaviour (behaviours/combo_attack/behaviour.json; targets character, needs player or
// equippable: lib/combat/requires.mjs). In Play, on the character Walk drives:
//   input     desktop: J or a left click for light, K or shift-click for heavy (a click is a press under 6 px and 300 ms, so
//             the walk's drag-to-look still works), with a key hint for the first seconds; phone: Attack (tap: a slash,
//             tap on: the chain; held: the heavy) and Heavy in the page's button cluster (window.__game.buttons, bottom
//             right; the walk's stick is on the left)
//   moves     lib/combat/combo.mjs (buffering, the chain, the hit windows) over lib/combat/moves.mjs (the default light chain of
//             3 and the heavy leap-slash; `chain` picks which), `speed`, `damage`, `reach`, `lunge` scale them
//   pose      on the rigged actor (lib/runtime/actors.mjs) the move's pose each frame; between moves the guard stance,
//             walking while the walk moves him (lib/combat/gait.mjs)
//   lunge     root motion through the walk itself: while a move lunges, the walk's input is a push forward (collision-safe:
//             the walk's character controller moves him), then the player's own input again; the heavy's hop is the actor's
//             own lift (the walk's jump is far higher than a 35 cm hop)
//   counter   hits in a row on the screen ("3 ×", top right), from the hits on ctx.events
//   hits      while a hit window is open, every frame the blade (equippable's weaponSegment) or the reach segment is swept
//             through Rapier (lib/combat/hits.mjs); each target once per window; a hit lands (lib/combat/world.mjs land):
//             damage, knock-back, the burst at the contact point, a hit-stop (time scale 0.05 for `hitStop` ms) and a shake
import { combatWorld } from '../combat/world.mjs';
import { needsError } from '../combat/requires.mjs';
import { createCombo } from '../combat/combo.mjs';
import { DEFAULT_MOVES, STANCE, LIGHT_CHAIN, HEAVY, poseAt, toRigPose, fullPose } from '../combat/moves.mjs';
import { reachSegment } from '../combat/hits.mjs';
import { scaleOf } from '../runtime/scene-view.mjs';
import { createComboCounter } from '../combat/waves.mjs';
import { label, gameButtons, T } from '../combat/hud.mjs';

export const LABELS = { light: { en: 'Attack', ar: 'هجوم' }, heavy: { en: 'Heavy', ar: 'ثقيلة' } };
export const HOLD = 0.35; // seconds: Attack held this long is the heavy
export const KEY_HINT = { en: 'WASD move · Shift sprint · Space jump · J or click attack · K or Shift-click heavy', ar: 'WASD للحركة · Shift للعدو · المسافة للقفز · J أو نقرة للهجوم · K أو Shift مع النقر للضربة الثقيلة' };

/** The moves a `chain` param allows: the light chain (light3 ends it), the heavy, or both. */
export function movesFor(chain, base = DEFAULT_MOVES) {
  const m = structuredClone(base);
  if (chain === 'heavy') { for (const id of LIGHT_CHAIN) delete m[id]; }
  if (chain === 'light3') delete m[HEAVY];
  return m;
}

export function attach(ctx, item, params = {}) {
  const w = combatWorld(ctx);
  const why = needsError(ctx.registry, item, 'combo_attack');
  if (why) { w.notice(why); return { uid: item.uid, refused: why, press() {}, dispose() {} }; }
  const def = ctx.registry?.get?.(item.component) || null;
  let p = { ...params }, moves = movesFor(p.chain), combo = make(), cur = null, ui = null, listening = false, pushing = false, hint = null, hintLeft = 0, holdCheck = null;
  function make() { return createCombo({ moves, light: moves.light1 ? 'light1' : 'heavy', heavy: moves.heavy ? 'heavy' : 'light1', speed: p.speed || 1 }); }
  // the combo counter: his hits in a row (2.5 s without one, or a hit taken, starts again), shown from 2 up
  const counter = createComboCounter(); let countEl = null, played = 0; // played: seconds of Play by the frames' own dt (a slow frame is at most 0.1 s), so the 2.5 s gap is the game's time
  const offHit = w.events.on('hit', (e) => { if (e.from === item.uid) counter.hit(played); else if (e.uid === item.uid) counter.broken(); });
  const isPlayer = () => w.playing() && ctx.walk?.playerUid === item.uid;
  const height = () => { const it = ctx.find?.(item.uid) || item; return (def?.params?.find?.((q) => q.name === 'height')?.default || 1.8) * (def ? scaleOf(def, it.params || {}) : 1); };
  // ---------- input ----------
  const press = (kind) => { if (isPlayer()) combo.press(kind); };
  const onKey = (e) => { if (e.repeat || e.target?.closest?.('input, textarea, select')) return; if (e.code === 'KeyJ') press('light'); else if (e.code === 'KeyK') press('heavy'); };
  let down = null;
  const onDown = (e) => { if (e.pointerType === 'touch' || e.button !== 0) return; down = { x: e.clientX, y: e.clientY, t: performance.now(), shift: e.shiftKey }; };
  const onUp = (e) => { if (!down || e.pointerType === 'touch') return; const d = down; down = null; if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && performance.now() - d.t < 300) press(d.shift || e.shiftKey ? 'heavy' : 'light'); };
  const canvas = () => ctx.stage?.renderer?.domElement || null;
  function listen(on) {
    if (on === listening || typeof addEventListener !== 'function') return;
    listening = on;
    const el = canvas();
    if (on) { addEventListener('keydown', onKey); el?.addEventListener('pointerdown', onDown); addEventListener('pointerup', onUp); }
    else { removeEventListener('keydown', onKey); el?.removeEventListener('pointerdown', onDown); removeEventListener('pointerup', onUp); }
    const phone = globalThis.matchMedia?.('(pointer: coarse)').matches;
    if (on && phone && !ui && globalThis.document) ui = buttons();
    if (!on && ui) { ui.remove(); ui = null; }
    // a desktop: the keys, said once at the start for a few seconds
    if (on && !phone && !hint && globalThis.document) { hint = label(ctx, 'keyHint', 'bottom:calc(84px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);max-width:92vw;text-align:center;font-weight:500;background:rgba(20,22,30,.55);padding:8px 14px;border-radius:12px'); hint.set(T(KEY_HINT)); hintLeft = 7; }
    if (!on && hint) { hint.remove(); hint = null; }
  }
  /** The touch buttons, in the page's shared cluster (lib/combat/hud.mjs gameButtons, window.__game.buttons: the locomotion
   * worker's Jump and Dodge plug in there): Attack (a tap is a slash, chained by tapping on; held HOLD seconds it is the
   * heavy) and Heavy (a press). */
  function buttons() {
    const B = gameButtons(ctx); let downAt = null, fired = false;
    const offA = B.add({ id: 'attack', label: T(LABELS.light), size: 76, order: 0, attrs: { attack: 'light' },
      onDown: () => { downAt = played; fired = false; holdCheck = () => { if (downAt !== null && !fired && played - downAt >= HOLD) { fired = true; press('heavy'); } }; },
      onUp: () => { if (downAt !== null && !fired) press('light'); downAt = null; holdCheck = null; } });
    const offH = B.add({ id: 'heavy', label: T(LABELS.heavy), size: 60, order: 1, attrs: { attack: 'heavy' }, onDown: () => press('heavy') });
    B.show(true);
    return { remove() { offA(); offH(); holdCheck = null; if (!B.list().length) B.show(false); } };
  }
  // ---------- each frame ----------
  // the lunge: the walk is steered at a fraction of the run speed (the run is the walk's default: no fast flag; `sprint`
  // would be the faster one, lib/walk/locomotion.mjs)
  function setPush(on, yaw = 0, speed = 0) {
    if (!ctx.walk) return;
    if (on) { const run = (ctx.find?.(item.uid)?.behaviours || []).find((b) => b.type === 'player')?.params?.runSpeed || 6.2, m = Math.min(1, speed / run); ctx.walk.input = { mx: Math.sin(yaw) * m, mz: Math.cos(yaw) * m }; pushing = true; }
    else if (pushing) { ctx.walk.input = null; pushing = false; }
  }
  const handle = {
    uid: item.uid,
    press: (kind) => combo.press(kind), // tests and the e2e
    state: () => ({ ...combo.state(), current: cur?.id || null, combo: counter.value(played), bestCombo: counter.best }),
    update(dt) {
      const on = isPlayer();
      played += dt; holdCheck?.();
      if (hint && (hintLeft -= dt) <= 0) { hint.remove(); hint = { remove() {}, set() {} }; }
      listen(on);
      if (on) { const n = counter.value(played); countEl ||= label(ctx, 'comboCount', 'top:calc(104px + env(safe-area-inset-top));right:20px;font-size:28px'); countEl.set(n >= 2 ? `${n} ×` : ''); } else if (countEl) { countEl.remove(); countEl = null; counter.broken(); }
      if (!on) { if (cur || combo.state().phase !== 'idle') { combo.reset(); cur = null; setPush(false); } return; }
      const scale = w.timeScale();
      for (const e of combo.update(dt, scale)) {
        if (e.type === 'start') cur = { id: e.move, m: moves[e.move], yaw: w.yawOf(item.uid) };
        else if (e.type === 'end') { cur = null; setPush(false); }
        else if (e.type === 'window') ctx.events?.emit?.(e.open ? 'swing' : 'swing_end', { uid: item.uid, move: e.move });
      }
      const s = combo.state();
      const idle = cur ? null : w.idlePose(item.uid, dt); // the guard, walking with the walk
      w.actors().then((actors) => {
        const a = actors?.get(item.uid); if (!a || !actors.shown(item.uid)) return;
        const pose = idle || poseAt(cur.m, s.u);
        if (!ctx.behaviours?.get?.(item.uid, 'hit_reaction')?.handle?.flinching?.()) a.pose(toRigPose(pose));
        const hop = cur?.m.hop ? cur.m.hop * Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (s.u - 0.25) / 0.4)))) : 0;
        if (a.rootOffset.y !== hop) { a.rootOffset.y = hop; actors.attach(a); }
      });
      if (cur) {
        const m = cur.m, lunge = m.lunge * (p.lunge ?? 1), span = Math.max(0.05, m.hit[1] - 0.15);
        if (lunge > 0 && s.u >= 0.15 && s.u < m.hit[1]) setPush(true, cur.yaw, (lunge / (span * m.duration / (p.speed || 1))) * scale);
        else setPush(false);
        if (s.windowOpen) {
          const hits = w.hits();
          if (hits) {
            const seg = ctx.behaviours?.get?.(item.uid, 'equippable')?.handle?.weaponSegment?.() || null;
            const reach = Math.max(0.1, m.reach + (p.reach || 0));
            const sweep = seg ? { ...seg, radius: 0.1 } : { ...reachSegment({ p: w.positionOf(item.uid), yaw: w.yawOf(item.uid), height: height() }, reach), radius: 0.14 };
            // the blade alone can pass beside a target as the arm swings; the reach segment covers the move's reach too
            const extra = seg ? { ...reachSegment({ p: w.positionOf(item.uid), yaw: w.yawOf(item.uid), height: height() }, reach), radius: 0.14 } : null;
            const got = [...hits.sweep({ ...sweep, window: s.window, exclude: item.uid }), ...(extra ? hits.sweep({ ...extra, window: s.window, exclude: item.uid }) : [])];
            for (const h of got) w.land({ from: item.uid, uid: h.uid, point: h.point, damage: m.damage * (p.damage ?? 1), hitStopMs: p.hitStop ?? 75, shake: p.shake ?? 0.05 });
          }
        }
      }
    },
    onParams(next) { const chainChanged = next.chain !== p.chain || next.speed !== p.speed; p = { ...next }; if (chainChanged) { moves = movesFor(p.chain); combo = make(); cur = null; } },
    dispose() { listen(false); setPush(false); offHit(); countEl?.remove(); hint?.remove?.(); },
  };
  return handle;
}
