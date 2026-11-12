// burst_on_hit.mjs: the `burst_on_hit` behaviour (behaviours/burst_on_hit/behaviour.json; targets character, piece,
// animal): a burst of sand thrown at the point where the piece is hit. The burst is the sand-burst effect
// (builder/vfx/sand-burst.js onHit(): r187 webgpu_compute_particles, GPU compute particles stopped on the ground drawn from
// above as webgpu_compute_particles_snow); every piece with it shares ONE pool and ONE draw (lib/behaviours/sand-shared.mjs),
// apart from the placed burst pieces' pool.
// Callers: physics contacts (the WALK branch's Rapier), Combo and Hit-reaction, through the handle:
//   behaviours.get(uid, 'burst_on_hit')?.handle.onHit({ point: [x, y, z], impulse })  -> true when sand was thrown
// and a tap on the piece in Play mode (behaviours.tap(uid, hit): a full burst). An impulse under minImpulse throws nothing;
// at fullImpulse and over, a full burst; between, strength impulse / fullImpulse (at least 0.05).
import { sharedPool } from './sand-shared.mjs';

/** Pure: the strength (0..1) of a hit, or 0 when it is too light. A hit with no impulse is a full burst. */
export function strengthOf(impulse, { minImpulse, fullImpulse }) {
  if (impulse === undefined || impulse === null) return 1;
  if (!(impulse >= minImpulse)) return 0;
  return Math.min(1, Math.max(0.05, impulse / Math.max(1e-6, fullImpulse)));
}

export function attach(ctx, item, params) {
  const pool = sharedPool(ctx, 'hit');
  let p = params;
  const anchor = () => ctx.view.objectOf?.(item.uid) || null;
  const piece = () => ({ uid: item.uid, matrix: anchor()?.matrixWorld || null, params: { size: p.size, count: p.count, duration: p.duration, tint: p.colour, mode: 'trigger' } });
  pool.put(item.uid, piece());
  const at = () => { const e = anchor()?.matrixWorld?.elements; return e ? [e[12], e[13], e[14]] : (item.transform?.p || [0, 0, 0]); };
  const onHit = ({ point, impulse } = {}) => {
    const s = strengthOf(impulse, p);
    if (!s) return false;
    return pool.handle.fire(item.uid, { pos: Array.isArray(point) && point.length === 3 ? point : at(), strength: s });
  };
  return {
    get pool() { return pool.handle; },
    onHit,
    onTap: (hit) => onHit({ point: hit ? [hit.x, hit.y, hit.z] : undefined }),
    onParams(np) { p = np; pool.put(item.uid, piece()); },
    dispose() { pool.drop(item.uid); },
  };
}
