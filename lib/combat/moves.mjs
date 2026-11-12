// moves.mjs: the combat moves as data (a small generic move system: keyframed bone poses, parameterised), for rigs that can
// only take moves within their limits (the rig check, 12 Nov 2026: the UniRig hero in a thobe tears when an arm goes over the
// head or the legs part wide). So, by design: short steps, the sword arm in front and at most a little above the shoulder,
// the body turned at the waist, and the heavy leap-slash a short hop with the body lunging forward (the hop and the lunge are
// root motion: lib/behaviours/combo_attack.mjs moves the character `lunge` metres and `hop` up, the pose only bends).
// Every default move's key poses are run through the stretch check (tests/combat-moves.test.mjs, lib/rig/skin-check.mjs).
//
// A pose (lib/rig/pose.mjs) per key, written as { hips: [dx, dy, dz], aim: { <VRM bone>: [x, y, z] }, turn: { <VRM bone>:
// [yaw, pitch, roll] degrees } }, on top of STANCE (keys only say what differs). The hero faces +z, his left is +x: yaw > 0
// turns him to his left, pitch > 0 bends him forward. point: { rightHand: [x, y, z] } is where the held blade points (the
// hand turns at the wrist for it, lib/rig/pose.mjs): back and out in a wind-up, at the target through the hit. A move: { kind: 'light' | 'heavy', clip, duration (s), damage, hit:
// [start, end] normalised clip time, reach (m, past the hand), lunge (m forward), hop (m up), next (the move a buffered press
// chains to, or null), keys: [{ t (0..1), pose }] }. clip names the animation: 'procedural:<id>' is these keys; a retargeted
// clip would name its source clip (none yet). Sources and licences: lib/combat/clips.mjs.

/** The guard: sword arm low and in front, the off hand relaxed, the feet a short step apart. */
export const STANCE = {
  hips: [0, -0.02, 0],
  aim: {
    rightUpperArm: [-0.35, -0.8, 0.5], rightLowerArm: [-0.1, -0.35, 1],
    leftUpperArm: [0.3, -0.92, 0.15], leftLowerArm: [0.2, -0.7, 0.55],
    rightUpperLeg: [-0.04, -1, 0.12], rightLowerLeg: [0, -1, 0.02],
    leftUpperLeg: [0.06, -1, -0.08], leftLowerLeg: [0, -1, -0.04],
  },
  turn: { spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0] },
  point: { rightHand: [0.2, 0.5, 0.85] }, // where the sword hand's thumb side (a held blade) points: forward and up
};

const k = (t, pose = {}) => ({ t, pose });
export const DEFAULT_MOVES = {
  light1: { kind: 'light', clip: 'procedural:light1', duration: 0.5, damage: 10, hit: [0.38, 0.62], reach: 0.95, lunge: 0.25, hop: 0, next: 'light2',
    keys: [k(0), k(0.3, { aim: { rightUpperArm: [-0.8, -0.05, 0.45], rightLowerArm: [-0.5, 0.05, 0.85] }, turn: { spine: [-20, 0, 0], chest: [-10, 0, 0], neck: [15, 0, 0] }, point: { rightHand: [-0.75, 0.45, 0.35] } }),
      k(0.6, { aim: { rightUpperArm: [0.15, -0.25, 0.95], rightLowerArm: [0.6, -0.2, 0.75], rightUpperLeg: [-0.04, -0.97, 0.25] }, turn: { spine: [16, 5, 0], chest: [10, 0, 0], neck: [-15, 0, 0] }, point: { rightHand: [0.55, 0.05, 0.8] } }), k(1)] },
  light2: { kind: 'light', clip: 'procedural:light2', duration: 0.5, damage: 10, hit: [0.38, 0.62], reach: 0.95, lunge: 0.25, hop: 0, next: 'light3',
    keys: [k(0), k(0.3, { aim: { rightUpperArm: [0.2, -0.1, 0.95], rightLowerArm: [0.7, 0, 0.7] }, turn: { spine: [22, 0, 0], chest: [10, 0, 0], neck: [-15, 0, 0] }, point: { rightHand: [0.85, 0.35, 0.3] } }),
      k(0.6, { aim: { rightUpperArm: [-0.75, -0.15, 0.6], rightLowerArm: [-0.8, -0.1, 0.55], leftUpperLeg: [0.06, -0.97, 0.2] }, turn: { spine: [-25, 5, 0], chest: [-10, 0, 0], neck: [15, 0, 0] }, point: { rightHand: [-0.5, 0.05, 0.85] } }), k(1)] },
  light3: { kind: 'light', clip: 'procedural:light3', duration: 0.6, damage: 14, hit: [0.42, 0.66], reach: 1.0, lunge: 0.35, hop: 0, next: null,
    keys: [k(0), k(0.32, { aim: { rightUpperArm: [-0.55, 0.15, 0.75], rightLowerArm: [-0.3, 0.55, 0.75] }, turn: { spine: [-15, -5, 0], neck: [10, 0, 0] }, point: { rightHand: [-0.15, 0.9, -0.35] } }),
      k(0.62, { hips: [0, -0.06, 0.04], aim: { rightUpperArm: [0.2, -0.55, 0.8], rightLowerArm: [0.35, -0.6, 0.7], rightUpperLeg: [-0.04, -0.95, 0.3], rightLowerLeg: [0, -1, -0.05] }, turn: { spine: [18, 15, 0], neck: [-10, -8, 0] }, point: { rightHand: [0.1, -0.3, 0.95] } }), k(1)] },
  heavy: { kind: 'heavy', clip: 'procedural:heavy', duration: 0.95, damage: 30, hit: [0.55, 0.72], reach: 1.1, lunge: 1.4, hop: 0.35, next: null,
    keys: [k(0),
      k(0.25, { hips: [0, -0.1, -0.02], aim: { rightUpperArm: [-0.45, 0.2, 0.75], rightLowerArm: [-0.2, 0.55, 0.8], leftUpperArm: [0.4, -0.6, 0.6], rightUpperLeg: [-0.05, -0.92, 0.3], rightLowerLeg: [0, -0.95, -0.25], leftUpperLeg: [0.06, -0.92, 0.25], leftLowerLeg: [0, -0.95, -0.25] }, turn: { spine: [-10, -8, 0] }, point: { rightHand: [-0.1, 0.95, -0.2] } }),
      k(0.45, { hips: [0, 0.02, 0.05], aim: { rightUpperArm: [-0.4, 0.25, 0.75], rightLowerArm: [-0.15, 0.6, 0.75], leftUpperArm: [0.45, -0.5, 0.6], rightUpperLeg: [-0.05, -0.85, 0.4], rightLowerLeg: [0, -0.95, -0.2], leftUpperLeg: [0.06, -0.95, 0.15], leftLowerLeg: [0, -0.9, -0.35] }, turn: { spine: [-5, -5, 0] }, point: { rightHand: [-0.1, 0.9, -0.4] } }),
      k(0.65, { hips: [0, -0.12, 0.08], aim: { rightUpperArm: [0.05, -0.5, 0.85], rightLowerArm: [0.1, -0.75, 0.6], leftUpperArm: [0.4, -0.85, 0.3], rightUpperLeg: [-0.05, -0.93, 0.3], rightLowerLeg: [0, -1, 0], leftUpperLeg: [0.06, -0.97, -0.18], leftLowerLeg: [0, -0.97, -0.2] }, turn: { spine: [6, 15, 0], neck: [0, -10, 0] }, point: { rightHand: [0.05, -0.35, 0.93] } }),
      k(1)] },
};
/** Hit react and the guard (not attacks): small, within the rig's limits. */
export const REACTIONS = {
  hit: { clip: 'procedural:hit', duration: 0.35, keys: [k(0), k(0.3, { hips: [0, -0.03, -0.05], aim: { rightUpperArm: [-0.45, -0.7, 0.3], leftUpperArm: [0.5, -0.8, 0.2] }, turn: { spine: [8, -12, 0], neck: [0, -15, 0] } }), k(1)] },
};

/** Getting about between attacks: a walk cycle as a loop (u 0..1 is two steps: right foot forward at 0, left at 0.5), made
 * for the same limits (short steps, the thobe's skirt takes about 20 degrees a leg; the sword arm stays in the guard, the off
 * arm swings a little, the chest turns against the legs). lib/combat/gait.mjs blends it with the guard by the walk's speed. */
const STEP_A = { hips: [0, -0.04, 0], aim: { rightUpperLeg: [-0.04, -1, 0.34], rightLowerLeg: [0, -1, 0.1], leftUpperLeg: [0.06, -1, -0.26], leftLowerLeg: [0, -1, -0.32], leftUpperArm: [0.3, -0.9, 0.38], leftLowerArm: [0.2, -0.7, 0.6] }, turn: { spine: [-6, 2, 0], chest: [-3, 0, 0], neck: [6, 0, 0] } };
const STEP_B = { hips: [0, -0.04, 0], aim: { leftUpperLeg: [0.06, -1, 0.34], leftLowerLeg: [0, -1, 0.1], rightUpperLeg: [-0.04, -1, -0.26], rightLowerLeg: [0, -1, -0.32], leftUpperArm: [0.3, -0.95, -0.08], leftLowerArm: [0.2, -0.8, 0.4], rightUpperArm: [-0.35, -0.8, 0.44] }, turn: { spine: [6, 2, 0], chest: [3, 0, 0], neck: [-6, 0, 0] } };
export const LOCOMOTION = {
  walk: { clip: 'procedural:walk', loop: true, keys: [k(0, STEP_A),
    k(0.25, { hips: [0, 0.005, 0], aim: { rightUpperLeg: [-0.04, -1, 0.02], rightLowerLeg: [0, -1, 0], leftUpperLeg: [0.06, -1, 0.14], leftLowerLeg: [0, -0.9, -0.5] }, turn: { spine: [0, 2, 0] } }),
    k(0.5, STEP_B),
    k(0.75, { hips: [0, 0.005, 0], aim: { leftUpperLeg: [0.06, -1, 0.02], leftLowerLeg: [0, -1, 0], rightUpperLeg: [-0.04, -1, 0.14], rightLowerLeg: [0, -0.9, -0.5] }, turn: { spine: [0, 2, 0] } }),
    k(1, STEP_A)] },
};

/** Two full poses mixed: w 0 is a, 1 is b. */
export function blendPose(a, b, w) {
  const out = { hips: a.hips.map((x, j) => x + (b.hips[j] - x) * w), aim: {}, turn: {}, point: {} };
  for (const n of Object.keys(a.point || {})) out.point[n] = nlerp(a.point[n], b.point?.[n] || a.point[n], w);
  for (const n of Object.keys(a.aim)) out.aim[n] = nlerp(a.aim[n], b.aim[n] || a.aim[n], w);
  for (const n of Object.keys(a.turn)) out.turn[n] = a.turn[n].map((x, j) => x + ((b.turn[n] || a.turn[n])[j] - x) * w);
  return out;
}

export const LIGHT_CHAIN = ['light1', 'light2', 'light3'];
export const HEAVY = 'heavy';

const smooth = (t) => t * t * (3 - 2 * t);
const nlerp = (a, b, w) => { const v = a.map((x, i) => x + (b[i] - x) * w), l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

/** A key's full pose: STANCE with the key's own values on top. */
export function fullPose(p = {}, base = STANCE) {
  return { hips: p.hips || base.hips, aim: { ...base.aim, ...(p.aim || {}) }, turn: { ...base.turn, ...(p.turn || {}) }, point: { ...(base.point || {}), ...(p.point || {}) } };
}

/** The pose of `move` at normalised time u (0..1), eased between keys. */
export function poseAt(move, u) {
  const keys = move.keys, t = Math.min(1, Math.max(0, u));
  let i = 0; while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const w = b.t > a.t ? smooth(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))) : 0;
  const A = fullPose(a.pose), B = fullPose(b.pose), out = { hips: A.hips.map((x, j) => x + (B.hips[j] - x) * w), aim: {}, turn: {}, point: {} };
  for (const n of Object.keys(A.point)) out.point[n] = nlerp(A.point[n], B.point[n] || A.point[n], w);
  for (const n of Object.keys(A.aim)) out.aim[n] = nlerp(A.aim[n], B.aim[n], w);
  for (const n of Object.keys(A.turn)) out.turn[n] = A.turn[n].map((x, j) => x + (B.turn[n][j] - x) * w);
  return out;
}

/** A move pose as lib/rig/pose.mjs takes it. */
export function toRigPose(p) {
  const bones = {};
  for (const [n, v] of Object.entries(p.aim)) bones[n] = { aim: v };
  for (const [n, [yaw, pitch, roll]] of Object.entries(p.turn)) if (yaw || pitch || roll) bones[n] = { rot: [[0, 1, 0, yaw], [1, 0, 0, pitch], [0, 0, 1, roll]] };
  for (const [n, v] of Object.entries(p.point || {})) bones[n] = { ...(bones[n] || {}), point: v };
  return { hips: p.hips, bones };
}

/** The key poses a move is checked at: each key, and the middle of each span. */
export function keyPoses(move) {
  const out = [];
  move.keys.forEach((key, i) => { out.push({ t: key.t, pose: poseAt(move, key.t) }); if (i < move.keys.length - 1) { const m = (key.t + move.keys[i + 1].t) / 2; out.push({ t: m, pose: poseAt(move, m) }); } });
  return out;
}

/** Problems with a move list (the behaviour's own data): [] when sound. */
export function moveErrors(moves) {
  const e = [];
  for (const [id, m] of Object.entries(moves)) {
    if (!['light', 'heavy'].includes(m.kind)) e.push(`${id}: kind light or heavy`);
    if (!(m.duration > 0)) e.push(`${id}: duration > 0`);
    if (!(Array.isArray(m.hit) && m.hit[0] >= 0 && m.hit[0] < m.hit[1] && m.hit[1] <= 1)) e.push(`${id}: hit window 0 <= start < end <= 1`);
    for (const f of ['damage', 'reach', 'lunge']) if (!(m[f] >= 0)) e.push(`${id}: ${f} >= 0`);
    if (m.next !== null && !moves[m.next]) e.push(`${id}: next "${m.next}" is not a move`);
    if (!Array.isArray(m.keys) || m.keys[0]?.t !== 0 || m.keys.at(-1)?.t !== 1) e.push(`${id}: keys from t 0 to t 1`);
  }
  return e;
}
