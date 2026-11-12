// pose.mjs: a pose as data, put on a three.js skeleton. Used by the rig check (tools/rig-check.mjs, tests/e2e/rig-check.mjs)
// and by the procedural move system. A pose: { hips: [dx, dy, dz] metres in the model's space, bones: { <VRM or joint name>:
// { rot: [[ax, ay, az, degrees], ...] } | { aim: [x, y, z] } } }.
//   rot  turns the bone about axes in the model's space (y up, the character facing +z, his left at +x), on top of what its
//        parents did: a thigh swung 40 deg forward and its shin 70 deg back leaves the shin 30 deg back of straight down
//   aim  turns the bone so it points to its child (AIM_CHILD) along the direction given, in the model's space
//   point  on a hand: the direction, in the model's space, its thumb side should point (where a held blade points:
//        lib/rig/hand.mjs, z). An aim leaves the roll of the arm open, so a held sword pointed wherever the shortest turn
//        left it (across the body, seen in the close shots of 12 Nov). The hand turns at the wrist towards it, up to
//        WRIST_MAX. Rolling the forearm bone as well was measured and dropped: on the UniRig hero it tears the skin at
//        the elbow (heavy strike 139 -> 158 torn edges at a 100 degree roll, 150 at 30), the wrist alone adds none.
// "The model's space" is the frame of `space` (the model's root object: the actor's cloned scene, lib/runtime/actors.mjs),
// so a character turned, moved or sized in the world keeps the pose in his own frame (found by eye on 12 Nov: the plaza
// hero stands at yaw pi and held the sword behind his back, because the directions were taken as the world's). Without
// `space` the world is the model's space (the rig check and the stretch check pose a model at the origin).
// The bones are posed from the root down, each from its rest pose (so a pose is absolute, not added to the last one). Rest
// poses are kept on first use (bone.userData.rest). Built on the r187 examples webgpu_skinning (a GLTFLoader SkinnedMesh) and
// webgl_animation_skinning_additive_blending (bones driven by quaternions in their parent's space).
import { Quaternion, Vector3 } from 'three';
import { handFrame } from './hand.mjs';

export const WRIST_MAX = 110; // degrees: how far a hand turns at the wrist towards a `point`

export const AIM_CHILD = {
  leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
  leftFoot: 'leftToes', rightFoot: 'rightToes', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
};

const _q = new Quaternion(), _q2 = new Quaternion(), _v = new Vector3(), _v2 = new Vector3();

function keepRest(bones) {
  for (const b of bones) if (!b.userData.rest) {
    b.userData.rest = { q: b.quaternion.clone(), p: b.position.clone(), wq: new Quaternion(), wp: new Vector3() };
  }
}

/** Resets the skeleton to its rest pose (the bind pose UniRig wrote). */
export function restPose(skeleton) {
  keepRest(skeleton.bones);
  for (const b of skeleton.bones) { b.quaternion.copy(b.userData.rest.q); b.position.copy(b.userData.rest.p); }
  skeleton.bones[0]?.parent?.updateMatrixWorld(true);
  for (const b of skeleton.bones) b.updateMatrixWorld(true);
}

/** Puts `pose` on `skeleton`. map: VRM name -> joint name (lib/rig/humanoid.mjs humanoidMap); unknown names are joint names. */
export function applyPose(skeleton, map, pose, space = null) {
  restPose(skeleton);
  const sq = new Quaternion(), ss = new Vector3(1, 1, 1);
  if (space) { space.updateWorldMatrix(true, false); space.matrixWorld.decompose(new Vector3(), sq, ss); }
  const toWorld = (v) => v.applyQuaternion(sq); // a direction of the model's space, in the world
  const root = skeleton.bones[0]?.parent;
  for (const b of skeleton.bones) { b.getWorldQuaternion(b.userData.rest.wq); b.getWorldPosition(b.userData.rest.wp); }
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
  const bone = (k) => byName.get(map?.[k] ?? k) || null;
  const want = new Map();
  for (const [k, v] of Object.entries(pose.bones || {})) { const b = bone(k); if (b) want.set(b, { ...v, key: k }); }
  const inv = new Map(); // child joint for aim
  for (const [k, c] of Object.entries(AIM_CHILD)) { const b = bone(k), cb = bone(c); if (b && cb) inv.set(b, cb); }
  // hands that point: the thumb-side axis of each at rest (in the world, as the rest positions are), for the forearm and the hand
  const point = new Map();
  for (const [k, v] of Object.entries(pose.bones || {})) {
    if (!v.point) continue;
    const h = bone(k), side = /^left/.test(k) ? 'left' : 'right'; if (!h) continue;
    let axis;
    try {
      const joints = skeleton.bones.map((b) => ({ name: b.name, parent: byName.get(b.parent?.name) === b.parent ? b.parent.name : null, p: b.userData.rest.wp.toArray() }));
      axis = new Vector3(...handFrame(joints, side, { map }).z);
    } catch { continue; } // a hand without a thumb chain cannot say where it points
    const rec = { axis, dir: toWorld(new Vector3().fromArray(v.point).normalize()) };
    point.set(h, rec);
  }
  if (pose.hips) {
    const h = bone('hips') || skeleton.bones[0];
    const wp = h.getWorldPosition(new Vector3()).add(toWorld(_v.fromArray(pose.hips).multiply(ss))); // metres in the model's space
    h.position.copy(h.parent ? h.parent.worldToLocal(wp) : wp);
  }
  // root to leaves: the bones array is not in hierarchy order, so walk the tree
  const order = []; const visit = (o) => { if (byName.get(o.name) === o) order.push(o); for (const c of o.children) visit(c); };
  for (const b of skeleton.bones) if (!b.parent || byName.get(b.parent.name) !== b.parent) visit(b);
  for (const b of order) {
    const w = want.get(b), pt = point.get(b);
    if (!w) { b.updateMatrixWorld(true); continue; }
    const pw = new Quaternion(); if (b.parent) b.parent.getWorldQuaternion(pw);
    const pr = b.parent?.userData.rest ? b.parent.userData.rest.wq : (b.parent ? pw : new Quaternion());
    const delta = pw.clone().multiply(pr.clone().invert()); // what the parents turned, in world
    const world = delta.clone().multiply(b.userData.rest.wq);
    if (w?.rot) for (const [ax, ay, az, deg] of w.rot) { _q.setFromAxisAngle(toWorld(_v.set(ax, ay, az).normalize()), (deg * Math.PI) / 180); world.premultiply(_q); }
    else if (w?.aim) {
      const c = inv.get(b) || b.children.find((x) => byName.get(x.name) === x);
      if (c) {
        b.updateMatrixWorld(true);
        const from = _v.copy(c.userData.rest?.wp || c.getWorldPosition(new Vector3())).sub(b.userData.rest.wp).applyQuaternion(delta).normalize();
        _q.setFromUnitVectors(from, toWorld(_v2.fromArray(w.aim).normalize()));
        world.premultiply(_q);
      }
    }
    if (pt) { // the hand turns at the wrist, up to its limit
      const cur = pt.axis.clone().applyQuaternion(world.clone().multiply(b.userData.rest.wq.clone().invert()));
      _q.setFromUnitVectors(cur, pt.dir);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(_q.w))), lim = (WRIST_MAX * Math.PI) / 180;
      if (ang > lim) _q2.identity().slerp(_q, lim / ang); else _q2.copy(_q);
      world.premultiply(_q2);
    }
    b.quaternion.copy(pw.invert().multiply(world));
    if (root) b.updateMatrixWorld(true);
  }
  for (const b of order) b.updateMatrixWorld(true);
}

const R = (ax, ay, az, deg) => [ax, ay, az, deg];
/** The rig check's test poses (coordinator, 12 Nov 2026). The hero faces +z with his left at +x. */
export const HERO_TEST_POSES = {
  rest: { bones: {} },
  armsForward: { bones: {
    leftUpperArm: { aim: [0.25, 0.75, 1] }, leftLowerArm: { aim: [0.1, 0.6, 1] },
    rightUpperArm: { aim: [-0.25, 0.75, 1] }, rightLowerArm: { aim: [-0.1, 0.6, 1] },
  } },
  lunge: { hips: [0, -0.32, 0.05], bones: {
    rightUpperLeg: { aim: [-0.08, -0.35, 1] }, rightLowerLeg: { aim: [0, -1, -0.05] }, rightFoot: { aim: [0, -0.25, 1] },
    leftUpperLeg: { aim: [0.08, -0.55, -0.85] }, leftLowerLeg: { aim: [0, -0.3, -1] }, leftFoot: { aim: [0, -0.9, -0.4] },
    spine: { rot: [R(1, 0, 0, 12)] },
  } },
  twist: { bones: {
    spine: { rot: [R(0, 1, 0, 22)] }, chest: { rot: [R(0, 1, 0, 18)] }, upperChest: { rot: [R(0, 1, 0, 14)] },
    neck: { rot: [R(0, 1, 0, -20)] },
  } },
  slash: { hips: [0, -0.12, 0], bones: {
    spine: { rot: [R(0, 1, 0, -25), R(1, 0, 0, 10)] }, chest: { rot: [R(0, 1, 0, -15)] },
    rightUpperArm: { aim: [-0.35, 0.85, 0.45] }, rightLowerArm: { aim: [0.15, 0.95, 0.35] }, rightHand: { rot: [R(1, 0, 0, -30)] },
    leftUpperArm: { aim: [0.55, -0.1, 0.85] }, leftLowerArm: { aim: [0.3, 0.1, 1] },
    rightUpperLeg: { aim: [-0.1, -0.85, 0.5] }, rightLowerLeg: { aim: [0, -1, -0.15] },
    leftUpperLeg: { aim: [0.1, -0.9, -0.4] }, leftLowerLeg: { aim: [0, -0.9, -0.45] },
  } },
};

/** The horse's and the camel's test poses: a front leg lifted (knee folded) and the neck bent down and to the side. Their
 * joints are generic (UniRig), so these name joints; the chains were read from the rig's bone positions (tools/rig-check.mjs
 * prints them): horse front left bone_11..14, neck bone_5..7; camel front left bone_19..21, neck bone_13..16. */
export const ANIMAL_TEST_POSES = {
  horse: {
    rest: { bones: {} },
    legLift: { bones: { bone_11: { rot: [R(1, 0, 0, -45)] }, bone_12: { rot: [R(1, 0, 0, 95)] }, bone_13: { rot: [R(1, 0, 0, 20)] } } },
    neckBend: { bones: { bone_5: { rot: [R(1, 0, 0, 25), R(0, 1, 0, 20)] }, bone_6: { rot: [R(1, 0, 0, 20), R(0, 1, 0, 15)] }, bone_7: { rot: [R(1, 0, 0, 15)] } } },
  },
  camel: {
    rest: { bones: {} },
    legLift: { bones: { bone_19: { rot: [R(1, 0, 0, -45)] }, bone_20: { rot: [R(1, 0, 0, 95)] }, bone_21: { rot: [R(1, 0, 0, 20)] } } },
    neckBend: { bones: { bone_14: { rot: [R(1, 0, 0, 25), R(0, 1, 0, 20)] }, bone_15: { rot: [R(1, 0, 0, 20), R(0, 1, 0, 15)] }, bone_16: { rot: [R(1, 0, 0, 15)] } } },
  },
};
