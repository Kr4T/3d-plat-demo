// hit_reaction.mjs: the `hit_reaction` behaviour (behaviours/hit_reaction/behaviour.json). When a combo hit lands on the item
// (lib/combat/world.mjs land -> react):
//   knock-back  a Rapier impulse: the item gets a dynamic body of its own in the walk's world (a capsule like its hurtbox,
//               rotations locked, damped), the impulse pushes it away from the attacker at `knockback` m/s, and the world is
//               stepped while it slides; the item follows the body (view.place). The item's own level collider would hold
//               the body in place, so contact pairs between the body and the colliders it starts inside are filtered out
//               (Rapier physics hooks, filterContactPair). The walk itself never steps the world (its character controller
//               needs no step), so only these bodies move.
//   flinch      `stagger` seconds of the hit-react pose (lib/combat/moves.mjs REACTIONS.hit) on a rigged character shown as
//               an actor; a static piece just slides
// An active ragdoll is not built (time).
import { combatWorld } from '../combat/world.mjs';
import { hurtboxOf } from './health.mjs';
import { REACTIONS, poseAt, toRigPose } from '../combat/moves.mjs';

export function attach(ctx, item, params = {}) {
  const w = combatWorld(ctx);
  const def = ctx.registry?.get?.(item.component) || null;
  let p = { ...params }, body = null, bodyWorld = null, own = new Set(), flinch = null, rest = 0, hooks = null;
  function makeBody(world, R) {
    const at = w.positionOf(item.uid), { radius, height } = hurtboxOf(def, ctx.find?.(item.uid) || item);
    const half = Math.max(0.01, height / 2 - radius), lift = 0.03;
    // what the body starts inside (the item's own level colliders) never pushes it
    own = new Set();
    world.intersectionsWithShape({ x: at[0], y: at[1] + height / 2 + lift, z: at[2] }, { x: 0, y: 0, z: 0, w: 1 }, new R.Capsule(half * 0.9, radius * 0.9), (c) => { own.add(c.handle); return true; });
    body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at[0], at[1] + height / 2 + lift, at[2]).lockRotations().setLinearDamping(3.5).setCcdEnabled(true));
    const cd = R.ColliderDesc.capsule(half, radius).setFriction(0.4).setDensity(1);
    if (R.ActiveHooks) cd.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
    const col = world.createCollider(cd, body);
    body.userData = { half: height / 2 + lift, collider: col.handle };
    bodyWorld = world;
    hooks = {
      filterContactPair: (c1, c2) => ((c1 === col.handle && own.has(c2)) || (c2 === col.handle && own.has(c1)) ? null : (R.SolverFlags?.COMPUTE_IMPULSES ?? 1)),
      filterIntersectionPair: () => true,
    };
  }
  function dropBody() { if (body && bodyWorld) { try { bodyWorld.removeRigidBody(body); } catch { /* the world went */ } } body = null; bodyWorld = null; }
  const off = w.register(item.uid, 'reaction', {
    react({ dir }) {
      const world = ctx.physics?.world, R = ctx.physics?.rapier;
      if (p.knockback > 0 && world && R) {
        if (!body || bodyWorld !== world) { dropBody(); makeBody(world, R); }
        else { const at = w.positionOf(item.uid); body.setTranslation({ x: at[0], y: at[1] + body.userData.half, z: at[2] }, true); } // from where the item is now (it may have walked since the last push)
        const m = body.mass();
        body.applyImpulse({ x: dir[0] * p.knockback * m, y: 0.15 * p.knockback * m, z: dir[2] * p.knockback * m }, true);
        rest = 0;
      }
      if (p.stagger > 0) flinch = { t: 0 };
    },
  });
  const handle = {
    uid: item.uid,
    body: () => body,
    /** One physics step of the knock-back bodies (exposed for tests). */
    step(dt) {
      if (!body || !bodyWorld) return;
      bodyWorld.timestep = dt; bodyWorld.step(undefined, hooks);
      const t = body.translation();
      ctx.view?.place?.(item.uid, [t.x, t.y - body.userData.half, t.z], w.yawOf(item.uid));
      const v = body.linvel(); rest = Math.hypot(v.x, v.y, v.z) < 0.05 ? rest + dt : 0;
    },
    update(dt) {
      if (!w.playing()) { dropBody(); flinch = null; return; }
      if (body && bodyWorld !== ctx.physics?.world) dropBody();
      // the physics keeps the game's time on slow frames: up to 0.1 s a frame in steps of at most 1 / 30 s
      if (body) { for (let left = Math.min(dt, 0.1); left > 1e-6 && body; left -= 1 / 30) handle.step(Math.min(left, 1 / 30)); if (rest > 0.3) dropBody(); } // settled: the item is free again (something else may move it: the waves' enemies walk)
      if (flinch) {
        flinch.t += dt * w.timeScale();
        const u = flinch.t / Math.max(0.05, p.stagger);
        w.actors().then((a) => { const actor = a?.get(item.uid); if (actor && a.shown(item.uid)) actor.pose(toRigPose(poseAt(REACTIONS.hit, Math.min(1, u)))); });
        if (u >= 1) flinch = null;
      }
    },
    flinching: () => !!flinch,
    /** Forget the push in flight (the item was put somewhere else: a waves enemy sent out again). */
    reset() { dropBody(); flinch = null; rest = 0; },
    onParams(next) { p = { ...next }; },
    dispose() { off(); dropBody(); },
  };
  return handle;
}
