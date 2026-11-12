// fountain.js: the fountain component's module (effect). r187 example: webgpu_compute_particles (positions and velocities in
// instancedArray storage, an init and an update compute pass, a SpriteNodeMaterial reading the positions with
// toAttribute(), renderer.compute each frame). The show is Boulevard City's own (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/main.js 1401-1445 `spray`, stepped by main.js 1578): 4,000 drops from a ring of jets and a centre
// jet, in four set pieces of 8 s (arcs, tall centre, rotating wave, wide fans), lit in its own colours at night; eight fire
// columns round the ring every 24 s, then smoke drifting up. The node code below is Boulevard's, line for line, with:
//   - every fountain of the scene in one show (Task 9 review): one compute pass over all their drops and two draws, whatever
//     the number of fountains (spec §5.3: one draw per component per LOD). Fountain f owns drops f x 4,000 .. f x 4,000 +
//     3,999, and each drop hashes its index within its own fountain, so fountain 0 is Boulevard's show exactly. Each
//     fountain's place (x, y, z, yaw, size) and params are a row of three uniform arrays; the drops move in the fountain's
//     own frame (Boulevard: fi, fj in the city) and are placed by its row;
//   - four params (`affects: "effect"`, so they never split the basin's instancing), each Boulevard's value by default:
//     `jetHeight` (the tall centre jet's height: its 22 m/s gives 22^2 / (2 x 9.81) = 24.67 m; every jet's upward speed
//     scales by sqrt(jetHeight / 24.67), and its outward speed by the inverse, so the drops still land in the basin),
//     `colour` (a tint on the lit jets: white is Boulevard's show), `show` (the set piece it starts on, 0 to 3), `timing`
//     (seconds per set piece; the fire cycle (3 x) and the colour swap (2 x) keep Boulevard's ratio to it);
//   - spray and smoke in one draw (one SpriteNodeMaterial, the smoke's nodes on the instances after every spray drop), so
//     the piece fits the High budget of 4 draws per LOD with the basin's two. Both blend normally with no depth write, the
//     spray first, as Boulevard draws the spray before the smoke; the additive fire is drawn after them (Boulevard drew it
//     between: the two only overlap while the fire burns out and the smoke starts, 1.2-1.68 s of each 24 s). Boulevard's
//     smoke material has fog off and its spray fog on; the effects layer (stage fxScene) has no fog, so neither applies;
//   - Boulevard's near test (main.js 1578: shown and stepped only within 160 m of the camera) per fountain: a far
//     fountain's drops are not stepped and its sprites are drawn at size 0.
// High and WebGPU only, as Boulevard (main.js 1403: `preset !== 'high' || !IS_GPU` -> no spray): features().spray. The
// stone basin, its water and its jet lights draw on every preset (builder/sculpt/basin.js), instanced as any piece.
// Contract: build(params, ctx) -> { object, lights, collider, features, effect: { create({ renderer, camera }) } }
// (lib/runtime/scene-view.mjs): one show per component; set([{ uid, matrix, params }]) gives it every fountain, frame()
// runs its compute pass before each render.
import { Fn, If, instancedArray, instanceIndex, hash, floor, time, deltaTime, select, float, int, uint, sin, vec3, vec4, mix, fract,
  smoothstep, uv, cameraPosition, uniform, uniformArray } from 'three/tsl';
import { basin, jetLights, collider } from '../sculpt/basin.js';

export const MODULE = 'builder/vfx/fountain.js';
export const TALL_JET = 24.67; // m: Boulevard's tall centre jet, 22 m/s up (22^2 / (2 x 9.81))
export const N = 4000, FN = 8 * 70, SN = 8 * 24; // main.js: drops, fire sprites (8 columns x 70), smoke sprites (8 x 24)
const NEAR = 160; // m: main.js spray.near()

/** Whether the spray runs on this preset and backend: High and WebGPU only, as Boulevard. */
export function features({ preset, isWebGPU }) {
  return { spray: preset === 'high' && !!isWebGPU };
}

/** One fountain's row of the show's uniform arrays: place [x, y, z, yaw], show [K, T, S, size], tint [r, g, b, near]. */
export function showRow(THREE, { matrix = null, params }) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  if (matrix) matrix.decompose(p, q, s);
  const yaw = matrix ? new THREE.Euler().setFromQuaternion(q, 'YXZ').y : 0, c = new THREE.Color(params.colour);
  return { place: [p.x, p.y, p.z, yaw], show: [Math.sqrt(params.jetHeight / TALL_JET), params.timing, Math.round(params.show) % 4, matrix ? s.x : 1], tint: [c.r, c.g, c.b, 1] };
}

/** The show for `C` fountains (Boulevard main.js 1402-1445, per fountain row). */
function makeShow(ctx, C) {
  const { THREE } = ctx;
  const uNight = ctx.environment?.night || uniform(1); // the stage's night term (Boulevard uNight); none: night
  const rows = (v) => Array.from({ length: C }, () => new THREE.Vector4(...v));
  const PLACE = uniformArray(rows([0, 0, 0, 0]), 'vec4'), SHOW = uniformArray(rows([1, 8, 0, 1]), 'vec4'), TINT = uniformArray(rows([1, 1, 1, 0]), 'vec4');
  const CN = C * N, cx = 0, cz = 0, pos = instancedArray(C * (N + SN), 'vec3'), vel = instancedArray(CN, 'vec3');
  // in the fountain's frame -> world: its yaw, size and place
  const place = (f, p) => { const a = PLACE.element(f), k = SHOW.element(f).w, c = a.w.cos(), s = a.w.sin(), q = p.mul(k);
    return vec3(q.x.mul(c).add(q.z.mul(s)), q.y, q.z.mul(c).sub(q.x.mul(s))).add(a.xyz); };
  const reset = (p, v, i, f) => { // a ring of jets 6 m across, 9-13 m high
    const P = SHOW.element(f), K = P.x, T = P.y, S = P.z;
    // the musical fountain's show: four set pieces, T s each (arcs, tall centre, rotating wave, wide fans)
    const mode = floor(time.div(T)).add(S).mod(4), a = hash(i).mul(6.2832), jet = hash(i.add(17)).lessThan(select(mode.equal(1), float(0.55), float(0.25)));
    const wave = sin(a.mul(3).add(time.mul(2.2))).mul(0.5).add(0.5);
    const ringUp = select(mode.equal(2), wave.mul(9).add(3), select(mode.equal(3), float(5.5), select(mode.equal(1), float(4.5), float(7.5)))).add(hash(i.add(3)).mul(1.5));
    const r = select(jet, float(0.15), float(2.6).add(hash(i.add(7)).mul(0.3))), up = select(jet, select(mode.equal(1), float(22), float(15)).add(hash(i.add(3)).mul(2)), ringUp).mul(K);
    const out = select(jet, hash(i.add(19)).mul(0.5), select(mode.equal(3), float(3.4), float(1.6)).add(hash(i.add(19)).mul(0.6))).div(K);
    p.assign(vec3(a.cos().mul(r).add(cx), 0.6, a.sin().mul(r).add(cz)));
    v.assign(vec3(a.cos().mul(out), up, a.sin().mul(out)));
  };
  const fOf = instanceIndex.div(uint(N)), li = instanceIndex.mod(uint(N)); // the drop's fountain and its index within it
  const init = Fn(() => { const p = pos.element(instanceIndex), v = vel.element(instanceIndex); reset(p, v, li, fOf); const t = hash(li.add(5)).mul(v.y.mul(2 / 9.81)); p.addAssign(v.mul(t)); p.y.subAssign(t.mul(t).mul(4.905)); v.y.subAssign(t.mul(9.81)); })().compute(CN); // each drop starts somewhere along its own arc
  const step = Fn(() => {
    If(TINT.element(fOf).w.greaterThan(0.5), () => { // main.js 1578: nothing to step from far away
      const p = pos.element(instanceIndex), v = vel.element(instanceIndex), dt = deltaTime.min(0.05);
      v.y.subAssign(dt.mul(9.81)); p.addAssign(v.mul(dt));
      If(p.y.lessThan(0.3), () => { reset(p, v, li.add(int(time.mul(60))), fOf); });
    });
  })().compute(CN);
  // which fountain a sprite belongs to: spray drops first (C x N), then the smoke (C x SN)
  const isSmoke = instanceIndex.greaterThanEqual(uint(CN)), j = instanceIndex.max(uint(CN)).sub(uint(CN));
  const f = select(isSmoke, j.div(uint(SN)), instanceIndex.div(uint(N)).min(uint(C - 1)));
  const P = SHOW.element(f), Tn = TINT.element(f), T = P.y, size = P.w.mul(Tn.w);
  const fade = smoothstep(150.0, 90.0, cameraPosition.distance(place(f, vec3(cx, 6, cz)))); // gone from the air beyond ~150 m
  // spray
  const showHue = mix(mix(vec3(0.2, 0.55, 1.0), vec3(1.0, 0.25, 0.7), sin(time.mul(0.4)).mul(0.5).add(0.5)), vec3(0.3, 1.0, 0.7), select(fract(time.div(T.mul(2))).greaterThan(0.5), float(1), float(0))); // lit jets at night
  const sprayColour = vec4(mix(vec3(0.78, 0.88, 0.95), showHue.mul(Tn.xyz).mul(2.2), uNight), 1); // water by day; coloured light at night
  const sprayOpacity = float(0.1).mul(uv().sub(0.5).length().mul(2).oneMinus().max(0).pow(1.5)).mul(fade);
  // fire and smoke at night: 8 flame columns round the ring every 3 T s, then smoke drifting up (analytic, no simulation)
  const cycOf = (Tf) => fract(time.div(Tf.mul(3)));
  const cyc = cycOf(T);
  const si = j.mod(uint(SN)).toFloat();
  const sc2 = floor(si.div(24)), sk = si.sub(sc2.mul(24)), sAge = cyc.sub(0.05).max(0).mul(T.mul(3)), sAng = sc2.mul(0.7854);
  const smokePos = vec3(sAng.cos().mul(6.5).add(cx).add(hash(sk).sub(0.5).mul(sAge).mul(1.2)), sAge.mul(2.2).add(hash(sk.add(1)).mul(6)).add(6), sAng.sin().mul(6.5).add(cz).add(hash(sk.add(2)).sub(0.5).mul(sAge).mul(1.2)));
  const smokeOpacity = uv().sub(0.5).length().mul(2).oneMinus().max(0).mul(select(cyc.greaterThan(0.05), float(1), float(0))).mul(smoothstep(0.35, 0.08, cyc)).mul(0.28).mul(fade).mul(uNight.mul(0.7).add(0.3));
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  m.name = 'fountain spray and smoke';
  m.positionNode = place(f, select(isSmoke, smokePos, pos.toAttribute()));
  m.scaleNode = select(isSmoke, sAge.mul(0.5).add(2.5), float(0.55)).mul(size); // big soft drops read as spray; tiny ones turn into 2-pixel squares
  m.colorNode = select(isSmoke, vec4(vec3(0.35, 0.34, 0.33), 1), sprayColour);
  // x the row's `near` flag (0 for an unused row and for a fountain too far to step): such sprites are drawn at size 0, which a
  // real GPU still rasterises as specks at the row's place, the world origin for an unused row (Encore GPU shots, 12 Nov 2026)
  m.opacityNode = select(isSmoke, smokeOpacity, sprayOpacity).mul(Tn.w);
  const sp = new THREE.Sprite(m); sp.count = C * (N + SN); sp.frustumCulled = false; sp.name = 'fountain spray and smoke';
  sp.userData.vfx = { module: MODULE, part: 'spray and smoke', compute: true };
  // fire
  const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }); fm.fog = false; fm.name = 'fountain fire';
  const ff = instanceIndex.div(uint(FN)), FP = SHOW.element(ff), FT = TINT.element(ff);
  const fcyc = cycOf(FP.y), on = select(fcyc.lessThan(0.07), float(1), float(0));
  const fi = instanceIndex.mod(uint(FN)).toFloat();
  const col = floor(fi.div(70)), k = fi.sub(col.mul(70)), ang = col.mul(0.7854);
  const life = fract(time.mul(1.6).add(hash(k.add(col.mul(13))))), fx = ang.cos().mul(6.5).add(cx), fz = ang.sin().mul(6.5).add(cz);
  const ffade = smoothstep(150.0, 90.0, cameraPosition.distance(place(ff, vec3(cx, 6, cz))));
  fm.positionNode = place(ff, vec3(fx.add(hash(k).sub(0.5).mul(life).mul(1.4)), life.mul(9).add(0.8), fz.add(hash(k.add(3)).sub(0.5).mul(life).mul(1.4))));
  fm.colorNode = vec4(mix(vec3(1.0, 0.75, 0.25), vec3(1.0, 0.25, 0.05), life).mul(1.6), 1); fm.scaleNode = life.oneMinus().mul(1.8).add(0.4).mul(FP.w.mul(FT.w));
  const disc = uv().sub(0.5).length().mul(2).oneMinus().max(0); // round, soft sprites (squares otherwise)
  fm.opacityNode = on.mul(life.oneMinus()).mul(uNight).mul(ffade).mul(disc.pow(1.5)).mul(FT.w); // as the spray: nothing from an unused or far row
  const fire = new THREE.Sprite(fm); fire.count = C * FN; fire.frustumCulled = false; fire.name = 'fountain fire';
  fire.userData.vfx = { module: MODULE, part: 'fire' };
  return { C, PLACE, SHOW, TINT, sp, fire, init, step, pos, vel, materials: [m, fm] };
}

/** The show of every fountain in the scene: one compute pass, two draws. */
function createShow(ctx, { renderer = null, camera = null } = {}) {
  const { THREE } = ctx;
  const object = new THREE.Group(); object.name = 'fountain show'; object.userData.vfx = { module: MODULE };
  let gpu = null, started = false, list = [];
  const free = () => {
    if (!gpu) return;
    object.remove(gpu.sp, gpu.fire);
    for (const x of gpu.materials) x.dispose();
    gpu.init.dispose(); gpu.step.dispose(); gpu.pos.value.dispose(); gpu.vel.value.dispose();
    gpu = null;
  };
  const centre = new THREE.Vector3();
  const handle = {
    object, layer: 'fx',
    get capacity() { return gpu ? gpu.C : 0; },
    /** Every fountain: [{ uid, matrix (Matrix4), params }]. The arrays grow to the next power of two (a new simulation). */
    set(fountains) {
      list = fountains.slice();
      const need = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, list.length))));
      if (!gpu || gpu.C < need) { free(); gpu = makeShow(ctx, need); object.add(gpu.sp, gpu.fire); started = false; }
      for (let i = 0; i < gpu.C; i++) {
        const r = list[i] ? showRow(THREE, list[i]) : { place: [0, 0, 0, 0], show: [1, 8, 0, 1], tint: [1, 1, 1, 0] };
        if (list[i] && camera) r.tint[3] = camera.position.distanceTo(centre.set(0, 6, 0).applyMatrix4(list[i].matrix)) < NEAR ? 1 : 0;
        gpu.PLACE.array[i].set(...r.place); gpu.SHOW.array[i].set(...r.show); gpu.TINT.array[i].set(...r.tint);
      }
      object.visible = list.length > 0;
    },
    /** Before each render (main.js 1578): each fountain shown and stepped only near the camera; the init pass first, once. */
    frame() {
      if (!gpu || !list.length) return;
      if (camera) list.forEach((it, i) => { gpu.TINT.array[i].w = camera.position.distanceTo(centre.set(0, 6, 0).applyMatrix4(it.matrix)) < NEAR ? 1 : 0; });
      if (!renderer) return;
      if (!started) { renderer.compute(gpu.init); started = true; }
      if (list.some((_, i) => gpu.TINT.array[i].w > 0.5)) renderer.compute(gpu.step);
    },
    /** For tests and the gate: the show's GPU objects (arrays, sprites, compute nodes). */
    get gpu() { return gpu; },
    dispose() { free(); object.removeFromParent(); },
  };
  return handle;
}

export async function build(params, ctx) {
  const { THREE } = ctx;
  const stone = ctx.slot('stone'), water = ctx.slot('water');
  if (water.userData?.ready && typeof window !== 'undefined') await water.userData.ready;
  const object = basin(THREE, { preset: ctx.preset, stone, water });
  const f = features(ctx);
  return {
    object, lights: jetLights(), collider: collider(), features: f,
    effect: f.spray ? { create: (opts = {}) => createShow(ctx, opts) } : null,
  };
}
