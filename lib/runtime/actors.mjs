// actors.mjs: rigged characters drawn as skinned meshes while a behaviour needs the rig (equippable, combo_attack, hit_reaction).
// The scene view draws every character as an instanced static mesh (lib/runtime/scene-view.mjs); a component whose
// `slots.rig` names skinned variants (tools/rig-variants.mjs) can be swapped for an actor: its rigged GLB loaded once per LOD
// and cloned per item with SkeletonUtils.clone (r187 webgpu_skinning_instancing_individual / webgpu_animation_retargeting
// clone the same way), parented to the item's anchor (so the walk's view.place moves it), sized by the item's size params
// (scaleOf), and the item's instanced copy hidden (view.hide) while it shows. Skinning runs on the GPU as normal.
// Phone draws lod1 (30k triangles, as the static piece), High lod0. The actor's materials are the file's own (the static
// piece's auto-r187 recipe is not applied to it yet: docs/NEXT.md).
//   const actors = createActors({ stage, view, registry, load? });  const a = await actors.show(uid);  a.pose(rigPose);
//   a.bone('rightHand'); a.joints(); actors.hide(uid); actors.get(uid)
import * as THREE from 'three';
import { applyPose, restPose } from '../rig/pose.mjs';
import { scaleOf } from './scene-view.mjs';

async function defaultLoad(url) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
}

export function createActors({ stage, view, registry, load = defaultLoad, clone = null } = {}) {
  const files = new Map(); // url -> Promise<gltf>
  const live = new Map(); // uid -> actor
  const pending = new Map(); // uid -> Promise<actor>
  const preset = () => stage?.preset || (stage?.isPhone ? 'phone' : 'high');
  let skeletonClone = clone;
  async function cloneOf(scene) {
    if (!skeletonClone) { const m = await import('three/addons/utils/SkeletonUtils.js'); skeletonClone = m.clone; }
    return skeletonClone(scene);
  }
  function itemOf(uid) { const anchor = view.objectOf?.(uid); return anchor ? { anchor, ...anchor.userData } : null; }
  async function make(uid) {
    const it = itemOf(uid); if (!it) return null;
    const def = registry.get?.(it.ref); const rig = def?.slots?.rig;
    if (!rig) return null;
    const key = preset() === 'phone' && rig.files.lod1 ? 'lod1' : 'lod0';
    const url = new URL(rig.files[key], def.dir).href;
    if (!files.has(url)) files.set(url, load(url).catch((e) => { files.delete(url); throw e; }));
    const gltf = await files.get(url);
    const root = await cloneOf(gltf.scene);
    let mesh = null; root.traverse((o) => { if (o.isSkinnedMesh) { mesh = o; o.frustumCulled = false; o.castShadow = true; } });
    if (!mesh) throw new Error(`${it.ref}: the rig file has no skinned mesh`);
    root.name = `actor ${uid}`;
    const byName = new Map(mesh.skeleton.bones.map((b) => [b.name, b]));
    const actor = {
      uid, ref: it.ref, def, rig, object: root, mesh, skeleton: mesh.skeleton, lod: key, rootOffset: new THREE.Vector3(),
      bone: (vrm) => byName.get(rig.map[vrm] || vrm) || null,
      /** Joints at rest in the model's space, as lib/rig/humanoid.mjs takes them. */
      joints() {
        restPose(mesh.skeleton); root.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
        return mesh.skeleton.bones.map((b) => ({ name: b.name, parent: byName.get(b.parent?.name) === b.parent ? b.parent.name : null, p: b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).toArray() }));
      },
      pose(p) { applyPose(mesh.skeleton, rig.map, p, root); }, // in the actor's own frame, wherever the item stands and faces
      rest() { restPose(mesh.skeleton); },
      setVisible(on) { root.visible = on; view.hide?.(uid, on); },
    };
    actor.joints(); // rest pose kept on the bones
    return actor;
  }
  const api = {
    get: (uid) => live.get(uid) || null,
    list: () => [...live.values()],
    /** Can this item be shown as an actor (its component has a rig)? */
    rigged(uid) { const it = itemOf(uid); return !!(it && registry.get?.(it.ref)?.slots?.rig); },
    /** The actor loaded (its rest joints and bones), not shown: equippable measures the hand from it in the editor. */
    async ensure(uid) {
      if (live.has(uid)) return live.get(uid);
      if (!pending.has(uid)) pending.set(uid, make(uid).then((a) => { if (a) { live.set(uid, a); a.object.visible = false; } return a; }).finally(() => pending.delete(uid)));
      return pending.get(uid);
    },
    async show(uid) {
      const a = await api.ensure(uid);
      if (!a) return null;
      api.attach(a); a.setVisible(true);
      return a;
    },
    /** Re-parents the actor to its item's anchor (after a sync made a new one) and sizes it by the item's size params. */
    attach(a) {
      const it = itemOf(a.uid); if (!it) return;
      if (a.object.parent !== it.anchor) it.anchor.add(a.object);
      const k = scaleOf(a.def, it.params || {});
      a.object.scale.setScalar(k);
      a.object.position.copy(a.rootOffset);
    },
    hide(uid) { const a = live.get(uid); if (a) { a.setVisible(false); a.rest(); } },
    shown: (uid) => !!live.get(uid)?.object.visible,
    dispose() { for (const a of live.values()) { a.setVisible(false); a.object.removeFromParent(); } live.clear(); },
  };
  return api;
}
