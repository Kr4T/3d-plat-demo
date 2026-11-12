// controller.mjs: the walk's physics. Ported from Kr4T/3dplat-builder claude/builder-characters 293efdf
// lib/walk/controller.mjs (itself from Kr4T/3DPLAT apps/platform/shared/core.js, claude/system-guards 84a9d41: buildLevel,
// makeMover, stepPlayer; see PROVENANCE.md). r187 examples: physics_rapier_character_controller (Rapier's
// KinematicCharacterController on a capsule: computeColliderMovement, computedMovement, computedGrounded, autostep, snap to
// ground, slope limits), physics_rapier_basic (fixed bodies and colliders from the scene), physics_rapier_terrain (the
// ground as one collider made from the terrain's own heights). No three.js and no DOM, so Node runs the same steps.
// Changed from the characters branch (12 Nov 2026, WALK with the hero):
//  - no tiled slab at y = 0: the ground is the scene's own (lib/walk/level.mjs: the terrain's drawn surface as a trimesh),
//    held apart from the rest so a terrain rebuild swaps only it (setGround);
//  - 'box' (imported models), 'hull' (convex hull of points: footprints, the water blocker) as shapes;
//  - the capsule comes from the player's component (capsuleFor), not one fixed size;
//  - a fixed 60 Hz step (web-game-kit, ref/loop-and-physics.md), timed per step (stats()) against the 2 ms budget;
//  - the follow camera's arm is pulled in by a shape cast against the level (followCamera), so it never goes through the
//    ground or a piece (web-game-kit ref/character.md: spring arm with a raycast).
// Changed 12 Nov 2026 (the demo blocker: on an empty scene the hero fell forever):
//  - there is always ground: one invisible floor collider (physics only, nothing drawn) under the player, wherever he goes, its top at
//    y = 0 when the scene has no ground piece, else just under the lowest point of the terrain (floorHeight), so it never
//    stands in for the terrain where there is terrain; it follows setGround;
//  - a fall below the floor by FALL_MARGIN respawns the player at the spawn point (setSpawn moves it), in every scene.

import { LOCOMOTION, locomotionTuning, steer, jumpStep } from './locomotion.mjs';

export const STEP_HZ = 60, DT = 1 / STEP_HZ;
export { GRAVITY } from './locomotion.mjs';
export const RUN = LOCOMOTION.runSpeed, SPRINT = LOCOMOTION.sprintSpeed, JUMP = LOCOMOTION.jump; // m/s (the player behaviour's defaults)
export const SLOPE_CLIMB = 45, SLOPE_SLIDE = 50, STEP_UP = 0.35, STEP_MIN_WIDTH = 0.2, SNAP = 0.3, OFFSET = 0.01; // degrees, metres
export const FLOOR_HALF = 50, FLOOR_CELLS = 10, FLOOR_KEEP = 25, FLOOR_UNDER = 0.05, FALL_MARGIN = 2; // metres // metres
export const BLOCKED = 0.6, BLOCKED_STEPS = 3, WALL_NORMAL_Y = 0.5; // held: under 60% of the step allowed, three steps running; a wall: its normal within 30 degrees of level
// The follow camera: the ball cast along its arm, the gap kept to what it meets, the nearest it may come to its target
// (the chest: 1.6 m keeps it out of a broad figure and his clothes; it was 0.6, and on a real GPU the camera sat inside the
// hero's robe at the end of a wave), how far its arm may tip up to find that room, the arm under which the figure is not
// drawn (`close`), and the gap kept over the ground.
export const CAMERA = Object.freeze({ radius: 0.2, margin: 0.15, minDist: 1.6, tipStep: 0.2, tipMax: 1.35, hideDist: 1.0, groundClear: 0.3 });

/** The capsule of a character component: its height (the `height` scale param, else the footprint's) and a radius from the
 * footprint's narrow side, kept between 0.2 m and 0.45 m (an A-pose's arms are not the body). */
export function capsuleFor(def, params = {}) {
  const fp = def?.footprint?.outline;
  const hp = (def?.params || []).find((p) => p.name === 'height' && p.type === 'number');
  const height = +(params.height ?? hp?.default ?? def?.footprint?.height?.[1] ?? 1.7) || 1.7;
  let narrow = 0.3;
  if (Array.isArray(fp) && fp.length >= 3) {
    const xs = fp.map((q) => q[0]), zs = fp.map((q) => q[1]);
    const k = hp && params.height ? params.height / hp.default : 1;
    narrow = (Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2) * k;
  }
  const radius = Math.min(0.45, Math.max(0.2, narrow));
  return { radius, halfHeight: Math.max(0.1, height / 2 - radius), height };
}

export function quatFromEuler(x, y, z) { // XYZ order, as three.js Euler's default
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
}

/** One collider description from a world-space shape ({ type, pos, half | radius, halfHeight, rotX/Y/Z, vertices, indices,
 * points }), or null for a shape Rapier cannot make. */
export function colliderDesc(R, c) {
  let d = null;
  if (c.type === 'cuboid' || c.type === 'box') d = R.ColliderDesc.cuboid(...c.half);
  else if (c.type === 'cylinder') d = R.ColliderDesc.cylinder(c.halfHeight, c.radius);
  else if (c.type === 'capsule') d = R.ColliderDesc.capsule(c.halfHeight, c.radius);
  else if (c.type === 'ball') d = R.ColliderDesc.ball(c.radius);
  else if (c.type === 'hull') d = R.ColliderDesc.convexHull(c.points instanceof Float32Array ? c.points : new Float32Array(c.points));
  else if (c.type === 'trimesh') {
    const flags = R.TriMeshFlags ? R.TriMeshFlags.FIX_INTERNAL_EDGES : undefined; // no snag on the terrain's inner edges
    d = R.ColliderDesc.trimesh(c.vertices instanceof Float32Array ? c.vertices : new Float32Array(c.vertices), c.indices instanceof Uint32Array ? c.indices : new Uint32Array(c.indices), flags);
  } else if (c.type === 'heightfield') { const [sx, sy, sz] = c.scale || [1, 1, 1]; d = R.ColliderDesc.heightfield(c.nrows, c.ncols, new Float32Array(c.heights), { x: sx, y: sy, z: sz }); }
  if (!d) return null;
  if (c.type !== 'trimesh' && c.type !== 'hull') {
    const [x, y, z] = c.pos || [0, 0, 0]; d.setTranslation(x, y, z);
    if (c.rotX || c.rotY || c.rotZ) d.setRotation(quatFromEuler(c.rotX || 0, c.rotY || 0, c.rotZ || 0));
  }
  return d;
}

/** Fixed colliders for a list of shapes on one fixed body; sensors are skipped. → [{ collider, uid, kind }]. `owners`
 * (a Map of collider handle -> { uid, kind }) learns each one, so rays and contacts can name the piece. */
export function addColliders(R, world, body, list = [], owners = null) {
  const made = [];
  for (const c of list) {
    if (c.sensor) continue;
    const d = colliderDesc(R, c); if (!d) continue;
    const col = world.createCollider(d, body);
    const rec = { collider: col, uid: c.uid || null, kind: c.kind || null, actor: !!c.actor };
    owners?.set(col.handle, rec);
    made.push(rec);
  }
  return made;
}

/** The probe capsule and the character controller (as physics_rapier_character_controller and core.js). */
export function makeMover(R, world, capsule = { radius: 0.3, halfHeight: 0.55 }, tuning = {}) {
  const probe = world.createCollider(R.ColliderDesc.capsule(capsule.halfHeight, capsule.radius).setTranslation(0, -1000, 0));
  const cc = world.createCharacterController(OFFSET);
  cc.setUp({ x: 0, y: 1, z: 0 });
  cc.enableAutostep(STEP_UP, STEP_MIN_WIDTH, false);
  cc.enableSnapToGround(SNAP);
  cc.setMaxSlopeClimbAngle((SLOPE_CLIMB * Math.PI) / 180);
  cc.setMinSlopeSlideAngle((SLOPE_SLIDE * Math.PI) / 180);
  cc.setSlideEnabled(true);
  return { probe, cc, world, capsule, tuning: locomotionTuning(tuning) };
}

// s: { x, y, z (feet), vx, vz (over the ground, m/s), vy, yaw (facing), g (1 = grounded), speed, turn (rad/s) };
// cmd: { mx, mz (world-space wish, length <= 1), sprint, jump }. The motion model is lib/walk/locomotion.mjs (run by
// default, sprint, acceleration and braking, turn speed, the jump's grace times); Rapier's character controller then says
// how much of that step the level allows, and what it allowed is the velocity kept (a wall takes the momentum).
export function stepPlayer(m, s, cmd, dt = DT) {
  const t = m.tuning || LOCOMOTION, lift = m.capsule.halfHeight + m.capsule.radius;
  const was = !!s.g;
  jumpStep(s, cmd, t, dt);
  steer(s, cmd, t, dt, was);
  m.probe.setTranslation({ x: s.x, y: s.y + lift, z: s.z });
  m.cc.computeColliderMovement(m.probe, { x: s.vx * dt, y: s.vy * dt, z: s.vz * dt });
  const mv = m.cc.computedMovement(); s.x += mv.x; s.y += mv.y; s.z += mv.z;
  s.g = m.cc.computedGrounded() ? 1 : 0; if (s.g && s.vy < 0) s.vy = 0;
  if (!s.g && s.vy > 0 && mv.y < s.vy * dt * 0.5) s.vy = 0; // his head met something: the rise ends
  // A wall takes the momentum, at once: the part of the velocity that goes into a steep surface he met on this step is
  // removed (he slides along it and keeps the rest). normal1 is the contact normal on his own capsule, so it points at
  // the obstacle. Ground and slopes he can walk (normals mostly up or down) take nothing.
  for (let i = 0, n = m.cc.numComputedCollisions(); i < n; i++) {
    const c = m.cc.computedCollision(i), nm = c?.normal1; if (!nm || Math.abs(nm.y) > WALL_NORMAL_Y) continue;
    const l = Math.hypot(nm.x, nm.z); if (l < 1e-6) continue;
    const nx = nm.x / l, nz = nm.z / l, into = s.vx * nx + s.vz * nz;
    if (into > 0) { s.vx -= into * nx; s.vz -= into * nz; }
  }
  // And whatever else holds him (a corner, a ledge too high): when the level allows under BLOCKED of the step asked for
  // BLOCKED_STEPS steps running, the velocity kept is what it allowed. One short step is not a wall.
  const asked = Math.hypot(s.vx, s.vz), got = Math.hypot(mv.x, mv.z) / dt;
  s.blocked = asked > 0.05 && got < asked * BLOCKED ? (s.blocked || 0) + 1 : 0;
  if (s.blocked >= BLOCKED_STEPS) { s.vx = mv.x / dt; s.vz = mv.z / dt; }
  s.speed = s.blocked > 0 && s.blocked < BLOCKED_STEPS ? asked : got; // a lost step keeps the speed he carries (the gait does not hiccup)
  return s;
}

/** The top of the invisible floor for a level's ground shapes: y = 0 with no ground, else FLOOR_UNDER below its lowest point
 * (never above 0). */
export function floorHeight(ground = []) {
  let low = Infinity;
  for (const c of ground) {
    if (c.type === 'trimesh' || c.type === 'hull') { const v = c.vertices || c.points || []; for (let i = 1; i < v.length; i += 3) if (v[i] < low) low = v[i]; }
    else if (c.type === 'heightfield') { const sy = c.scale?.[1] ?? 1, y = c.pos?.[1] || 0; for (const h of c.heights || []) low = Math.min(low, y + h * sy); }
    else if (Array.isArray(c.pos)) low = Math.min(low, c.pos[1] - (Array.isArray(c.half) ? c.half[1] : (c.halfHeight || 0) + (c.radius || 0)));
  }
  return Number.isFinite(low) ? Math.min(0, low - FLOOR_UNDER) : 0;
}
// The floor is a flat trimesh (as the terrain is), not a cuboid: Rapier's character controller sinks into a cuboid's top
// while standing (measured 12 Nov 2026: up to 8 cm into a 100 m slab, 14 cm into a 2 km one; 0 into the trimesh). It is
// 100 m wide and is made again under the player when he gets within FLOOR_KEEP of its edge: to him it has no end.
function floorShape(y, x = 0, z = 0, n = FLOOR_CELLS) {
  const vertices = new Float32Array((n + 1) * (n + 1) * 3), indices = new Uint32Array(n * n * 6), step = (2 * FLOOR_HALF) / n;
  for (let j = 0, k = 0; j <= n; j++) for (let i = 0; i <= n; i++) { vertices[k++] = x - FLOOR_HALF + i * step; vertices[k++] = y; vertices[k++] = z - FLOOR_HALF + j * step; }
  for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; indices[k++] = a; indices[k++] = c; indices[k++] = b; indices[k++] = b; indices[k++] = c; indices[k++] = d; }
  return { type: 'trimesh', kind: 'ground', uid: null, vertices, indices };
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

/**
 * A walk world: the level ({ ground: [shapes], solid: [shapes] }, lib/walk/level.mjs), the mover and the player's state.
 * spawn: { p: [x, y?, z], yaw } (y null: dropped onto the level). world.step() refreshes the query pipeline after the level
 * changes (as core.js setWorld); the player itself never needs it (the controller moves a body-less collider).
 */
export function createWalkWorld(R, level = { ground: [], solid: [] }, { spawn = { p: [0, null, 0], yaw: 0 }, capsule, tuning } = {}) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 }); world.timestep = DT;
  const body = world.createRigidBody(R.RigidBodyDesc.fixed());
  const owners = new Map(); // collider handle -> { uid, kind }
  let ground = addColliders(R, world, body, level.ground || [], owners);
  let solid = addColliders(R, world, body, level.solid || [], owners);
  // the invisible floor: there is always ground (an empty scene, or the player off the edge of the terrain)
  let floorY = floorHeight(level.ground || []);
  let floor = [], floorAt = null;
  /** The floor slab under (x, z): made again there when the point is within FLOOR_KEEP of its edge (or `force`). */
  const floorTo = (x, z, force = false) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!force && floorAt && Math.max(Math.abs(x - floorAt[0]), Math.abs(z - floorAt[1])) <= FLOOR_HALF - FLOOR_KEEP) return;
    for (const g of floor) { owners.delete(g.collider.handle); world.removeCollider(g.collider, false); }
    floorAt = [x, z]; floor = addColliders(R, world, body, [floorShape(floorY, x, z)], owners);
    world.step();
  };
  const sp0 = spawn.p || [0, null, 0]; floorTo(sp0[0], sp0[2], true);
  const mover = makeMover(R, world, capsule, tuning);
  const contactCbs = new Set();
  // the ground probe and the camera look through the water blockers (kind 'water'): over a lake the ground is its basin
  const seeThrough = (col) => owners.get(col.handle)?.kind !== 'water';
  // What holds the camera's arm: the level only (ground, pieces, models, footprints). Not water, not a character or an
  // animal standing as a piece (`actor`: the nemesis, an enemy), and nothing this walk did not make itself: the combat
  // puts its own colliders in this world (lib/combat/hits.mjs: a hit volume on every fighter, the hero included;
  // lib/behaviours/hit_reaction.mjs: a knock-back body), and a cast that starts inside one of those pulled the camera
  // into the hero.
  const holdsCamera = (col) => { const rec = owners.get(col.handle); return !!rec && rec.kind !== 'water' && !rec.actor; };
  world.step();
  const times = [];
  const ray = (x, y, z, dx, dy, dz, max) => world.castRay(new R.Ray({ x, y, z }, { x: dx, y: dy, z: dz }), max, true, undefined, undefined, mover.probe, undefined, seeThrough);
  /** The top of the level under (x, z): the first hit of a ray down from `from` metres, or null. */
  const topAt = (x, z, from = 200) => { const h = ray(x, from, z, 0, -1, 0, from + 200); return h ? from - h.timeOfImpact : null; };
  let sp = [...(spawn.p || [0, null, 0])], spYaw = spawn.yaw || 0;
  const y0 = Number.isFinite(sp[1]) && sp[1] !== null ? sp[1] : (topAt(sp[0], sp[2]) ?? floorY);
  const s = { x: sp[0], y: y0 + 0.05, z: sp[2], vx: 0, vz: 0, vy: 0, yaw: spYaw, g: 0, speed: 0, turn: 0 };
  /** Back at the spawn point, on top of whatever is there now (at least the floor). */
  const respawn = () => { floorTo(sp[0], sp[2]); s.x = sp[0]; s.z = sp[2]; s.y = Math.max(topAt(sp[0], sp[2]) ?? floorY, floorY) + 0.05; s.vx = 0; s.vz = 0; s.vy = 0; s.g = 0; s.speed = 0; s.turn = 0; s.yaw = spYaw; };
  const api = {
    R, world, mover, state: s,
    colliders: () => ({ ground: ground.map((g) => ({ uid: g.uid, kind: g.kind })), solid: solid.map((g) => ({ uid: g.uid, kind: g.kind })) }),
    step(cmd = {}) {
      const t0 = now();
      floorTo(s.x, s.z);
      stepPlayer(mover, s, cmd, DT);
      if (contactCbs.size) for (let i = 0, n = mover.cc.numComputedCollisions(); i < n; i++) {
        const c = mover.cc.computedCollision(i), rec = c?.collider ? owners.get(c.collider.handle) : null;
        if (rec && rec.kind !== 'ground') for (const cb of [...contactCbs]) cb({ uid: rec.uid, kind: rec.kind, normal: c.normal1 ? { x: c.normal1.x, y: c.normal1.y, z: c.normal1.z } : null });
      }
      if (!(s.y >= floorY - FALL_MARGIN)) respawn(); // under the floor (or not a number): back to the spawn point
      times.push(now() - t0); if (times.length > 600) times.shift();
      return s;
    },
    /** Replaces the ground shapes (a terrain rebuild), keeping the player where he stands (lifted onto the new ground). */
    setGround(list = []) {
      for (const g of ground) { owners.delete(g.collider.handle); world.removeCollider(g.collider, false); }
      ground = addColliders(R, world, body, list, owners);
      const fy = floorHeight(list);
      if (fy !== floorY) { floorY = fy; floorTo(s.x, s.z, true); }
      world.step();
      const top = topAt(s.x, s.z, s.y + mover.capsule.halfHeight * 2 + mover.capsule.radius * 2);
      if (top !== null && top > s.y) s.y = top + 0.02;
      return ground.length;
    },
    /** Replaces the solid shapes (a piece opted in or out, behaviours/solid). */
    setSolid(list = []) {
      for (const g of solid) { owners.delete(g.collider.handle); world.removeCollider(g.collider, false); }
      solid = addColliders(R, world, body, list, owners); world.step(); return solid.length;
    },
    /** One more fixed shape (ctx.physics.addCollider): → { collider, uid, kind, remove() }. */
    addShape(shape) {
      const [rec] = addColliders(R, world, body, [shape], owners); if (!rec) return null;
      world.step();
      return { ...rec, remove() { owners.delete(rec.collider.handle); world.removeCollider(rec.collider, false); world.step(); } };
    },
    /** The first solid hit along a unit ray: { distance, uid, kind, point } or null (the player's own capsule is skipped). */
    raycast(origin, dir, max = 100) {
      const h = world.castRay(new R.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] }), max, true, undefined, undefined, mover.probe);
      if (!h) return null;
      const rec = owners.get(h.collider.handle), t = h.timeOfImpact;
      return { distance: t, uid: rec?.uid ?? null, kind: rec?.kind ?? null, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t] };
    },
    onContact(cb) { contactCbs.add(cb); return () => contactCbs.delete(cb); },
    retune(t = {}) { Object.assign(mover.tuning, locomotionTuning({ ...mover.tuning, ...t })); return { ...mover.tuning }; },
    topAt,
    /** The top of the invisible floor under the whole level (y = 0 on a scene with no ground piece). */
    floor: () => floorY,
    /** The spawn point a fall comes back to: p = [x, y?, z]. */
    setSpawn(p, yaw = 0) { sp = [p[0], p[1] ?? null, p[2]]; spYaw = yaw; },
    respawn,
    /** The ray from (x, y, z) along a unit (dx, dy, dz): the distance to the first solid hit up to max, or null. */
    rayHit: (x, y, z, dx, dy, dz, max) => { const h = ray(x, y, z, dx, dy, dz, max); return h ? h.timeOfImpact : null; },
    /**
     * The follow camera (spring arm): from the target (the player's chest) back along yaw / pitch for `dist`, pulled in where
     * a ball of CAMERA.radius cast along the arm meets the level, and kept CAMERA.groundClear over the ground under it.
     * Only the level holds the arm (holdsCamera): never the player, another character, or the combat's own colliders.
     * It never comes nearer than CAMERA.minDist while the level leaves that much room on some arm tipped up from the one
     * asked for; when it cannot (a low ceiling in a corner), `close` says the camera is within CAMERA.hideDist of the
     * target and the figure should not be drawn (builder/walk.js hides it).
     * → { pos: [x, y, z], target: [x, y, z], dist (the arm used), pitch (the one used), pulled (true when the level
     *     shortened or tipped it), close }
     */
    followCamera({ target, yaw = 0, pitch = 0.3, dist = 4.6 }) {
      const ball = new R.Ball(CAMERA.radius), origin = { x: target[0], y: target[1], z: target[2] };
      const arm = (pt) => {
        const cp = Math.cos(pt), d = { x: Math.sin(yaw) * cp, y: Math.sin(pt), z: Math.cos(yaw) * cp };
        const hit = world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, d, ball, 0, dist, true, undefined, undefined, mover.probe, undefined, holdsCamera);
        const use = hit ? Math.max(0, Math.min(dist, (hit.time_of_impact ?? hit.timeOfImpact ?? dist) - CAMERA.margin)) : dist;
        return { d, use, pulled: !!hit, pitch: pt };
      };
      // the arm asked for; when the level leaves it less than minDist, the arm tips up (over his head, where there is
      // usually room) until it has that much, and failing that the longest arm found is used
      const min = Math.min(CAMERA.minDist, dist);
      let best = arm(pitch);
      for (let pt = pitch + CAMERA.tipStep; best.use < min && pt <= CAMERA.tipMax + 1e-9; pt += CAMERA.tipStep) { const r = arm(pt); if (r.use > best.use) best = r; }
      const use = Math.max(best.use, 0.05), d = best.d;
      let pulled = best.pulled || best.pitch !== pitch;
      const pos = [target[0] + d.x * use, target[1] + d.y * use, target[2] + d.z * use];
      // the ground under the camera, looked for from no higher than it must be (the higher of the camera and the chest): a
      // probe from above found the top of a roof he stands under and put the camera on it
      const from = Math.max(pos[1], target[1]) + 0.05;
      const h = world.castRay(new R.Ray({ x: pos[0], y: from, z: pos[2] }, { x: 0, y: -1, z: 0 }), 200, true, undefined, undefined, mover.probe, undefined, holdsCamera);
      const top = h && h.timeOfImpact > 1e-4 ? from - h.timeOfImpact : null;
      if (top !== null && pos[1] < top + CAMERA.groundClear) { pos[1] = top + CAMERA.groundClear; pulled = true; }
      const far = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
      return { pos, target: [...target], dist: use, pitch: best.pitch, pulled, close: far < CAMERA.hideDist };
    },
    /** Step times (ms) over the last 600 steps: { n, mean, p95, max }. */
    stats() {
      if (!times.length) return { n: 0, mean: 0, p95: 0, max: 0 };
      const sorted = [...times].sort((a, b) => a - b);
      return { n: times.length, mean: times.reduce((a, b) => a + b, 0) / times.length, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted[sorted.length - 1] };
    },
    free() { world.free(); },
  };
  return api;
}
