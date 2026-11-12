// locomotion.mjs: third-person action locomotion for the `player` behaviour (behaviours/player), for ANY character: every
// number is a param of the behaviour, nothing here knows a scene, a component or a game. Kereem, 12 Nov 2026: "the
// character shouldn't walk but needs to run in a gaming way - build something that we can scale".
// Pure (no Rapier, no three.js, no DOM): lib/walk/controller.mjs feeds the velocity it returns to Rapier's
// KinematicCharacterController (r187 physics_rapier_character_controller) and gives back what the level allowed.
//  - run by default, sprint while the command asks for it (Shift, or the stick pushed fully: lib/walk/input.mjs);
//  - momentum: the ground velocity moves towards the wished one at `acceleration` (speeding up or steering) or
//    `deceleration` (slowing down, stopping), in m/s^2, so a start, a stop and a reversal each take time; in the air only
//    `airControl` of that;
//  - turn speed: the body turns towards where it is asked to go (camera-relative, lib/walk/input.mjs) at `turnSpeed`
//    degrees a second at most, not at once;
//  - jump: `jump` m/s up against GRAVITY, with a grace after leaving a ledge (COYOTE) and a press remembered just before
//    landing (JUMP_BUFFER), as action games do;
//  - dodge: a burst of `dodgeSpeed` for `dodgeTime` seconds the way he is asked to go (standing: the way he faces), not
//    steered while it lasts, then `dodgeCooldown` before the next; on the ground only (s.dodging is 1 while it lasts, for
//    whoever gives it meaning: the combat's hits);
//  - the follow camera's recentring (recentre: it swings behind a runner by itself, `cameraRecentre` radians a second at
//    most, and leaves the camera alone while he stands, runs at it, or the player has just looked around);
//  - the follow camera's lag (followTarget) and the figure's gait (createGaitState: idle / run / sprint weights, the stride
//    phase, the lean into acceleration and the bank into a turn) for whatever draws the character: a rigged actor blends
//    its clips or its procedural cycle by them, the rigid figure bobs and leans.
// web-game-kit ref/character.md (kinematic controller, spring-arm camera) and ref/loop-and-physics.md (fixed 60 Hz step).

export const GRAVITY = 16; // m/s^2, the walk's own (lib/walk/controller.mjs)
export const COYOTE = 0.1, JUMP_BUFFER = 0.12; // seconds
export const LOCOMOTION = Object.freeze({
  runSpeed: 6.2, sprintSpeed: 9, acceleration: 30, deceleration: 36, turnSpeed: 720, airControl: 0.35, jump: 5.6,
  dodgeSpeed: 14, dodgeTime: 0.22, dodgeCooldown: 0.6,
  cameraDistance: 4.6, cameraLag: 0.12, cameraRecentre: 0.7, lean: 8,
});

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
/** The behaviour's params (any missing or not a number: the default), as the mover takes them. */
export function locomotionTuning(p = {}) {
  const t = {};
  for (const k of Object.keys(LOCOMOTION)) t[k] = num(p[k], LOCOMOTION[k]);
  t.sprintSpeed = Math.max(t.sprintSpeed, t.runSpeed); // a sprint is never slower than the run
  return t;
}

/** The shortest signed angle from a to b, in (-PI, PI]. */
export function angleTo(a, b) { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d <= -Math.PI) d += 2 * Math.PI; return d; }

/**
 * One step of the ground velocity and the facing. s: { vx, vz, yaw } (changed in place); cmd: { mx, mz (world-space
 * wish, length <= 1: an analog stick runs slower when pushed less), sprint }; t: locomotionTuning.
 * → s, with s.turn (rad/s this step) and s.wish (the speed asked for, m/s).
 */
export function steer(s, cmd = {}, t = LOCOMOTION, dt = 1 / 60, grounded = true) {
  let mx = num(cmd.mx, 0), mz = num(cmd.mz, 0); const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
  // the dodge: started on the ground when ready, then it owns the velocity until it ends
  s.dodgeCd = Math.max(0, num(s.dodgeCd, 0) - dt);
  if (cmd.dodge && grounded && !(s.dodge > 0) && s.dodgeCd <= 0 && t.dodgeSpeed > 0 && t.dodgeTime > 0) {
    const yaw = len >= 0.08 ? Math.atan2(mx, mz) : num(s.yaw, 0);
    s.dodge = t.dodgeTime; s.dodgeCd = t.dodgeTime + t.dodgeCooldown; s.dodgeX = Math.sin(yaw); s.dodgeZ = Math.cos(yaw); s.yaw = yaw;
  }
  if (s.dodge > 0) {
    s.dodge = Math.max(0, s.dodge - dt); s.dodging = 1; s.turn = 0;
    // the burst, and on its last step the speed he would be running at, so he comes out of it running, not skating
    const v = s.dodge > 0 ? t.dodgeSpeed : Math.min(t.dodgeSpeed, t.runSpeed);
    s.vx = s.dodgeX * v; s.vz = s.dodgeZ * v; s.wish = v;
    return s;
  }
  s.dodging = 0;
  const amount = Math.min(1, len), top = cmd.sprint ? t.sprintSpeed : t.runSpeed;
  const tx = mx * top, tz = mz * top; // the wished velocity
  const vx = num(s.vx, 0), vz = num(s.vz, 0), speed = Math.hypot(vx, vz), want = top * amount;
  // slowing down (no wish, or a wish slower than he goes along it) brakes; anything else accelerates
  const along = want > 1e-6 ? (vx * tx + vz * tz) / want : 0;
  let rate = amount < 0.08 || along > want + 1e-6 ? t.deceleration : t.acceleration;
  if (!grounded) rate *= t.airControl;
  const dx = (amount < 0.08 ? 0 : tx) - vx, dz = (amount < 0.08 ? 0 : tz) - vz, d = Math.hypot(dx, dz), stepV = rate * dt;
  if (d <= stepV || d < 1e-9) { s.vx = vx + dx; s.vz = vz + dz; } else { s.vx = vx + (dx / d) * stepV; s.vz = vz + (dz / d) * stepV; }
  // the body turns towards the wish (not the velocity: he leans into a turn before the momentum follows)
  s.turn = 0;
  if (amount >= 0.08) {
    const to = Math.atan2(mx, mz), diff = angleTo(num(s.yaw, 0), to), max = ((t.turnSpeed * Math.PI) / 180) * dt * (grounded ? 1 : Math.max(t.airControl, 0.2));
    const turn = Math.abs(diff) <= max ? diff : Math.sign(diff) * max;
    s.yaw = num(s.yaw, 0) + turn; s.turn = turn / dt;
    if (s.yaw > Math.PI) s.yaw -= 2 * Math.PI; else if (s.yaw <= -Math.PI) s.yaw += 2 * Math.PI;
  }
  s.wish = want; s.speedBefore = speed;
  return s;
}

/**
 * The vertical velocity for this step, with the jump's grace times. s: { vy, g (1 grounded), air (s since the ground),
 * buffer (s left of a remembered press) }; → true when a jump started on this step.
 */
export function jumpStep(s, cmd = {}, t = LOCOMOTION, dt = 1 / 60) {
  s.air = s.g ? 0 : num(s.air, 0) + dt;
  s.buffer = cmd.jump ? JUMP_BUFFER : Math.max(0, num(s.buffer, 0) - dt);
  const can = (s.g || (s.air <= COYOTE && !s.jumped)) && t.jump > 0;
  if (s.g) s.jumped = false;
  if (can && s.buffer > 0) { s.vy = t.jump; s.buffer = 0; s.jumped = true; s.g = 0; return true; }
  if (s.g) s.vy = 0; else s.vy = num(s.vy, 0) - GRAVITY * dt; // 0 on the ground: the controller's snap follows a slope down. A push down (it was -1 m/s) made Rapier's controller lose 1 to 3% of the steps on a flat trimesh, a hitch about once a second
  return false;
}

/** The apex of a jump over the take-off, metres: v^2 / 2g. */
export const jumpApex = (jump = LOCOMOTION.jump) => (jump * jump) / (2 * GRAVITY);
/** Seconds from standing to `to` m/s (default: the run speed), and metres to stop from `from` m/s. */
export const timeToSpeed = (t = LOCOMOTION, to = t.runSpeed) => to / t.acceleration;
export const stopDistance = (t = LOCOMOTION, from = t.runSpeed) => (from * from) / (2 * t.deceleration);

/**
 * The follow camera's yaw, recentred behind the hero while he runs. camYaw: the camera sits at +(sin, cos)(camYaw) from
 * him; yaw: his facing; speed m/s; sinceLook: seconds since the player last turned the camera himself (it waits
 * RECENTRE_WAIT). The pull is sin(off) x cameraRecentre radians a second: nothing when the camera is already behind him,
 * the most when he runs across the view, and nothing again when he runs straight at the camera (a swing there would turn
 * "towards the camera" into a circle).
 */
export const RECENTRE_WAIT = 0.8;
export function recentre(camYaw, yaw, speed, t = LOCOMOTION, dt = 1 / 60, sinceLook = Infinity) {
  if (!(t.cameraRecentre > 0) || !(speed > 0.5) || sinceLook < RECENTRE_WAIT) return camYaw;
  const off = angleTo(camYaw, yaw + Math.PI);
  return camYaw + Math.sin(off) * t.cameraRecentre * Math.min(1, speed / Math.max(0.1, t.runSpeed)) * dt;
}

/**
 * The follow camera's lagged target: the point the camera looks at follows the player as a critically damped
 * exponential with time constant `lag` seconds (0: no lag), so a start, a stop and a jump read on screen instead of
 * the figure being nailed to the centre. state: { x, y, z } or null (snaps). `snap` metres: farther than that (a
 * respawn) it jumps.
 */
export function followTarget(state, target, lag = LOCOMOTION.cameraLag, dt = 1 / 60, snap = 12) {
  if (!state || !(lag > 0) || Math.hypot(target[0] - state.x, target[1] - state.y, target[2] - state.z) > snap) return { x: target[0], y: target[1], z: target[2] };
  const k = 1 - Math.exp(-dt / lag);
  state.x += (target[0] - state.x) * k; state.y += (target[1] - state.y) * k; state.z += (target[2] - state.z) * k;
  return state;
}

/** Metres per step at a speed: longer steps when faster, so a sprint is not a scurry (as lib/combat/gait.mjs stepLength
 * on the combat branch: 0.25 + 0.25 v). */
export const stepLength = (speed) => 0.25 + 0.25 * Math.max(0, speed);

/**
 * The gait: what a figure's animation needs each step, from the mover's state alone. update(s, dt) with s: { vx, vz |
 * speed, g, turn, yaw }, tuning t → { idle, run, sprint (weights, sum 1), phase (0..1, one full cycle = two steps),
 * lean (radians forward: into acceleration, back when braking), bank (radians into the turn), airborne, speed }.
 * Weights are eased (EASE a second) so a clip blend or a procedural cycle never pops.
 */
export function createGaitState(t = LOCOMOTION, { ease = 10 } = {}) {
  const g = { idle: 1, run: 0, sprint: 0, phase: 0, lean: 0, bank: 0, airborne: false, speed: 0 };
  let last = 0;
  return {
    state: g,
    update(s, dt = 1 / 60, tune = t) {
      const speed = Number.isFinite(s.speed) ? s.speed : Math.hypot(num(s.vx, 0), num(s.vz, 0));
      const k = 1 - Math.exp(-ease * dt);
      const moving = Math.min(1, speed / Math.max(0.1, tune.runSpeed * 0.5)); // half the run speed is already a run
      const over = tune.sprintSpeed > tune.runSpeed ? Math.min(1, Math.max(0, (speed - tune.runSpeed) / (tune.sprintSpeed - tune.runSpeed))) : 0;
      const want = { idle: 1 - moving, run: moving * (1 - over), sprint: moving * over };
      for (const n of ['idle', 'run', 'sprint']) g[n] += (want[n] - g[n]) * k;
      const sum = g.idle + g.run + g.sprint || 1; g.idle /= sum; g.run /= sum; g.sprint /= sum;
      g.airborne = !s.g;
      if (s.g && speed > 0.05) g.phase = (g.phase + (speed * dt) / (2 * stepLength(speed))) % 1;
      const accel = dt > 0 ? (speed - last) / dt : 0; last = speed;
      const max = (tune.lean * Math.PI) / 180;
      const wantLean = Math.max(-max, Math.min(max, (accel / Math.max(1, tune.acceleration)) * max + (speed / Math.max(0.1, tune.sprintSpeed)) * max * 0.5));
      const wantBank = Math.max(-max, Math.min(max, (num(s.turn, 0) / Math.PI) * max * Math.min(1, speed / Math.max(0.1, tune.runSpeed))));
      g.lean += (wantLean - g.lean) * k; g.bank += (wantBank - g.bank) * k;
      g.speed = speed;
      return g;
    },
    reset() { Object.assign(g, { idle: 1, run: 0, sprint: 0, phase: 0, lean: 0, bank: 0, airborne: false, speed: 0 }); last = 0; },
  };
}
