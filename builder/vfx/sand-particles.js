// sand-particles.js: a pool of sand grains and dust on the GPU, shared by the sand burst and the sand trail. r187 examples:
// webgpu_compute_particles (positions and velocities in instancedArray storage buffers, an update compute pass with gravity,
// friction and a floor bounce, a SpriteNodeMaterial reading the positions with toAttribute(), one Sprite with count = the
// pool) and webgpu_compute_particles_snow (the ground drawn from above into a height target, sampled in the compute pass so
// each particle stops on the surface under it: lib/runtime/ground-height.mjs). Recipes: threejs-procedural-vfx (pool
// instances, do not allocate per burst; normalised lifetime curves; a non-bloom baseline that stays legible) and
// threejs-performance (compute moves particle work off the CPU: no per-particle loop, no buffer re-upload per frame).
//
// GPU only (Kereem, 12 Nov 2026: "use GPU to accelerate - don't use CPU"). The CPU never touches a particle:
//  - State: pos (xyz, the particle's own ground: the height it was born over), vel (xyz, its tint packed 8:8:8), info (birth time, life,
//    size, seed) in three storage buffers of `cap` elements, made once.
//  - Spawning is done by the update pass itself, from a small slot table (SLOTS rows of four vec4 uniform arrays): a fire or
//    a trail step writes one row (origin, birth, the range of the ring it takes, speed, life, the segment start for a
//    trail, size, ground). Each particle, in the pass, finds the newest due row whose range covers its index and whose birth
//    is after its own, and respawns from it. So a burst is 16 floats of uniforms, never `count` particles of data, and the
//    pass writes only its own element: the same code runs as WebGPU compute and as WebGL 2 transform feedback (r187's
//    WebGLBackend.compute), which can only write a thread's own element.
//  - The ring: a burst takes the next `count` slots of the pool (oldest grains are reused), so the pool never grows.
//  - Integration per frame (the TSL clock's advance since the last pass, in steps of at most 100 ms, at most 4 passes a frame: a slow phone frame still moves the sand at its real speed): gravity (grains 9.81 m/s^2, dust 1.5), drag (exp(-k dt): grains
//    0.35, dust 2.4 /s), then the ground: below the surface, a grain lands (y on the surface, a small bounce, sliding friction)
//    and lies there until it fades.
//  - Draw: one Sprite (SpriteNodeMaterial, normal blending, no depth write, premultiplied into the stage's effects layer),
//    count = cap: one draw per pool, whatever the number of bursts. A dead particle is drawn at scale 0.
//  - Look: the colour is the frozen sand material's own palette (shared/materials/boulevard-ground.js SAND.pale, SAND.deep,
//    linear), mixed per grain by its seed, times a tint, lit by the stage's day term (dim blue at night, as the sand reads by
//    moonlight). Grains are small round sprites; one in five particles is dust: larger, slower, very soft and faint. No
//    texture: the disc is the distance from the sprite's centre.
//  - Near the camera: a grain fades out between 2 m and 0.6 m of view distance and never covers more than 2.5 % of the
//    screen height (NEAR_FADE, MAX_SCREEN_SHARE): sand thrown at the lens no longer fills the frame.
//  - Idle: once every particle has died and no row is waiting, no compute is dispatched.
import { Fn, If, Loop, instancedArray, instanceIndex, uniformArray, uniform, float, int, vec3, vec4, hash, mix, select, smoothstep,
  uv, time, exp, texture, OnBeforeObjectUpdate, cameraViewMatrix, cameraProjectionMatrix, min } from 'three/tsl';
import { SAND } from '../../shared/materials/boulevard-ground.js';

export const MODULE = 'builder/vfx/sand-particles.js';
/** Particles per pool and preset: `burst` is shared by every burst piece of the scene, `hit` by every burst_on_hit behaviour,
 * `trail` by every trail behaviour (lib/behaviours/). */
export const CAPS = Object.freeze({ phone: Object.freeze({ burst: 2048, hit: 1024, trail: 1024 }), high: Object.freeze({ burst: 24576, hit: 4096, trail: 4096 }) });
/** The whole frame's sand particles (both pools): the coordinator's starting caps, 4k on the phone, 32k on desktop. */
export const BUDGET_PARTICLES = Object.freeze({ phone: 4096, high: 32768 });
export const SUBSTEPS = 4; // passes per frame at most (a frame slower than 0.1 s)
export const SLOTS = 32; // rows of the spawn table (a frame writes at most SLOTS rows: fires plus trail steps)
export const DUST_SHARE = 0.2;
export const G = 9.81;
/** Near the camera (real-GPU shot of the combat page, 13 Nov 2026: grains by the lens drew as blurred discs over the whole
 * frame): a grain fades out by view-space distance, nothing under `from` metres and full by `to`, and its drawn size is
 * clamped so it never covers more than MAX_SCREEN_SHARE of the screen height. Every pool draws with both (createPool). */
export const NEAR_FADE = Object.freeze({ from: 0.6, to: 2 });
export const MAX_SCREEN_SHARE = 0.025;
/** The near fade as the shader computes it (smoothstep): 0 at `from` and nearer, 1 at `to` and farther. */
export function nearFade(dist) {
  const t = Math.min(1, Math.max(0, (dist - NEAR_FADE.from) / (NEAR_FADE.to - NEAR_FADE.from)));
  return t * t * (3 - 2 * t);
}
/** The share of the screen height a sprite `scale` metres across covers at view depth `depth` (p11: projectionMatrix[1][1]). */
export const screenShare = (scale, depth, p11) => (depth > 0 ? (scale * p11) / (2 * depth) : Infinity);
/** The drawn size of a grain: its own, or the size that covers MAX_SCREEN_SHARE of the screen height at that depth (0 behind the camera). */
export const clampScale = (scale, depth, p11) => Math.min(scale, (MAX_SCREEN_SHARE * 2 * Math.max(0, depth)) / p11);
export const PALETTES = Object.freeze({ 'desert-sand': Object.freeze({ pale: SAND.pale, deep: SAND.deep }) });

/** The sand colours of a material preset (linear rgb). */
export function palette(name) {
  const p = PALETTES[name];
  if (!p) throw new Error(`sand-particles: no palette for material "${name}"`);
  return { pale: [...p.pale], deep: [...p.deep] };
}

/** A tint as one float (r * 65536 + g * 256 + b, 8 bits each: exact in a float32), so every row has its own colour. */
export function packTint(THREE, tint) {
  const c = new THREE.Color(tint ?? '#ffffff'), q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return q(c.r) * 65536 + q(c.g) * 256 + q(c.b);
}

/** Which path runs: WebGPU compute, WebGL 2 transform feedback (r187 WebGLBackend.compute), or none (no compute at all). */
export function fxPath({ isWebGPU, renderer }) {
  if (!renderer || typeof renderer.compute !== 'function') return 'none';
  if (renderer.backend?.isWebGLBackend || !isWebGPU) return 'webgl-transform-feedback';
  return 'webgpu-compute';
}
/** The pool size for a preset, pool kind and path: WebGL draws half (transform feedback copies every buffer each pass). */
export function capFor(preset, kind, path) {
  const c = CAPS[preset === 'phone' ? 'phone' : 'high'][kind];
  if (path === 'none') return 0;
  return path === 'webgl-transform-feedback' ? c / 2 : c;
}

/**
 * One pool: `cap` particles, one compute pass, one Sprite. `ground` (lib/runtime/ground-height.mjs) is optional: without it
 * particles stop at the height they were born over. `night` / `day` are the stage's environment uniforms.
 */
export function createPool(ctx, { cap, renderer = null, ground = null, name = 'sand' }) {
  const { THREE } = ctx;
  const env = ctx.environment || {};
  const uDay = env.day || uniform(1);
  const pos = instancedArray(cap, 'vec4'), vel = instancedArray(cap, 'vec4'), info = instancedArray(cap, 'vec4');
  const rows = () => Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, 0, 0));
  const SA = uniformArray(rows(), 'vec4'), SB = uniformArray(rows(), 'vec4'), SC = uniformArray(rows(), 'vec4'), SD = uniformArray(rows(), 'vec4');
  const pale = palette(ctx.palette || 'desert-sand');
  const uPale = uniform(new THREE.Color(...pale.pale)), uDeep = uniform(new THREE.Color(...pale.deep));
  const N = float(cap);
  // the step's dt: the TSL clock's advance since the last pass, set once per pass from the CPU (TSL deltaTime reads 0 in a
  // compute pass on r187's WebGPU backend: the burst spawned but never moved; measured in the desktop and phone WebGPU e2e)
  const uDt = uniform(1 / 60);

  // ---------- the update pass: spawn from the slot table, then integrate and land ----------
  const groundAt = (p) => {
    if (!ground) return p.w;
    const b = ground.bounds, guv = ground.heightUV(p.xz);
    const inside = guv.x.greaterThan(0).and(guv.x.lessThan(1)).and(guv.y.greaterThan(0)).and(guv.y.lessThan(1)).and(b.w.greaterThan(0.5));
    const t = texture(ground.texture, guv.clamp(0.001, 0.999));
    return select(inside.and(t.g.greaterThan(0.5)), t.r, p.w);
  };
  const step = Fn(() => {
    const i = instanceIndex, fi = i.toFloat();
    const P = pos.element(i), V = vel.element(i), I = info.element(i);
    const best = int(-1).toVar(), bestBirth = I.x.toVar();
    Loop(SLOTS, ({ i: k }) => {
      const A = SA.element(k), B = SB.element(k);
      const rel = fi.sub(B.x).add(N).mod(N);
      If(rel.lessThan(B.y).and(A.w.greaterThan(bestBirth)).and(A.w.lessThanEqual(time)), () => { best.assign(k); bestBirth.assign(A.w); });
    });
    If(best.greaterThanEqual(0), () => {
      const A = SA.element(best), B = SB.element(best), C = SC.element(best), D = SD.element(best);
      const h = (n) => hash(fi.add(A.w.mul(977.13)).add(n * 131.7));
      const dust = h(7).lessThan(DUST_SHARE), trail = C.w.greaterThan(0.5);
      const th = h(1).mul(6.2832), r = h(4).sqrt().mul(D.z);
      // burst: a crown of grains thrown up and out (cos of the angle from the vertical 0.35..1), dust slower
      const up = mix(float(0.35), float(1), h(2)), side = up.mul(up).oneMinus().max(0).sqrt();
      const sp = B.z.mul(mix(float(0.45), float(1), h(3))).mul(select(dust, float(0.45), float(1)));
      const burstVel = vec3(th.cos().mul(side), up, th.sin().mul(side)).mul(sp);
      // trail: born along the segment the carrier moved over this frame, drifting up and out slowly
      const along = mix(C.xyz, A.xyz, h(5));
      const trailVel = vec3(th.cos().mul(h(3).mul(0.6)), h(2).mul(0.8).add(0.2), th.sin().mul(h(3).mul(0.6))).mul(B.z);
      const o = select(trail, along, A.xyz).add(vec3(th.cos().mul(r), 0, th.sin().mul(r)));
      P.assign(vec4(o, D.y));
      V.assign(vec4(select(trail, trailVel, burstVel), D.w)); // w: the row's tint, packed
      I.assign(vec4(A.w, B.w.mul(mix(float(0.6), float(1), h(6))), D.x.mul(mix(float(0.55), float(1.45), h(8))).mul(select(dust, float(4.5), float(1))), h(7)));
    });
    const age = time.sub(I.x);
    If(age.greaterThanEqual(0).and(age.lessThan(I.y)), () => {
      const dust = I.w.lessThan(DUST_SHARE), dt = uDt;
      const g = select(dust, float(1.5), float(G)), k = select(dust, float(2.4), float(0.35));
      const v = V.xyz.add(vec3(0, g.negate().mul(dt), 0)).mul(exp(k.negate().mul(dt))).toVar();
      const p = P.xyz.add(v.mul(dt)).toVar();
      const gy = groundAt(vec4(p, P.w));
      If(p.y.lessThan(gy), () => {
        p.y.assign(gy);
        v.y.assign(select(v.y.lessThan(dt.mul(G).add(1.5).negate()), v.y.negate().mul(0.25), float(0))); // a small bounce on a real fall, else it lies there (one frame of gravity is not a fall)
        v.x.mulAssign(0.55); v.z.mulAssign(0.55);
      });
      P.assign(vec4(p, P.w)); V.assign(vec4(v, V.w));
    });
  })().compute(cap).setName(`${name} particles`);

  // ---------- the draw: one Sprite for the pool ----------
  let now = 0, forced = null;
  const clock = Fn(() => { OnBeforeObjectUpdate((frame) => { now = frame.time; }); return float(0); })();
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  m.name = `${name} particles`; m.fog = false;
  const aV = vel.toAttribute(), aI = info.toAttribute(), age = time.sub(aI.x), u = age.div(aI.y.max(1e-3));
  const alive = age.greaterThanEqual(0).and(u.lessThan(1));
  const isDust = aI.w.lessThan(DUST_SHARE);
  const d = uv().sub(0.5).length().mul(2), disc = d.oneMinus().max(0);
  const fade = smoothstep(1, 0.7, u).mul(smoothstep(0, 0.04, u));
  const lit = mix(vec3(0.16, 0.18, 0.26), vec3(1.0, 1.0, 1.0), uDay); // moonlit at night, full by day
  // the tint is unpacked in the vertex stage: the packed float is exact only as the attribute (interpolated across the
  // sprite it came out a unit off, and a white tint, 16777215, read as red on some grains: SwiftShader shots, 12 Nov)
  const packed = aV.w, tint = vec3(packed.div(65536).floor(), packed.div(256).floor().mod(256), packed.mod(256)).div(255).toVertexStage();
  // grains lean to the deep tone and dust to the pale one, so a burst reads against the sand it came from
  const col = select(isDust, uPale.mul(1.12), mix(uPale, uDeep, hash(aI.w.mul(7919)).mul(0.5).add(0.5)).mul(0.85)).mul(tint).mul(lit);
  m.positionNode = pos.toAttribute().xyz;
  // near the camera (NEAR_FADE, MAX_SCREEN_SHARE): the grain's view position, once per vertex; the size is the smaller of
  // its own and the one that covers MAX_SCREEN_SHARE of the screen height at its depth (perspective: p11 / depth)
  const viewPos = cameraViewMatrix.mul(vec4(pos.toAttribute().xyz, 1)).xyz;
  const near = smoothstep(float(NEAR_FADE.from), float(NEAR_FADE.to), viewPos.length()).toVertexStage();
  const maxScale = viewPos.z.negate().max(0).mul(float(MAX_SCREEN_SHARE * 2)).div(cameraProjectionMatrix.element(1).element(1));
  m.scaleNode = select(alive, min(aI.z.mul(select(isDust, u.mul(1.6).add(0.6), float(1))), maxScale), float(0));
  m.colorNode = vec4(col, 1);
  m.opacityNode = select(alive, select(isDust, disc.pow(2).mul(0.35), smoothstep(0, 0.35, disc).mul(0.95)).mul(fade).mul(near), float(0)).add(clock);
  const sprite = new THREE.Sprite(m); sprite.count = cap; sprite.frustumCulled = false; sprite.name = `${name} particles`;
  sprite.userData.vfx = { module: MODULE, part: name, compute: true, cap };

  // ---------- the CPU side: rows of the slot table, never particles ----------
  let cursor = 0, row = 0, written = 0, aliveUntil = -Infinity, last = null, unread = false, lastPass = null, sim = 0;
  const timeNow = () => (forced !== null ? forced : renderer?._nodes?.nodeFrame?.time ?? now);
  return {
    cap, sprite, step, material: m, buffers: { pos, vel, info }, slots: { SA, SB, SC, SD }, uniforms: { uPale, uDeep, uDt },
    get now() { return timeNow(); },
    /** Seconds the pass has simulated so far (the sum of its steps): behind the clock only under 2.5 fps. */
    get simTime() { return sim; },
    /** Tests and the gate: drive the clock the CPU side reads (the shaders read the TSL clock). */
    forceNow(t) { forced = t; },
    /** Write one spawn row: { origin, prev?, birth, count, speed, life, size, ground, radius, kind: 'burst' | 'trail' }. */
    spawn({ origin, prev = null, birth, count, speed, life, size, ground: gy = origin[1], radius = 0, tint = '#ffffff' }) {
      const n = Math.max(0, Math.min(cap, Math.round(count)));
      if (!n) return null;
      const k = row; row = (row + 1) % SLOTS;
      const b = Math.max(1e-3, birth); // particles start with birth 0: a row must be after it
      SA.array[k].set(origin[0], origin[1], origin[2], b);
      SB.array[k].set(cursor, n, speed, life);
      SC.array[k].set(...(prev || origin), prev ? 1 : 0);
      SD.array[k].set(size, gy, radius, packTint(THREE, tint));
      last = { origin: [...origin], prev: prev ? [...prev] : null, birth: b, count: n, start: cursor, kind: prev ? 'trail' : 'burst', row: k };
      cursor = (cursor + n) % cap; written++; unread = true;
      aliveUntil = Math.max(aliveUntil, b + life);
      return last;
    },
    /** Whether a row written earlier still holds what was written (not reused by later rows). */
    intact(r) { return !!r && SA.array[r.row].w === r.birth && SB.array[r.row].x === r.start && SB.array[r.row].y === r.count; },
    lastSlot: () => (last ? structuredClone(last) : null),
    slotsWritten: () => written,
    setPalette(paletteName = 'desert-sand') { const p = palette(paletteName); uPale.value.setRGB(...p.pale); uDeep.value.setRGB(...p.deep); },
    /** Before each render: one dispatch while anything lives (or a row is due). */
    frame() {
      if (!renderer || typeof renderer.compute !== 'function') return false;
      if (!unread && timeNow() > aliveUntil + 0.1) return false; // a written row is always read by one pass (a frame slower than the burst)
      const t = timeNow();
      // a frame slower than 0.1 s is stepped in up to SUBSTEPS equal passes of at most 0.1 s: the sand keeps its real speed
      // down to 2.5 fps (a grain's life runs on the clock, so one capped pass a frame left it dying in the air)
      const gap = lastPass === null ? 1 / 60 : Math.max(0, t - lastPass), n = Math.min(SUBSTEPS, Math.max(1, Math.ceil(gap / 0.1 - 1e-9)));
      uDt.value = Math.min(0.1, gap / n); lastPass = t;
      for (let k = 0; k < n; k++) renderer.compute(step);
      sim += uDt.value * n; unread = false;
      return true;
    },
    dispose() { step.dispose?.(); m.dispose(); for (const b of [pos, vel, info]) b.value.dispose?.(); sprite.removeFromParent(); },
  };
}
