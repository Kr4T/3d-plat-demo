// sand-shared.mjs: the GPU pools the sand behaviours share, one per scene view (fx-sand's own helper, not the behaviour
// core): every `trail` draws in one pool and one draw, every `burst_on_hit` in another. An effect module's create() needs
// THREE, TSL, the preset, the backend and the stage's environment uniforms (fxContext); the pool lives in the stage's
// effects layer and frames itself on stage.onFrame until its last user goes.
import * as TSL from 'three/tsl';
import { carry, onHit } from '../../builder/vfx/sand-burst.js';

const pools = new WeakMap(); // scene view -> Map(kind -> pool)
export const fxContext = (stage) => ({ THREE: stage.THREE, TSL, preset: stage.preset === 'phone' ? 'phone' : 'high', isWebGPU: !!stage.isWebGPU, environment: stage.scene?.userData?.environment?.uniforms || null });
/** The sand pools of a scene view (fx-tap.js reads their path for the page's notice). */
export const sandPools = (view) => [...(pools.get(view)?.values() || [])];

/** The shared pool `kind` ('trail' | 'hit') of ctx.view, made on first use: { handle, put(uid, entry), drop(uid) }. */
export function sharedPool(ctx, kind) {
  const { view, stage } = ctx;
  if (!pools.has(view)) pools.set(view, new Map());
  const map = pools.get(view);
  if (map.has(kind)) return map.get(kind);
  const maker = kind === 'trail' ? carry : onHit;
  const handle = maker(fxContext(stage)).create({ renderer: stage.renderer || null, camera: stage.camera, ground: view.groundFor?.(`sand-${kind}`) || view.ground || null });
  (handle.layer === 'fx' && stage.fxScene ? stage.fxScene : view.root).add(handle.object);
  const entries = new Map();
  const off = stage.onFrame ? stage.onFrame((dt) => { refresh?.(); handle.frame(dt); }) : null;
  let refresh = null;
  const pool = {
    handle, entries,
    /** Called before each frame: entries whose anchor appeared since (a piece added before the view drew it). */
    set onFrame(fn) { refresh = fn; },
    put(uid, e) { entries.set(uid, e); handle.set([...entries.values()]); },
    drop(uid) {
      entries.delete(uid); handle.set([...entries.values()]);
      if (!entries.size && !pool.pinned) { off?.(); handle.dispose(); map.delete(kind); } // a prewarmed pool (prewarmPool) stays, empty and hidden
    },
  };
  map.set(kind, pool);
  return pool;
}

/**
 * A sand burst at a world point with no behaviour and no piece (a kill burst, an impact): ctx.fx.sandBurst(point, opts) on
 * the page (builder/main.js). `point`: [x, y, z] or { x, y, z }; opts: { strength 0..1 (1), size m thrown (3), count grains
 * (1500, capped per device), duration s (2.5), colour tint ('#ffffff') }. It draws in the pool the burst_on_hit behaviours
 * share (made on the first call, kept for the view's life): no new pool, no new draw per burst. False when the point is not
 * a point or there is no compute (path none).
 */
const FX_UID = '@fx';
export function sandBurst(ctx, point, { strength = 1, size = 3, count = 1500, duration = 2.5, colour = '#ffffff' } = {}) {
  const p = Array.isArray(point) ? point : point && typeof point === 'object' ? [point.x, point.y, point.z] : null;
  if (!p || p.length !== 3 || !p.every(Number.isFinite)) return false;
  const pool = sharedPool(ctx, 'hit');
  pool.put(FX_UID, { uid: FX_UID, matrix: null, params: { size, count, duration, tint: colour, mode: 'trigger' } });
  return pool.handle.fire(FX_UID, { pos: p, strength });
}

/**
 * The pool `kind` made and compiled ahead of the first piece that streams into it (builder/prewarm.js: a djinn's `trail`), and
 * kept when its last user goes: its sprite's draw for the effects pass and its compute pass are built here, between frames,
 * instead of in the frame that first draws the piece (A4000, a djinn's first drop: 3 programs, a render and a compute pipeline).
 * r187 Renderer.compileAsync for the sprite (stage.precompile), compileComputeAsync for the pass (stage.precompileCompute).
 */
export async function prewarmPool(ctx, kind) {
  const { stage } = ctx;
  const pool = sharedPool(ctx, kind);
  pool.pinned = true;
  const h = pool.handle, step = h.pool?.step;
  if (!step || typeof stage.precompile !== 'function') return { kind, ok: false, reason: 'no compute pool on this device' };
  let vis = false;
  await stage.precompile(h.object, { layer: h.layer === 'fx' && stage.fxScene ? 'fx' : 'scene', before() { vis = h.object.visible; h.object.visible = true; }, after() { h.object.visible = vis; } });
  await stage.precompileCompute([step]);
  return { kind, ok: true };
}
