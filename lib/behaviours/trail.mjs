// trail.mjs: the `trail` behaviour (behaviours/trail/behaviour.json; targets character, piece, animal): sand streaming from
// the base of whatever carries it. The work is builder/vfx/sand-burst.js carry() on builder/vfx/sand-particles.js (r187
// webgpu_compute_particles: GPU compute particles, one Sprite): every piece with a trail shares ONE pool, ONE compute pass
// and ONE draw (lib/behaviours/sand-shared.mjs). The emitter point is read each frame from the piece's anchor
// (ctx.view.objectOf(uid)), so a move in the editor (a sync) and an animation (a walk, a physics body moving the anchor) are
// both followed with no call from them. Params: rate (x the grains per second: 40 at rest plus 120 per m/s of speed, half
// on the phone), colour (a tint on the sand palette, per piece), size (x the grain size). The point is 25 cm above the
// piece's origin (its base: pieces stand on their origin), times its size params' scale (ctx.view.scaleOf).
// Contract (lib/behaviours/index.mjs, the shared core): attach(ctx, item, params) -> { onParams, dispose, emitter }.
import { sharedPool } from './sand-shared.mjs';

export function attach(ctx, item, params) {
  const pool = sharedPool(ctx, 'trail');
  let p = params;
  const anchor = () => ctx.view.objectOf?.(item.uid) || null;
  const entry = () => ({ uid: item.uid, object: anchor(), matrix: null, scale: ctx.view.scaleOf?.(item.uid) ?? 1, at: [0, 0.25, 0], radius: 0.35, rate: p.rate, tint: p.colour, size: p.size });
  pool.put(item.uid, entry());
  // a piece added in the same edit is drawn after the behaviours sync: pick its anchor (and size) up once it exists
  pool.onFrame = () => { for (const [uid, e] of pool.entries) { const o = ctx.view.objectOf?.(uid) || null, s = ctx.view.scaleOf?.(uid) ?? 1; if (o !== e.object || s !== e.scale) pool.put(uid, { ...e, object: o, scale: s }); } };
  return {
    get pool() { return pool.handle; },
    emitter: () => pool.handle.emitters().find((e) => e.uid === item.uid) || null,
    onParams(np) { p = np; pool.put(item.uid, entry()); },
    dispose() { pool.drop(item.uid); },
  };
}
