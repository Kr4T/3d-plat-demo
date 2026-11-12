// hits.mjs: the hit sweep of combo_attack, on the walk's Rapier world (ctx.physics.world / ctx.physics.rapier). Items that
// carry `health` get a hurtbox: a sensor capsule (radius, height from the item) of their own, not part of the level, so it
// blocks nobody and the walk's level rebuilds leave it alone. During a hit window, every frame the weapon's segment (the
// blade from the grip to the tip, lib/combat/grip.mjs) or, with no weapon drawn, the reach segment (reachSegment) is swept as
// a capsule: world.intersectionsWithShape (r187-era Rapier 0.21 API, as the web-game-kit and physics_rapier examples use the
// world queries). Each target is hit once per window id; the attacker is excluded.
//   const hits = createHits({ world, rapier });  hits.add(uid, { p, radius, height });  hits.move(uid, p);
//   hits.sweep({ a, b, radius, window, exclude }) -> [{ uid, point }]   (new hits only)
export const CHEST = 0.6; // the reach segment starts at 0.6 x the height (the chest)

/** The reach segment of an attacker { p, yaw, height } facing +z rotated by yaw (three's rotation.y): from the chest, 0.25 m
 * in front, to `reach` metres past an arm of 0.35 x height. */
export function reachSegment({ p, yaw = 0, height = 1.8 }, reach = 1) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), y = p[1] + height * CHEST, s0 = 0.25, s1 = 0.35 * height + reach;
  return { a: [p[0] + fx * s0, y, p[2] + fz * s0], b: [p[0] + fx * s1, y, p[2] + fz * s1] };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The rotation taking +y to `d` (a capsule's axis), as a quaternion { x, y, z, w }. */
function quatYTo(d) {
  const l = Math.hypot(...d) || 1, v = d.map((x) => x / l), c = v[1]; // dot(+y, v)
  if (c > 0.999999) return { x: 0, y: 0, z: 0, w: 1 };
  if (c < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const ax = [v[2], 0, -v[0]], s = Math.sqrt((1 + c) * 2); // +y x v
  return { x: ax[0] / s, y: ax[1] / s, z: ax[2] / s, w: s / 2 };
}

export function createHits({ world, rapier: R }) {
  const boxes = new Map(); // uid -> { collider, radius, height, p }
  const owner = new Map(); // collider handle -> uid
  const done = new Map(); // window id -> Set(uid)
  let dirty = false; // a hurtbox was added or moved: Rapier's scene queries see it after a world step (as the walk's addShape)
  const api = {
    add(uid, { p = [0, 0, 0], radius = 0.35, height = 1.8 } = {}) {
      api.remove(uid);
      const half = Math.max(0.01, height / 2 - radius);
      const d = R.ColliderDesc.capsule(half, radius).setSensor(true).setTranslation(p[0], p[1] + height / 2, p[2]);
      if (R.ActiveCollisionTypes) d.setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.FIXED_FIXED);
      const collider = world.createCollider(d);
      boxes.set(uid, { collider, radius, height, p: [...p] }); owner.set(collider.handle, uid); dirty = true;
      return collider;
    },
    move(uid, p) { const b = boxes.get(uid); if (!b) return false; if (Math.hypot(p[0] - b.p[0], p[1] - b.p[1], p[2] - b.p[2]) < 1e-3) return true; b.p = [...p]; b.collider.setTranslation({ x: p[0], y: p[1] + b.height / 2, z: p[2] }); dirty = true; return true; },
    remove(uid) { const b = boxes.get(uid); if (!b) return false; owner.delete(b.collider.handle); world.removeCollider(b.collider, false); boxes.delete(uid); return true; },
    list: () => [...boxes.keys()],
    has: (uid) => boxes.has(uid),
    /** New hits of this window along segment a -> b (a capsule of `radius`). */
    sweep({ a, b, radius = 0.1, window = 0, exclude = null }) {
      if (dirty) { world.step(); dirty = false; }
      const d = sub(b, a), len = Math.hypot(...d);
      const mid = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2 };
      const shape = new R.Capsule(Math.max(0.005, len / 2), radius);
      if (!done.has(window)) { done.set(window, new Set()); if (done.size > 32) done.delete(done.keys().next().value); }
      const seen = done.get(window), out = [];
      world.intersectionsWithShape(mid, quatYTo(d), shape, (col) => {
        const uid = owner.get(col.handle);
        if (uid === undefined || uid === exclude || seen.has(uid)) return true;
        seen.add(uid);
        const t = col.translation(), c = [t.x, t.y, t.z], k = Math.max(0, Math.min(1, len ? dot(sub(c, a), d) / (len * len) : 0));
        out.push({ uid, point: [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k] });
        return true;
      });
      return out;
    },
    dispose() { for (const uid of [...boxes.keys()]) api.remove(uid); done.clear(); },
  };
  return api;
}
