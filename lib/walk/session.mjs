// session.mjs: one walk on the scene being built. It ties the scene view and the registry to the walk world
// (lib/walk/controller.mjs): the level from lib/walk/level.mjs, the player's capsule from his component, the ground kept in
// step with the terrain (view.onRebuild: when a layout rebuild re-shapes a ground piece, its new surface replaces the old
// trimesh), and the player drawn by the scene view beside the document (view.setExtras, view.place: the same materials,
// LODs and shadow rule as any instance of the component, one more draw). No DOM: Node runs it (tests/walk.test.mjs).
//
// The player: the item that carries the `player` behaviour (behaviours/player; the plaza's hero), driven where it stands
// and moved in place (view.place on its own uid; a sync after the walk puts it back), with that behaviour's run speed,
// jump and camera distance; with none in the scene, the kit's hero (components/hero, PR #26) drawn beside the document.
// physics: ctx.physics of the behaviour contract (lib/behaviours/index.mjs): { world, rapier, addCollider, raycast,
// onContact, rebuild }.
// The player figure: any character component. The hero has no rig and no clips
// (component.json slots.rig null), so he is moved as a rigid body, facing where he walks, with a small bob while he moves
// (BOB: 2.5 cm at walking pace, one bob per STRIDE metres). No hand animation; a rigged character would play its clips.

import { createWalkWorld, capsuleFor, DT, GRAVITY } from './controller.mjs';
import { LOCOMOTION, locomotionTuning, createGaitState, followTarget } from './locomotion.mjs';
import { levelFor, dryPoint } from './level.mjs';
import { behaviourParams } from '../behaviours/def.mjs';

export const PLAYER_UID = '__walk-player';
export const BOB = 0.025, EYE = 0.78; // metres; the camera looks at EYE x the height

/**
 * Who Walk drives in this document, and where the walk starts (12 Nov 2026, the demo blocker: a hero dropped from the kit
 * carries no behaviour, so Walk drew a second hero somewhere else):
 *  1 the first item carrying `player` whose component is a character → { item, ref, params, tuning: the behaviour's params };
 *  2 else the first placed hero (components/hero), driven where he stands with the behaviour's default tuning;
 *  3 else nobody placed: { item: null, ref: the kit's hero (or first character), spawn }, where `spawn` is the scene's
 *    spawn point when it has one (a placed item whose component has category `spawn`; the kit has none yet), else null
 *    (builder/walk.js then starts by the camera target).
 */
export function playerItem(doc, registry) {
  const pdef = registry.behaviour?.('player') || null;
  const items = [...(doc?.instances || []), ...(doc?.areas || [])];
  for (const item of items) {
    const b = (item.behaviours || []).find((x) => x.type === 'player');
    const def = b && registry.get(item.component);
    if (def?.category === 'character') return { item, ref: item.component, params: item.params || {}, tuning: pdef ? behaviourParams(pdef, b.params) : { ...(b.params || {}) }, spawn: null };
  }
  const tuning = pdef ? behaviourParams(pdef, {}) : {};
  const placed = (doc?.instances || []).find((x) => /^hero@/.test(x.component || '') && registry.get(x.component)?.category === 'character' && Array.isArray(x.transform?.p));
  if (placed) return { item: placed, ref: placed.component, params: placed.params || {}, tuning, spawn: null };
  const chars = registry.list().filter((d) => d.category === 'character').map((d) => d.ref);
  const ref = chars.find((r) => /^hero@/.test(r)) || chars[0] || null;
  const mark = (doc?.instances || []).find((x) => registry.get(x.component)?.category === 'spawn' && Array.isArray(x.transform?.p));
  return { item: null, ref, params: {}, tuning, spawn: mark ? { p: [mark.transform.p[0], null, mark.transform.p[2]], yaw: mark.transform.yaw || 0 } : null };
}

export function createWalkSession(R, { view, registry, doc, player = {}, spawn = null }) {
  const ref = player.ref;
  const def = registry.get(ref);
  if (!def) throw new Error(`walk: no component ${ref}`);
  const own = player.item || null; // the scene's own item, moved in place
  const uid = own ? own.uid : PLAYER_UID;
  const params = { ...Object.fromEntries((def.params || []).map((p) => [p.name, p.default])), ...(player.params || {}) };
  const capsule = capsuleFor(def, params);
  const rigged = !!def.animations?.length; // clips to play; a skeleton alone (slots.rig, drawn by the combat actors) still bobs
  // the `player` behaviour's params (behaviours/player/behaviour.json; lib/walk/locomotion.mjs has the defaults)
  const tuning = locomotionTuning({ ...LOCOMOTION, ...(player.tuning || {}) });
  const toMover = (t) => locomotionTuning(t);
  // how high the player can get: the highest jump the player behaviour allows (its params' max, or this tuning's if higher),
  // its apex v^2 / 2g, plus the body and a margin; the water blockers rise that far over the level (review of PR #28, M1)
  const jumpMax = Math.max(+tuning.jump || 0, ...((registry.behaviour?.('player')?.params || []).filter((p) => p.name === 'jump').map((p) => +p.max || 0)));
  const reach = (jumpMax * jumpMax) / (2 * GRAVITY) + capsule.height + 0.5;
  const read = () => levelFor(view, registry, doc(), { exclude: [uid], reach });
  let level = read();
  const at = own ? { p: [own.transform.p[0], null, own.transform.p[2]], yaw: own.transform.yaw || 0 } : { p: [0, null, 0], yaw: 0 };
  const sp0 = spawn || (own ? null : player.spawn) || at, [dx, dz] = dryPoint(level, sp0.p[0], sp0.p[2], capsule.radius + 0.3);
  const walk = createWalkWorld(R, level, { spawn: { ...sp0, p: [dx, sp0.p[1], dz] }, capsule, tuning: toMover(tuning) });
  const s = walk.state;
  const prev = { x: s.x, y: s.y, z: s.z };
  let shown = false;
  const gait = createGaitState(tuning);
  // the camera's lagged target (the chest), stepped with the physics and interpolated like the figure
  const eye = () => [s.x, s.y + capsule.height * EYE, s.z];
  let look = followTarget(null, eye()), lookPrev = { ...look };

  const groundUids = () => new Set(level.ground.map((c) => c.uid));
  const off = view.onRebuild?.((uids) => {
    if (!uids.some((u) => groundUids().has(u))) return;
    level = read();
    walk.setGround(level.ground); walk.setSolid(level.solid); // the blockers follow the terrain's new height
  }) || null;
  /** The whole level again (a piece opted in or out of `solid`): ground and solid shapes re-read. */
  const rebuild = () => { level = read(); walk.setGround(level.ground); walk.setSolid(level.solid); };
  const physics = {
    get world() { return walk.world; }, rapier: R,
    addCollider: (shape) => walk.addShape(shape),
    raycast: (origin, dir, max) => walk.raycast(origin, dir, max),
    onContact: (cb) => walk.onContact(cb),
    rebuild,
  };

  const instance = () => ({ uid: PLAYER_UID, component: ref, transform: { p: [s.x, s.y, s.z], yaw: s.yaw, s: 1 }, params: player.params || {}, links: [] });
  const api = {
    walk, capsule, rigged, ref, playerUid: uid, physics, tuning,
    get level() { return level; },
    /** New player params (the tuning card while walking): speeds now, the camera distance on the next frame. */
    retune(t = {}) { Object.assign(tuning, locomotionTuning({ ...tuning, ...t })); walk.retune(toMover(tuning)); return { ...tuning }; },
    /** One fixed step (1 / 60 s) with a command { mx, mz, sprint, jump }; keeps the last pose for interpolation. */
    step(cmd) {
      prev.x = s.x; prev.y = s.y; prev.z = s.z; lookPrev = { ...look };
      walk.step(cmd);
      if (Math.hypot(s.x - prev.x, s.z - prev.z) > 5 || Math.abs(s.y - prev.y) > 5) { prev.x = s.x; prev.y = s.y; prev.z = s.z; look = followTarget(null, eye()); lookPrev = { ...look }; gait.reset(); } // a respawn is not interpolated
      else look = followTarget(look, eye(), tuning.cameraLag, DT);
      gait.update(s, DT, tuning);
      return s;
    },
    /** The gait for whatever draws the character (lib/walk/locomotion.mjs createGaitState): { idle, run, sprint, phase,
     * lean, bank, airborne, speed }. A rigged actor blends its clips or its cycle by it. */
    gait: () => ({ ...gait.state }),
    /** The figure's pose between the last two steps (alpha 0..1): feet plus the bob, the yaw, and the lean (forward) and
     * bank (into the turn) in radians. The rigid figure bobs once a step; a figure with clips does not. */
    pose(alpha = 1) {
      const a = Math.min(1, Math.max(0, alpha)), g = gait.state;
      const x = prev.x + (s.x - prev.x) * a, y = prev.y + (s.y - prev.y) * a, z = prev.z + (s.z - prev.z) * a;
      const pace = 1 - g.idle;
      const bob = rigged || !s.g ? 0 : BOB * (1 + g.sprint) * pace * Math.abs(Math.sin(g.phase * 2 * Math.PI));
      return { p: [x, y + bob, z], yaw: s.yaw, moving: pace > 0.05, lean: g.lean, bank: g.bank };
    },
    /** The follow camera at the current pose (lib/walk/controller.mjs followCamera: never through the ground or a piece),
     * looking at the lagged target (tuning.cameraLag). */
    camera({ yaw, pitch, dist, alpha = 1 }) {
      const a = Math.min(1, Math.max(0, alpha));
      const target = [lookPrev.x + (look.x - lookPrev.x) * a, lookPrev.y + (look.y - lookPrev.y) * a, lookPrev.z + (look.z - lookPrev.z) * a];
      return walk.followCamera({ target, yaw, pitch, dist });
    },
    /** Moves the player to a spawn point, which a later fall below the floor comes back to. */
    respawn(sp) { const [x, z] = dryPoint(level, sp.p[0], sp.p[2], capsule.radius + 0.3); walk.setSpawn([x, null, z], sp.yaw || 0); walk.respawn(); prev.x = s.x; prev.y = s.y; prev.z = s.z; look = followTarget(null, eye()); lookPrev = { ...look }; gait.reset(); },
    /** Draws the player through the scene view (one more instance beside the document). */
    async showPlayer() { if (!own) { view.setExtras([instance()]); await view.sync(doc()); } shown = true; },
    async hidePlayer() { if (!own) view.setExtras([]); if (shown) await view.sync(doc()); shown = false; }, // the sync puts the scene's own item back
    place(alpha = 1) { const p = api.pose(alpha); return view.place(uid, p.p, p.yaw, { pitch: p.lean, roll: -p.bank }); },
    dt: DT,
    dispose() { off?.(); walk.free(); },
  };
  return api;
}
