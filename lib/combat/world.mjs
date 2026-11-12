// world.mjs: what the combat behaviours share, one per behaviour ctx (made on first use, kept on a WeakMap; the behaviour
// core is not changed). It holds:
//   events     ctx.events (made here when the page gives none): emit(type, data), on(type, cb), recent(seconds); every event
//              is also kept as { t, type } for the AI director (PR #33: news for 15 s). Combat emits hit, kill, death,
//              triple_kill (3 kills within 4 s by one attacker) and hit_from_behind (a player hit from behind).
//   targets    uid -> { health, reaction }: who can be hit (health) and how they react (hit_reaction)
//   hits       the Rapier hit sweep (lib/combat/hits.mjs) on ctx.physics.world, re-made when the walk makes a new world;
//              every target's hurtbox is re-added then
//   time       the hit-stop: timeScale() is 0.05 for `ms` after hitStop(ms), then 1 (combat time only: the walk steps on)
//   shake      camera shake: an offset added to the camera after the walk placed it (a frame callback registered after the
//              walk's, so it runs last), decaying over its time
//   actors     lib/runtime/actors.mjs (skinned characters for rigged components), made with ctx.view / ctx.stage
//   idlePose   the pose of an actor between attacks: the guard stance, and the walk cycle while the walk moves it (gait.mjs)
//   playing()  true while Walk (Play) runs
import { createHits } from './hits.mjs';
import { createGait } from './gait.mjs';

const worlds = new WeakMap();
// what the AI director reads as news (lib/director/banter.mjs EVENT_LINES, rules.mjs): hits and swings stay on the bus only
export const DIRECTOR_NEWS = new Set(['triple_kill', 'hit_from_behind', 'camped_wave', 'flawless_wave', 'set_cleared', 'ghost_killed']);
const now = () => (globalThis.performance ? performance.now() : Date.now()) / 1000;

export function createEvents(clock = now) {
  const subs = new Map(), log = [];
  return {
    emit(type, data = {}) { const e = { ...data, t: clock(), type }; log.push(e); if (log.length > 200) log.shift(); for (const cb of [...(subs.get(type) || []), ...(subs.get('*') || [])]) { try { cb(e); } catch (err) { console.error('event', type, err); } } return e; },
    on(type, cb) { if (!subs.has(type)) subs.set(type, new Set()); subs.get(type).add(cb); return () => subs.get(type)?.delete(cb); },
    /** Events of the last `seconds` (the director's news window is 15 s), oldest first: [{ t, type }]. */
    recent(seconds = 15) { const t0 = clock() - seconds; return log.filter((e) => e.t >= t0); },
    /** The bus's clock (seconds): the game's getState().t for the director must be this, so its 15 s news window holds. */
    now: () => clock(),
    /** What the director's getState() takes from here: { t, events: [{ t, type }] } (lib/director/state.mjs keeps the last 8). */
    get state() { return { t: clock(), events: log.filter((e) => DIRECTOR_NEWS.has(e.type)).map(({ t, type }) => ({ t, type })) }; },
  };
}

export function combatWorld(ctx, { clock = now, actors = null } = {}) {
  let w = worlds.get(ctx);
  if (w) return w;
  if (!ctx.events) ctx.events = createEvents(clock);
  const targets = new Map();
  let hits = null, hitsWorld = null, stopUntil = 0, shakeAmp = 0, shakeUntil = 0, shakeLen = 0.2, actorsP = null;
  const kills = new Map(); // attacker uid -> [t]
  const gaits = new Map(); // uid -> gait
  const lates = new Map(); let lateWorld = null; // key -> off, for the current Play session (its Rapier world)
  const offset = { x: 0, y: 0, z: 0 };
  w = {
    events: ctx.events,
    targets,
    clock,
    playing: () => !!ctx.walk?.running,
    /** True while this item is the walk's player in the middle of a dodge: hits on it miss (land). */
    dodging: (uid) => !!(ctx.walk?.running && ctx.walk.playerUid === uid && ctx.walk.state?.()?.dodging),
    /** The hit sweep on the walk's current Rapier world (null while not walking). */
    hits() {
      const world = ctx.physics?.world || null, R = ctx.physics?.rapier || null;
      if (!world || !R) { hits = null; hitsWorld = null; return null; }
      if (world !== hitsWorld) {
        hits = createHits({ world, rapier: R }); hitsWorld = world;
        for (const [uid, t] of targets) if (t.health && !t.health.dead) hits.add(uid, t.box());
      }
      return hits;
    },
    register(uid, part, value) {
      const t = targets.get(uid) || { uid, box: () => ({ p: w.positionOf(uid), radius: 0.35, height: 1.8 }) };
      t[part] = value; targets.set(uid, t);
      if (part === 'health' && hits) hits.add(uid, t.box());
      return () => { const x = targets.get(uid); if (!x) return; delete x[part]; if (part === 'health') hits?.remove(uid); if (!x.health && !x.reaction) targets.delete(uid); };
    },
    positionOf(uid) { const a = ctx.view?.objectOf?.(uid); if (a) { a.updateMatrixWorld?.(); return [a.position.x, a.position.y, a.position.z]; } const it = ctx.find?.(uid); return it?.transform?.p ? [...it.transform.p] : [0, 0, 0]; },
    yawOf(uid) { const a = ctx.view?.objectOf?.(uid); if (a) return a.rotation.y; return ctx.find?.(uid)?.transform?.yaw || 0; },
    hitStop(ms = 75, scale = 0.05) { stopUntil = clock() + ms / 1000; w.stopScale = scale; },
    timeScale: () => (clock() < stopUntil ? w.stopScale ?? 0.05 : 1),
    stopScale: 0.05,
    shake(amp = 0.06, ms = 200) {
      shakeAmp = Math.max(shakeAmp * (clock() < shakeUntil ? 1 : 0), amp); shakeLen = ms / 1000; shakeUntil = clock() + shakeLen;
      // after the walk placed the camera (late), and taken off before the next frame's walk step
      w.late('shake', () => w.applyShake());
    },
    /** A frame callback that runs after the walk placed the player and the camera this frame. The stage calls its frame
     * callbacks in the order they were added, the orbit controls move the camera before all of them, and the walk adds its
     * own at each Play start: so late work is added once Play runs, and again in each new Play (a new Rapier world).
     * One callback per key. → true when it is (now) registered. */
    late(key, cb) {
      if (!ctx.stage?.onFrame) return false;
      const world = ctx.physics?.world || null;
      if (world !== lateWorld) { for (const off of lates.values()) off(); lates.clear(); lateWorld = world; }
      if (!lates.has(key)) lates.set(key, ctx.stage.onFrame(() => cb()));
      return true;
    },
    lateKeys: () => [...lates.keys()],
    shakeOffset: () => ({ ...offset }),
    applyShake() {
      const cam = ctx.stage?.camera; const left = shakeUntil - clock();
      const k = left > 0 ? shakeAmp * (left / shakeLen) : 0;
      if (left <= 0) shakeAmp = 0;
      offset.x = (Math.random() * 2 - 1) * k; offset.y = (Math.random() * 2 - 1) * k; offset.z = (Math.random() * 2 - 1) * k;
      if (cam && k > 0) { cam.position.x += offset.x; cam.position.y += offset.y; cam.position.z += offset.z; cam.updateMatrixWorld?.(); }
    },
    /** The pose of an actor between attacks (lib/combat/gait.mjs): the guard stance, walking when the walk moves it. Called
     * once a frame by the behaviour that poses the actor (combo_attack, or equippable when the item carries no combo). */
    idlePose(uid, dt = 0) {
      let g = gaits.get(uid); if (!g) gaits.set(uid, (g = createGait()));
      const st = w.playing() && ctx.walk?.playerUid === uid ? ctx.walk.state?.() : null;
      // the player's legs have one driver: the walk's gait (its phase, its idle / run / sprint weights); others go by speed
      return g.update({ speed: st?.speed || 0, grounded: st ? !!st.g : true, gait: st ? ctx.walk.gait?.() || null : null }, dt).pose();
    },
    /** A hit landed: damage the target's health, push it (hit_reaction), fire the burst, hit-stop and shake. */
    land({ from, uid, point, damage = 10, dir = null, hitStopMs = 75, shake = 0.05 }) {
      const t = targets.get(uid); if (!t?.health || t.health.dead) return null;
      if (w.dodging(uid)) { w.events.emit('dodged', { uid, from }); return null; } // the player's dodge (lib/walk/locomotion.mjs, state.dodging): the hit misses
      const pf = w.positionOf(from), pt = w.positionOf(uid);
      const d = dir || (() => { const x = pt[0] - pf[0], z = pt[2] - pf[2], l = Math.hypot(x, z) || 1; return [x / l, 0, z / l]; })();
      const r = t.health.damage(damage, { from, dir: d });
      // hit from behind: the attack comes from behind the target's facing (yaw: three's rotation.y, facing +z turned)
      const yaw = w.yawOf(uid), fx = Math.sin(yaw), fz = Math.cos(yaw);
      if (fx * -d[0] + fz * -d[2] < -0.3 && t.player) w.events.emit('hit_from_behind', { uid, from });
      w.events.emit('hit', { uid, from, damage, point });
      t.reaction?.react({ from, dir: d, point, damage, died: r.died });
      fireBurst(ctx, uid, point);
      if (hitStopMs > 0) w.hitStop(hitStopMs);
      if (shake > 0) w.shake(shake, 180);
      if (r.died) {
        fireBurst(ctx, uid, w.positionOf(uid).map((v, i) => (i === 1 ? v + 0.9 : v)), { kill: true }); // the sand burst on a kill, from the body
        w.events.emit('kill', { uid, from });
        const list = (kills.get(from) || []).filter((x) => clock() - x < 4); list.push(clock()); kills.set(from, list);
        if (list.length === 3) w.events.emit('triple_kill', { from });
        hits?.remove(uid);
      }
      return r;
    },
    /** lib/runtime/actors.mjs for this ctx (made once; ctx.loadGLB replaces the GLTF loader in Node). */
    async actors() {
      if (actors) return actors;
      if (!ctx.view || !ctx.registry) return null;
      actorsP ||= import('../runtime/actors.mjs').then((m) => (actors = m.createActors({ stage: ctx.stage, view: ctx.view, registry: ctx.registry, ...(ctx.loadGLB ? { load: ctx.loadGLB } : {}), ...(ctx.cloneScene ? { clone: ctx.cloneScene } : {}) })));
      return actorsP;
    },
    /** A notice to the creator (ctx.notice from the page), { en, ar } picked by the page language. */
    notice(msg, kind = 'error') { const lang = globalThis.document?.documentElement?.lang === 'ar' ? 'ar' : 'en'; const text = typeof msg === 'string' ? msg : msg[lang]; try { ctx.notice?.(text, kind); } catch { /* ignore */ } w.events.emit('notice', { text, kind }); return text; },
    dispose() { for (const off of lates.values()) off(); lates.clear(); hits?.dispose(); hits = null; hitsWorld = null; worlds.delete(ctx); },
  };
  worlds.set(ctx, w);
  return w;
}

/** The burst at the contact point: the item's own burst_on_hit behaviour, else the effect of that name, else nothing (the fx
 * branch, in parallel, owns the GPU sand and spark particles; until it lands this is a no-op). */
export function fireBurst(ctx, uid, at, { kill = false } = {}) {
  try {
    ctx.events?.emit?.('burst', { uid, at, kill });
    // the item's own burst_on_hit (fx-sand: handle.onHit({ point, impulse }); no impulse is a full burst); else a page-wide
    // hook (ctx.burst, tests); else fx-sand's ctx.fx.sandBurst (any point, no piece needed: the waves' enemies); else the
    // effect of that name
    const own = ctx.behaviours?.get?.(uid, 'burst_on_hit')?.handle;
    if (own?.onHit) { own.onHit(kill ? { point: at } : { point: at, impulse: 1 }); return 'behaviour'; }
    if (own?.fire) { own.fire(uid, { at }); return 'behaviour'; }
    if (typeof ctx.burst === 'function') { ctx.burst({ uid, at, kill }); return 'hook'; }
    // fx-sand on the page (builder/main.js ctx.fx.sandBurst: the shared burst pool, no new draw): full on a kill, a puff on a hit
    if (typeof ctx.fx?.sandBurst === 'function') { ctx.fx.sandBurst(at, kill ? { strength: 1, size: 3 } : { strength: 0.3, size: 1.4, count: 300, duration: 1.2 }); return 'fx'; }
    const fx = ctx.effects?.get?.('burst_on_hit') || ctx.view?.effect?.('burst_on_hit');
    if (fx?.fire) { fx.fire(uid, { at }); return 'effect'; }
  } catch (e) { console.error('burst_on_hit', e); }
  return null;
}
