// equippable.mjs: the `equippable` behaviour (behaviours/equippable/behaviour.json; targets character, needs a rig:
// lib/combat/requires.mjs). The item (a weapon or decor component) is held in a hand:
//   - its grip is measured from its own mesh (lib/combat/grip.mjs: the hilt beside the guard, the blade's direction and flat)
//     and the hand's frame from the rig at rest (lib/rig/hand.mjs: along the fingers, the thumb across); the blade leaves the
//     fist on the thumb side, its edge leading with the knuckles; the params' offsets (metres, in the hand's frame) and turns
//     (degrees about the hand's x, y, z) adjust that
//   - in Play the character is drawn as a skinned actor (lib/runtime/actors.mjs) and the item is parented to the hand bone, so
//     it follows every animation; in the editor the item stands at the rest-pose hand of the static piece (the same mesh)
//   - equip and unequip are the patch pipeline's set_behaviour / remove_behaviour (one undo step each)
// handle: { uid, item, ready (Promise), weaponSegment() -> { a: grip, b: tip } world metres | null, refused }
import * as THREE from 'three';
import { combatWorld } from '../combat/world.mjs';
import { needsError } from '../combat/requires.mjs';
import { measureGrip } from '../combat/grip.mjs';
import { handFrame } from '../rig/hand.mjs';
import { toRigPose } from '../combat/moves.mjs';

async function defaultLoad(url) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
}
const D2R = Math.PI / 180;

/** The held item's matrix in the character's rest model space: hand frame x adjust x inverse(grip frame). */
export function heldMatrix(frame, grip, p = {}) {
  const x = new THREE.Vector3(...frame.x), y = new THREE.Vector3(...frame.y), z = new THREE.Vector3(...frame.z);
  const origin = new THREE.Vector3(...frame.palm).addScaledVector(x, p.offsetAlong || 0).addScaledVector(z, p.offsetSide || 0).addScaledVector(y, p.offsetPalm || 0);
  const H = new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
  const A = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler((p.pitch || 0) * D2R, (p.yaw || 0) * D2R, (p.roll || 0) * D2R, 'XYZ'));
  let e = new THREE.Vector3(...grip.edge); const f = new THREE.Vector3(...grip.flat), b = new THREE.Vector3(...grip.blade);
  if (new THREE.Vector3().crossVectors(e, f).dot(b) < 0) e = e.negate(); // a right-handed grip frame, as the hand's
  const G = new THREE.Matrix4().makeBasis(e, f, b).setPosition(new THREE.Vector3(...grip.center));
  return H.multiply(A).multiply(G.invert());
}

export function attach(ctx, item, params = {}) {
  const w = combatWorld(ctx);
  const why = needsError(ctx.registry, item, 'equippable');
  if (why) { w.notice(why); return { uid: item.uid, refused: why, ready: Promise.resolve(null), weaponSegment: () => null, dispose() {} }; }
  const load = ctx.loadGLB || defaultLoad;
  let p = { ...params }, held = null, grip = null, actor = null, inHand = false, shown = false, disposed = false, frames = {};
  const group = new THREE.Group(); group.name = `equippable ${item.uid}`; group.matrixAutoUpdate = false;
  const itemDef = () => (ctx.registry?.list?.() || []).find((d) => d.id === p.item && !d.superseded_by) || null;
  async function loadItem() {
    const def = itemDef(); if (!def) throw new Error(`equippable: no component "${p.item}"`);
    const key = ctx.stage?.preset === 'phone' && def.files.lod1 ? 'lod1' : 'lod0';
    const gltf = await load(new URL(def.files[key], def.dir).href);
    const obj = gltf.scene.clone(true); obj.updateMatrixWorld(true);
    const pts = []; const v = new THREE.Vector3();
    obj.traverse((o) => { if (!o.isMesh) return; o.castShadow = true; const pos = o.geometry.attributes.position; for (let i = 0; i < pos.count; i += 2) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts.push(v.x, v.y, v.z); } });
    grip = measureGrip(Float32Array.from(pts));
    // the item's own size param scales it as the scene view would (height affects scale); the kit's scimitar is at default
    return obj;
  }
  function place() {
    if (!held || !actor || disposed) return;
    const side = p.bone === 'leftHand' ? 'left' : 'right';
    frames[side] ||= handFrame(actor.joints(), side, { map: actor.rig.map });
    const M = heldMatrix(frames[side], grip, p); // rest model space
    group.clear(); group.add(held);
    if (inHand) {
      const bone = actor.bone(p.bone);
      // the bone's rest matrix in model space, kept by lib/rig/pose.mjs on first use (rest.wq / rest.wp) via actor.joints()
      actor.rest(); actor.object.updateMatrixWorld(true);
      const rootInv = new THREE.Matrix4().copy(actor.object.matrixWorld).invert();
      const boneRest = rootInv.multiply(bone.matrixWorld);
      group.matrix.copy(boneRest.invert().multiply(M));
      bone.add(group);
    } else {
      // the editor: under the item's anchor, at the static piece's rest-pose hand
      const anchor = ctx.view?.objectOf?.(item.uid); if (!anchor) return;
      const k = actor.object.scale.x || 1;
      group.matrix.copy(new THREE.Matrix4().makeScale(k, k, k).multiply(M));
      anchor.add(group);
    }
    group.matrixWorldNeedsUpdate = true;
  }
  // the item may not be drawn yet when the behaviour attaches (behaviours.sync runs while the view still loads a big scene:
  // found on the Encore world on a real GPU, where the scimitar never came): setup() finds no anchor then and gives up
  // quietly; update() runs it again once the view has drawn the item, and re-places the scimitar when a redraw gave the
  // item a new anchor
  let setting = null;
  function setup() {
    return (setting ||= (async () => {
      const actors = await w.actors(); if (!actors || disposed) return null;
      actor = await actors.ensure(item.uid); if (!actor || disposed) return null;
      actors.attach(actor); // sized (its scale) even while hidden
      held ||= await loadItem();
      place();
      return handle;
    })().catch((e) => { console.error('equippable', e); w.notice({ en: `Equippable: ${e.message}`, ar: `قابل للتجهيز: ${e.message}` }); return null; }).finally(() => { setting = null; }));
  }
  const ready = setup();

  const handle = {
    uid: item.uid, item: () => p.item, ready, group,
    grip: () => grip,
    /** The blade in world metres: from the grip to the tip (the hit sweep's segment), or null when nothing is held. */
    weaponSegment() {
      if (!held || !grip || !group.parent) return null;
      group.updateWorldMatrix(true, false);
      const a = new THREE.Vector3(...grip.center).applyMatrix4(group.matrixWorld), b = new THREE.Vector3(...grip.tip).applyMatrix4(group.matrixWorld);
      return { a: a.toArray(), b: b.toArray() };
    },
    get inHand() { return inHand; },
    update(dt = 0) {
      const anchor = ctx.view?.objectOf?.(item.uid) || null;
      if (!actor) { if (anchor && !setting && !disposed) setup(); return; } // drawn now: set up
      if (!held) return;
      if (anchor && !inHand && group.parent !== anchor) place(); // a redraw made a new anchor (or the first one)
      if (anchor && inHand && actor.object.parent !== anchor) w.actors().then((actors) => { if (!disposed && actor.object.parent !== ctx.view.objectOf(item.uid)) actors.attach(actor); });
      const want = w.playing();
      if (want !== inHand) {
        inHand = want;
        w.actors().then((actors) => { if (disposed) return; if (want) actors.show(item.uid).then(() => { place(); shown = !disposed && inHand; }); else { shown = false; actors.hide(item.uid); place(); } });
      }
      // armed without Combo attack: the actor still stands in the guard and walks (combo_attack poses him when he has it)
      if (inHand && shown && !ctx.behaviours?.get?.(item.uid, 'combo_attack')?.handle?.update && !ctx.behaviours?.get?.(item.uid, 'hit_reaction')?.handle?.flinching?.()) actor.pose(toRigPose(w.idlePose(item.uid, dt)));
    },
    onParams(next) {
      const itemChanged = next.item !== p.item; p = { ...next };
      if (itemChanged) { group.clear(); held = null; loadItem().then((o) => { held = o; place(); }).catch((e) => w.notice({ en: `Equippable: ${e.message}`, ar: `قابل للتجهيز: ${e.message}` })); } else place();
    },
    dispose() { disposed = true; group.removeFromParent(); group.clear(); if (actor) w.actors().then((a) => a?.hide(item.uid)); },
  };
  return handle;
}
