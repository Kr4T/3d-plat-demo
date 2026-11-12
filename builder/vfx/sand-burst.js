// sand-burst.js: the sand-burst component's module (effect) and the sand trail any piece can carry. r187 examples: webgpu_compute_particles,
// (storage-buffer particles stepped by a compute pass, drawn by one Sprite; its "Hit Particles"
// pass is where a click throws particles outward) and webgpu_compute_particles_snow (particles stopped on the ground
// drawn from above into a height target). The pool, the pass and the look are builder/vfx/sand-particles.js; this file
// decides when and where sand is thrown.
//
// The burst (a kit piece: components/sand-burst): a crown of sand grains and dust thrown up and out from a point, falling
// back under gravity and drag onto the ground under them, fading over `duration`.
//  - One effect for every burst of the scene: one pool (Phone 2,048, High 24,576 particles; half on WebGL), one compute
//    pass, one draw. A burst takes the next `count` slots of the pool (capped at half the pool per burst), so firing more
//    reuses the oldest grains and the pool never grows.
//  - Params (all `affects: "effect"`): size (metres the sand is thrown up: speed sqrt(2 g size)), count (grains, capped per
//    preset), palette (the material the colour comes from: desert-sand), tint, duration (s), mode (builder/vfx/trigger.js:
//    `trigger` waits for fire(), `loop` replays every `period` s at the piece), period.
//  - The fire contract (docs/fx/sand.md), the kit contract of builder/vfx/trigger.js widened with a place and a strength:
//      sceneView.effect('sand-burst@1.0.0')?.fire(uid, { at, pos, strength }) -> boolean
//    `at`: a time on the TSL clock (s; omitted: now), or a world point [x, y, z] (read as `pos`); `pos`: the world point to
//    burst at (omitted: the piece's own place); `strength` 0..1 (default 1) scales the grains thrown and their speed (a
//    physics contact's impulse). False when uid is not a burst piece, the piece loops, or there is no compute (path none).
//    A fire is a moment, not a scene patch: it never enters the document or the undo history.
//  - The tap: in Play mode a tap on the scene fires the nearest trigger burst at the tapped ground (builder/fx-tap.js).
//
// The trail (`carry`), used by the `trail` behaviour (lib/behaviours/trail.mjs; behaviours/trail/behaviour.json): sand
// streamed from a point on each carrier (local metres at its default size). One trail effect for every carrier of the scene
// (one pool: Phone 1,024, High 4,096; one pass; one draw). Each frame the emitter's world point is read from the piece's
// anchor (sceneView.objectOf(uid)): an editor move (a sync) and an animation (a walk or a physics body moving the anchor)
// are both followed. It emits an idle trickle (40 grains/s; Phone half) plus 120 per m/s of speed (to 10 m/s), times the
// behaviour's rate, born along the segment the point moved over that frame (a jump is cut to a 3 m streak), drifting up.
// The bursts on hit (`onHit`), used by the `burst_on_hit` behaviour (lib/behaviours/burst_on_hit.mjs): the same burst on its
// own pool (Phone 1,024, High 4,096), fired at a contact point.
// WebGL (?webgl): the same pass runs as transform feedback (r187 WebGLBackend.compute) with half the pool: "reduced" (the
// page says so once). With no compute at all (a renderer without compute()), nothing is drawn and fire() says false.
// Contract: build(params, ctx) -> { object, collider, features, effect: { create({ renderer, camera, ground }) } };
// carry(ctx) and onHit(ctx) -> { create({ renderer, camera, ground }) } (lib/behaviours/).
import { createTriggers, MODES } from './trigger.js';
import { createPool, fxPath, capFor, grainSize, G } from './sand-particles.js';

export const MODULE = 'builder/vfx/sand-burst.js';
export const REF = 'sand-burst@1.0.0';
export const TRAIL = Object.freeze({ idle: 40, perSpeed: 120, maxSpeed: 10, streak: 3, speed: 1, life: 1.6, size: 0.08, radius: 0.35 });

/** Grains one burst throws on a preset and path: the param, capped at half the pool. */
export function burstCount(params, preset, path, strength = 1, poolCap = capFor(preset, 'burst', path)) {
  const cap = poolCap, s = Math.min(1, Math.max(0.05, Number.isFinite(strength) ? strength : 1));
  const want = Math.round(Math.max(1, +params.count || 0) * (path === 'webgl-transform-feedback' ? 0.5 : 1) * s);
  return Math.min(Math.floor(cap / 2), want);
}

function pieceRow(THREE, it) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  if (it.matrix) it.matrix.decompose(p, q, s); else s.set(1, 1, 1);
  return { place: [p.x, p.y, p.z], scale: s.x };
}

/** The hit volume of a burst piece for picking: an invisible disc the size of its footprint, never drawn. */
function pickDisc(THREE, radius) {
  const n = 16, v = [0, 0.05, 0], idx = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; v.push(Math.cos(a) * radius, 0.05, Math.sin(a) * radius); }
  for (let i = 0; i < n; i++) idx.push(0, 1 + ((i + 1) % n), 1 + i);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

/** Every sand burst of the scene: one pool, one pass, one draw. */
function createBursts(ctx, { renderer = null, ground = null, kind = 'burst' } = {}) {
  const { THREE } = ctx;
  const path = fxPath({ isWebGPU: ctx.isWebGPU, renderer });
  const cap = capFor(ctx.preset, kind, path);
  const object = new THREE.Group(); object.name = kind === 'hit' ? 'sand bursts on hit' : 'sand bursts'; object.userData.vfx = { module: MODULE, path };
  const pool = cap ? createPool(ctx, { cap, renderer, ground, name: kind === 'hit' ? 'sand burst on hit' : 'sand burst' }) : null;
  if (pool) object.add(pool.sprite);
  const pick = kind === 'hit' ? null :  new THREE.InstancedMesh(pickDisc(THREE, 1.5), new THREE.MeshBasicNodeMaterial(), 64);
  if (pick) { pick.visible = false; pick.count = 0; pick.name = 'sand burst pick'; pick.userData = { pick: true, uids: [], vfx: { module: MODULE, part: 'pick (not drawn)' } }; object.add(pick); }
  let table = createTriggers(1), list = [], rows = new Map(), queue = [], loopK = new Map();
  const throwAt = (it, { pos, birth, strength = 1 }) => {
    const r = rows.get(it.uid), size = Math.max(0.2, +it.params.size || 3) * r.scale;
    const s = Math.min(1, Math.max(0.05, strength));
    return pool.spawn({ origin: pos || r.place, birth, count: burstCount(it.params, ctx.preset, path, s, cap), tint: it.params.tint || '#ffffff', speed: Math.sqrt(2 * G * size) * (0.6 + 0.4 * s),
      life: Math.max(0.3, +it.params.duration || 2.5), size: grainSize(ctx.preset, size), ground: (pos || r.place)[1], radius: size * 0.12 });
  };
  const centreOf = (pos, it) => (pos || rows.get(it.uid).place);
  const handle = {
    object, layer: 'fx', path, pool, ground,
    get capacity() { return cap; },
    set(pieces) {
      list = pieces.slice();
      if (list.length > table.capacity) table = createTriggers(2 ** Math.ceil(Math.log2(list.length)));
      table.set(list.map((it) => ({ uid: it.uid, params: { mode: MODES.includes(it.params?.mode) ? it.params.mode : 'trigger' } })));
      rows = new Map(list.map((it) => [it.uid, pieceRow(THREE, it)]));
      if (pick) { // the first 64 burst pieces are pickable
        const m4 = new THREE.Matrix4();
        pick.count = Math.min(64, list.length);
        for (let i = 0; i < pick.count; i++) pick.setMatrixAt(i, m4.copy(list[i].matrix || m4.identity()));
        pick.userData.uids = list.slice(0, pick.count).map((it) => it.uid); pick.instanceMatrix.needsUpdate = true; pick.boundingSphere = null;
      }
      if (pool && list[0]) pool.setPalette(list[0].params.palette || 'desert-sand');
      object.visible = list.length > 0;
    },
    /** The fire contract (docs/fx/sand.md). */
    fire(uid, { at, pos, strength = 1 } = {}) {
      if (!pool) return false;
      const it = list.find((x) => x.uid === uid);
      if (!it || (it.params?.mode ?? 'trigger') === 'loop') return false;
      if (Array.isArray(at) && at.length === 3 && at.every(Number.isFinite)) { pos = pos || at; at = undefined; }
      const p = Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite) ? [...pos] : null;
      const birth = Number.isFinite(at) ? at : pool.now;
      ground?.update?.([centreOf(p, it)[0], centreOf(p, it)[2]]);
      const row = throwAt(it, { pos: p, birth, strength }); // the pass waits for a row's birth on the TSL clock
      if (row && birth > pool.now + 1e-3) queue.push({ uid, pos: p, birth, strength, row }); // re-written if its row is reused first
      return !!row;
    },
    triggers: () => list.filter((it) => (it.params?.mode ?? 'trigger') !== 'loop').map((it) => it.uid),
    /** Before each render: due fires, loop pieces, then the pass. */
    frame() {
      if (!pool) return;
      const t = pool.now;
      if (queue.length) {
        const due = queue.filter((q) => q.birth <= t + 1e-3); queue = queue.filter((q) => q.birth > t + 1e-3);
        for (const q of due) { const it = list.find((x) => x.uid === q.uid); if (it && !pool.intact(q.row)) throwAt(it, q); }
      }
      for (const it of list) if (it.params?.mode === 'loop') {
        const period = Math.max(0.5, +it.params.period || 4), k = Math.floor(t / period);
        if (loopK.get(it.uid) !== k) { loopK.set(it.uid, k); const r = rows.get(it.uid); ground?.update?.([r.place[0], r.place[2]]); throwAt(it, { birth: t }); }
      }
      pool.frame();
    },
    dispose() { pool?.dispose(); if (pick) { pick.geometry.dispose(); pick.material.dispose(); pick.dispose?.(); } object.removeFromParent(); },
  };
  return handle;
}

/** The trail of every carrier of the scene: one pool, one pass, one draw. */
function createTrails(ctx, { renderer = null, ground = null } = {}) {
  const { THREE } = ctx;
  const path = fxPath({ isWebGPU: ctx.isWebGPU, renderer });
  const cap = capFor(ctx.preset, 'trail', path);
  const object = new THREE.Group(); object.name = 'sand trails'; object.userData.vfx = { module: MODULE, part: 'trail', path };
  const pool = cap ? createPool(ctx, { cap, renderer, ground, name: 'sand trail' }) : null;
  if (pool) object.add(pool.sprite);
  const k = ctx.preset === 'phone' ? 0.5 : 1;
  let carriers = [], state = new Map(), lastT = null, rr = 0;
  const v = new THREE.Vector3(), wall = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);
  const pointOf = (c) => {
    const o = c.object, at = c.at || [0, 0, 0], s = c.scale || 1;
    v.set(at[0] * s, at[1] * s, at[2] * s);
    if (o?.matrixWorld) v.applyMatrix4(o.matrixWorld); else if (c.matrix) v.applyMatrix4(c.matrix);
    return [v.x, v.y, v.z];
  };
  const handle = {
    object, layer: 'fx', path, pool, ground,
    get capacity() { return cap; },
    /** Every carrier: [{ uid, object (its anchor, read each frame), matrix (if no anchor), at, radius, scale, rate, tint, size }]. */
    set(list) {
      carriers = list.slice();
      const keep = state; state = new Map();
      for (const c of carriers) state.set(c.uid, keep.get(c.uid) || { p: null, speed: 0, acc: 0 });
      object.visible = carriers.length > 0;
    },
    emitters: () => carriers.map((c) => ({ uid: c.uid, position: [...(state.get(c.uid)?.p || pointOf(c))], speed: state.get(c.uid)?.speed || 0 })),
    frame(dt) {
      const now = wall(), step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : lastT === null ? 1 / 60 : Math.min(0.1, Math.max(1e-3, now - lastT));
      lastT = now;
      const t = pool ? pool.now : 0;
      // at most SLOTS / 2 carriers spawn per frame (the rest wait their turn, round robin); every carrier is tracked
      const n = carriers.length, budget = 16;
      carriers.forEach((c, i) => {
        const st = state.get(c.uid), p = pointOf(c);
        const prev = st.p || p;
        const d = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
        st.speed = d / step;
        const from = d > TRAIL.streak ? p.map((x, j) => x + (prev[j] - x) * (TRAIL.streak / d)) : prev;
        st.acc += (TRAIL.idle + TRAIL.perSpeed * Math.min(TRAIL.maxSpeed, st.speed)) * k * step * Math.max(0, c.rate ?? 1);
        const turn = n <= budget || ((i - rr + n) % n) < budget;
        if (pool && turn && st.acc >= 1) {
          const count = Math.floor(st.acc); st.acc -= count;
          pool.spawn({ origin: p, prev: from, birth: t, count, speed: TRAIL.speed, life: TRAIL.life, size: TRAIL.size * (ctx.preset === 'phone' ? 1.4 : 1) * (c.size ?? 1),
            ground: p[1] - (c.at?.[1] || 0) * (c.scale || 1), radius: (c.radius ?? TRAIL.radius) * (c.scale || 1), tint: c.tint || '#ffffff' });
          ground?.update?.([p[0], p[2]]);
        }
        st.p = p;
      });
      if (n > budget) rr = (rr + budget) % n;
      pool?.frame();
    },
    dispose() { pool?.dispose(); object.removeFromParent(); },
  };
  return handle;
}

export function build(params, ctx) {
  const { THREE } = ctx;
  const object = new THREE.Group(); object.name = 'sand burst'; // an effect has no prop: the bursts draw it
  return {
    object,
    collider: [{ type: 'cylinder', pos: [0, 0.5, 0], radius: 1.5, halfHeight: 0.5, sensor: true }],
    features: { sandFx: ctx.isWebGPU ? 'webgpu-compute' : 'webgl-transform-feedback' },
    effect: { create: (opts = {}) => createBursts(ctx, opts) },
  };
}

/** The trail every `trail` behaviour streams (lib/behaviours/trail.mjs): one pool for all of them. */
export function carry(ctx) {
  return { create: (opts = {}) => createTrails(ctx, opts) };
}

/** The bursts every `burst_on_hit` behaviour throws (lib/behaviours/burst_on_hit.mjs): one pool for all of them. */
export function onHit(ctx) {
  return { create: (opts = {}) => createBursts(ctx, { ...opts, kind: 'hit' }) };
}
