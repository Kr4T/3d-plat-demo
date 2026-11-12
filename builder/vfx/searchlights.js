// searchlights.js: the searchlights component's module (effect). r187 example: webgpu_volume_lighting (the idea: a soft
// shaft of light), as Boulevard City's beams (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/vfx/searchlights.js
// makeSearchlights, swayed by main.js 1579, shown by main.js 1200). Boulevard's beam, unchanged: one open cone 24 m wide and
// 900 m tall per beam, its tip at the lamp, every beam in one additive InstancedMesh drawn in a single pass (both faces),
// brightest where it faces the camera, fading with height and in over its first 18 m, on at night (uNight), hidden in
// daylight (main.js 1200: visible while day < 0.75). Each beam sways on its own phase (k x 1.7): rotation
// (sin(n 0.00021 + ph) 0.35, 0, cos(n 0.00017 + ph 1.3) 0.35) with n the time in milliseconds.
// Boulevard put the beams on the tallest screen buildings, 1 m above each roof; here each piece is a row 4 m apart, 1 m above
// the piece's ground, and every piece of the scene shares the one InstancedMesh (as Boulevard's six beams did; spec §5.3:
// one draw per component). Params (`affects: "effect"`: per instance, never a new draw), Boulevard's values by default:
// `colour` (vec3(0.78, 0.85, 1.0) in linear light: #e5edff; per beam through the instance colour), `sweep` (0.35 rad),
// `count` (Boulevard lights six).
// The sway reads the TSL clock: an OnBeforeObjectUpdate event node in the beam material gets the renderer's NodeFrame before
// the beams are drawn and sets the instance matrices from its `time` (Boulevard read the wall clock in its frame loop), so the
// gate's frozen bench clock holds both renders at one instant, and the motion check sees the beams move.
// Contract: build(params, ctx) -> { object, collider, effect: { create() } } (lib/runtime/scene-view.mjs): one effect per
// component; set([{ uid, matrix, params }]) gives it every instance; the beams carry userData.uids (one per beam) for picking.
import { vec3, smoothstep, normalView, positionLocal, uniform, Fn, OnBeforeObjectUpdate } from 'three/tsl';

export const MODULE = 'builder/vfx/searchlights.js';
export const ROW = Object.freeze({ spacing: 4, lift: 1 }); // m: beams 4 m apart, the lamps 1 m up (Boulevard: bH + 1)
export const DAYLIGHT = 0.75; // main.js 1200: beams shown while day < 0.75

/** Where each beam stands, in the piece's frame: a row along x, centred. */
export function beamPositions(count) {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, (_, i) => [(i - (n - 1) / 2) * ROW.spacing, ROW.lift, 0]);
}

/** Every searchlight piece's beams in one InstancedMesh (Boulevard's makeSearchlights, per instance row and params). */
function createBeams(ctx) {
  const { THREE } = ctx;
  const env = ctx.environment || null;
  const uNight = env?.night || uniform(1); // the stage's night term (Boulevard uNight); none: night
  const geometry = new THREE.ConeGeometry(24, 900, 24, 1, true).translate(0, -450, 0).rotateX(Math.PI);
  const dummy = new THREE.Object3D(), local = new THREE.Matrix4(), colour = new THREE.Color();
  let beams = [], im = null, capacity = 0;
  const sway = (frame) => { // main.js 1579, with n from the TSL clock
    const n = frame.time * 1000;
    beams.forEach((b, i) => {
      dummy.position.copy(b.pos); dummy.rotation.set(Math.sin(n * 0.00021 + b.ph) * b.sweep, 0, Math.cos(n * 0.00017 + b.ph * 1.3) * b.sweep); dummy.updateMatrix();
      im.setMatrixAt(i, local.multiplyMatrices(b.matrix, dummy.matrix));
    });
    im.instanceMatrix.needsUpdate = true; im.boundingSphere = null; im.boundingBox = null;
  };
  const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  bm.fog = false; bm.forceSinglePass = true; // additive blending is order-free, so one pass draws both faces (one draw)
  bm.name = 'searchlight beam';
  const along = positionLocal.y.div(900).clamp(0, 1); // 0 at the lamp, 1 at the top of the cone (the cone is flipped, so local y runs up)
  const soft = normalView.z.abs().pow(2.0); // faces toward the camera: the core; grazing faces: the soft edge
  bm.colorNode = Fn(() => { OnBeforeObjectUpdate(sway); return vec3(1); })(); // x the instance colour (the `colour` param)
  bm.opacityNode = uNight.mul(0.07).mul(soft).mul(along.oneMinus().pow(1.6)).mul(smoothstep(0.0, 0.02, along));
  const object = new THREE.Group(); object.name = 'searchlights'; object.userData.vfx = { module: MODULE };
  const upright = () => beams.forEach((b, i) => { dummy.position.copy(b.pos); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); im.setMatrixAt(i, local.multiplyMatrices(b.matrix, dummy.matrix)); });
  return {
    object, layer: 'scene',
    get mesh() { return im; },
    /** The sway at a NodeFrame (what the material's event runs before each draw). */
    pose: (frame) => { if (im) sway(frame); },
    /** Every searchlight piece: [{ uid, matrix (Matrix4), params }]. */
    set(list) {
      beams = [];
      for (const it of list) beamPositions(it.params.count).forEach((p, k) => beams.push({ uid: it.uid, matrix: (it.matrix || new THREE.Matrix4()).clone(), pos: new THREE.Vector3(...p), ph: k * 1.7, sweep: it.params.sweep, colour: it.params.colour }));
      if (!im || capacity < beams.length) {
        if (im) { im.removeFromParent(); im.dispose(); }
        capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, beams.length)))); // at least 64: a new InstancedMesh is a new shader build (lib/runtime/scene-view.mjs MIN_CAPACITY)
        // one instanced draw for all the beams; each beam sways on its own phase (matrices set before each draw)
        im = new THREE.InstancedMesh(geometry, bm, capacity);
        im.frustumCulled = false; im.renderOrder = 2; im.name = 'searchlight beams';
        object.add(im);
      }
      im.count = beams.length;
      beams.forEach((b, i) => im.setColorAt(i, colour.set(b.colour)));
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      upright(); // upright until the first frame, as makeSearchlights
      im.instanceMatrix.needsUpdate = true; im.boundingSphere = null; im.boundingBox = null;
      im.userData.vfx = { module: MODULE, beams: beams.length, phases: beams.map((b) => b.ph) };
      im.userData.uids = beams.map((b) => b.uid); // picking: a beam names its piece
    },
    /** Before each render: shown at night only (main.js 1200). */
    frame() { if (im) im.visible = !((env?.day?.value ?? 0) >= DAYLIGHT); },
    dispose() { if (im) { im.removeFromParent(); im.dispose(); } geometry.dispose(); bm.dispose(); object.removeFromParent(); },
  };
}

export function build(params, ctx) {
  const { THREE } = ctx;
  // an effect has no prop: the beams are drawn by the component's one effect, for every instance
  const object = new THREE.Group(); object.name = 'searchlights';
  const at = beamPositions(params.count), half = (at.length - 1) * ROW.spacing / 2 + 0.5;
  return {
    object,
    // the lamps' keep-out: a sensor round the row (the beams have no body; Boulevard's stood on roofs)
    collider: [{ type: 'cuboid', pos: [0, ROW.lift / 2, 0], half: [half, ROW.lift / 2, 0.5], sensor: true }],
    effect: { create: () => createBeams(ctx) },
  };
}
