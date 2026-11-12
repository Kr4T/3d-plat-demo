// scene-view.mjs: draws a uew-scene@1 document (its `areas` and `instances`) on a Stage from the components registry.
// r187 examples: webgpu_loader_gltf (GLTFLoader parse of each mesh component's LOD files), webgl_instancing_scatter and
// webgpu_instance_mesh (one InstancedMesh per geometry, per-instance values beside the matrix), webgpu_instance_uniform
// (a per-instance value read by the material: here InstancedBufferAttributes `inst_<param>`), webgpu_lights_clustered_city
// (createInstances: one InstancedMesh per piece, setColorAt-style per-instance colour; lights handed to the light rig)
// and webgpu_generator_city (generator components build their shape once and are instanced, as the city generators do).
// Instancing (spec §5.3): one InstancedMesh per component ref per LOD (per set of shape params: instances that differ only
// in a colour, a material number, a light value or a size share it). A piece's meshes are merged into one geometry with one
// group per material slot. A number param with `affects: "scale"` scales the instance by value / default (the files are
// made at the default: Boulevard gives each palm its own scale through the instance matrix the same way); colliders scale
// with it, and scaleOf() gives the factor for the footprint. LODs per preset from component.json `draw` (which LODs, the
// distances where each hands over, which cast shadows), else every LOD at Phone 30 m / High 60 m steps, all casting.
// Effects (Task 9; r187 webgpu_compute_particles: a particle system is its own object with its own compute pass): a
// generator's build() may also return `effect: { create({ renderer, camera }) -> { object, layer: 'scene' | 'fx',
// set([{ uid, matrix, params }]), frame(), dispose() } }`. One effect per component draws every instance of it (Task 9
// review: one draw per component, spec §5.3): set() gets each instance's matrix and params after every sync, frame() runs
// before each render (a compute step, a sway). It lives in the main scene ('scene') or the stage's effects layer ('fx':
// stage.fxScene, composited after the main pass, as Boulevard draws its particles). Params with `affects: "effect"` reach
// only the effect, per instance, and never split the instancing. An effect's InstancedMesh with userData.uids (one uid per
// instance) is pickable. build() may also return `features` (what the piece draws on this preset, e.g. the fountain's spray:
// features(uid)). An effect-only piece may build an object with no mesh.
// Layout (dunes round, 11 Nov 2026): a generator whose module exports `usesLayout = true` (the desert terrain) gets
// ctx.layout, where the scene's other pieces stand (lib/scene/layout.mjs: areas, paths and footprints in world metres,
// without ground areas and without its own instances), and is rebuilt when they move. The first build of a piece is awaited
// by sync(); a rebuild for a changed layout runs after sync() returns (the old terrain stays drawn meanwhile, so a drag stays
// smooth: the module builds in slices between frames) and is swapped in when done, newest layout wins (a rebuild finished on
// the way to it is drawn while a newer one is still coming); settled() resolves when no rebuild is pending. Such a piece is
// its own batch (keyed by uid and transform), and its layout is in its own frame, so a moved or turned area keeps its zones.
// ctx.slot(name, extra) also takes preset values from the module itself (the terrain's wind for the sand's ripples).
// Talk (12 Nov 2026, lib/talk/): a mesh piece that the talk behaviour targets (behaviours/talk/behaviour.json: characters) gets the
// shader path on every LOD's material (lib/talk/talk-node.mjs: a head nod and sway in the vertex stage, masked by height) and
// a vec4 instance attribute `inst_talk` (amplitude, cos yaw, sin yaw, scale), zero except for the piece that talks:
// setTalk(uid, amplitude) writes it each frame, so a talking piece adds no draw. talk(uid) says where its mouth is (for the
// PositionalAudio) and which motion path its file offers (lib/talk/motion.mjs chooseMotion on the lod0 file). The view draws
// pieces instanced from merged static geometry (collect() drops morphs, skinning is not kept), so a file with a jaw bone or a
// mouth morph is reported as such but drawn with the shader path until the view draws rigged pieces (docs/NEXT.md, Talk).
// Behaviours (lib/behaviours/, the shared contract of 12 Nov 2026) attach to pieces through objectOf(uid) (the anchor, kept
// across syncs) and scaleOf(uid) (the size params' factor); the sand trail reads the anchor's world matrix every frame.
// Ground (same round): area pieces' meshes are also on GROUND_LAYER, and effects get `ground` in create(): a height target
// of those surfaces drawn from above on demand (lib/runtime/ground-height.mjs, r187 webgpu_compute_particles_snow), marked
// stale after each sync and each terrain rebuild. Effects may add a pick-only InstancedMesh (userData.pick, never drawn).
import * as TSL from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createLightRig } from './lights.mjs';
import { createMaterials, instanceAttributeName, isInstanceParam } from './materials.mjs';
import { sceneLayout, layoutKey } from '../scene/layout.mjs';
import { targetsOf } from '../behaviours/targets.mjs';
import { chooseMotion } from '../talk/motion.mjs';
import { TALK_ATTRIBUTE, talkPositionNode } from '../talk/talk-node.mjs';
import { createGroundHeight, GROUND_LAYER } from './ground-height.mjs';

const LOD_STEP = { phone: 30, high: 60 };
/** The layer of shadow-only meshes (component.json draw.<preset>.shadowFrom): every shadow camera sees it, the view's camera
 * and the picking ray do not (three.js layers: an object is drawn by a camera whose layers it shares). */
export const SHADOW_LAYER = 1;
const LIGHT_FIELDS = ['lumens', 'candela', 'kelvin', 'angle', 'penumbra'];
const LOD_KEYS = ['lod0', 'lod1', 'lod2', 'card'];
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));

/** The params an instance runs with: the component's defaults, then the instance's values for params it declares. */
export function effectiveParams(def, given = {}) {
  const out = {};
  for (const p of def.params || []) out[p.name] = structuredClone(Object.hasOwn(given, p.name) ? given[p.name] : p.default);
  return out;
}

/** Params that only change a material colour or number go through instance attributes, light params to the light rig,
 * size params (`affects: "scale"`, numbers) to the instance matrix; the rest shape the piece (its batch key).
 * A number that sets a light which names a `bulb` slot (spec §5.2: dimming the light dims the bulb) is both: it goes to
 * the light rig and, as a per-instance attribute, to the bulb's material. So palms at any height, lean or wind, and lamps
 * at any lumens, share one draw per LOD (Review Focus 2). */
export function splitParams(def) {
  const instanced = [], light = [], shape = [], scale = [], effect = [];
  const bulb = (def.lights || []).some((l) => l.bulb);
  for (const p of def.params || []) {
    if (isInstanceParam(p)) instanced.push(p.name);
    else if (p.affects === 'light') { light.push(p.name); if (bulb && p.type === 'number') instanced.push(p.name); }
    else if (p.affects === 'scale' && p.type === 'number') scale.push(p.name);
    else if (p.affects === 'effect') effect.push(p.name);
    else shape.push(p.name);
  }
  return { instanced, light, shape, scale, effect };
}

/** The values a piece hands to its material presets: params that affect the material, or a light (a lamp's lumens dims its
 * bulb). A module or size param never does, even when a preset has a param of the same name (the fountain's `colour`
 * tints its show; kerb-concrete and water have a `colour` of their own; Task 9). */
export function materialValues(def, params = {}) {
  const out = {};
  for (const p of def.params || []) if ((p.affects === 'material' || p.affects === 'light') && Object.hasOwn(params, p.name)) out[p.name] = params[p.name];
  return out;
}

/** The uniform size factor of an instance: the product of value / default over its `affects: "scale"` number params. */
export function scaleOf(def, params = {}) {
  let k = 1;
  for (const p of def.params || []) if (p.affects === 'scale' && p.type === 'number' && typeof p.default === 'number' && p.default > 0 && typeof params[p.name] === 'number' && params[p.name] > 0) k *= params[p.name] / p.default;
  return k;
}

/** How a piece is drawn on a preset: [{ key, castShadow }] in LOD order, and the hand-over distances (null: steps). */
export function drawPlan(def, preset) {
  const rule = def.draw?.[preset];
  const have = def.kind === 'mesh' ? LOD_KEYS.filter((k) => def.files?.[k]) : ['module'];
  const keys = rule?.lods ? rule.lods.filter((k) => have.includes(k)) : have;
  return { lods: keys.map((key) => ({ key, castShadow: rule?.shadow ? rule.shadow.includes(key) : true })), distances: Array.isArray(rule?.distances) ? rule.distances : null,
    shadowFrom: rule?.shadowFrom && have.includes(rule.shadowFrom) ? rule.shadowFrom : null };
}

/** Components of a per-instance attribute: 1 for a number, 3 for a colour. */
export const instanceItemSize = (def, name) => ((def.params || []).find((p) => p.name === name)?.type === 'number' ? 1 : 3);

export function createSceneView(stage, registry, { lightRig = null } = {}) {
  const { THREE, scene, camera } = stage;
  const preset = stage.preset === 'phone' ? 'phone' : 'high';
  const root = new THREE.Group(); root.name = 'scene view';
  const anchors = new THREE.Group(); anchors.name = 'scene view anchors';
  root.add(anchors); scene.add(root);
  const rig = lightRig || createLightRig(stage);
  const ownRig = !lightRig;
  const mats = createMaterials({ THREE, preset, isWebGPU: !!stage.isWebGPU, lampMap: rig.lampMap || null, environment: scene.userData.environment?.uniforms || null }, registry);
  // r187 webgpu_loader_gltf_compressed: meshopt geometry (imported models, tools/import-model.mjs) and KTX2 textures (once a
  // KTX2 encoder makes them); the Basis transcoder loads only when a KTX2 texture is parsed. One KTX2Loader per view.
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  let ktx2 = null;
  if (stage.renderer && typeof stage.renderer.init === 'function') { try { ktx2 = new KTX2Loader().setTranscoderPath(new URL('../../vendor/three-0.187.0/addons/libs/basis/', import.meta.url).href).detectSupport(stage.renderer); loader.setKTX2Loader(ktx2); } catch { ktx2 = null; } }
  const glbs = new Map(); // url -> Promise<gltf>
  const protos = new Map(); // batch key -> Promise<Proto>
  const batches = new Map(); // batch key -> Batch
  let items = new Map(); // uid -> Item
  const effects = new Map(); // component ref -> the component's one effect
  // height targets of the ground, one per user (a burst pool, a trail pool): each keeps its own window (ground-height.mjs)
  const grounds = new Map();
  const groundFor = (key = 'default') => { if (!grounds.has(key)) grounds.set(key, createGroundHeight({ THREE, renderer: stage.renderer || null, scene, preset })); return grounds.get(key); };
  const ground = groundFor('default');
  const markGround = () => { for (const g of grounds.values()) g.markDirty(); };
  let lightsOut = [], collidersOut = [], lastEnv = '', chain = Promise.resolve(), disposed = false;
  const hidden = new Set(); // uids whose instance is not drawn (an actor stands in for it: lib/runtime/actors.mjs)
  const veiled = new Set(); // uids not drawn because the camera is on top of them (the walk: builder/walk.js); a reason of its own, so it never undoes `hidden`
  let extras = []; // instances drawn beside the document's (the walk's player, builder/walk.js): not in the layout, not saved
  const rebuildCbs = new Set(); // told the uids whose shape a layout rebuild replaced (the walk re-reads the ground)
  const lastCam = new THREE.Vector3(Infinity, 0, 0), tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion();
  let lastBias = 1; // the LOD bias the batches were last sorted with (stage.lodBias, the fps gate)

  const loadGLB = (url) => {
    if (!glbs.has(url)) glbs.set(url, registry.fetchBuffer(url).then((buf) => loader.parseAsync(buf, new URL('./', url).href)));
    return glbs.get(url);
  };

  // ---------- one piece's shape: meshes merged into one geometry, one group per material ----------
  function collect(object, materialFor) {
    object.updateMatrixWorld(true);
    const parts = [];
    object.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const g = o.geometry.clone();
      for (const k of Object.keys(g.morphAttributes)) delete g.morphAttributes[k];
      // quantized attributes (KHR_mesh_quantization, which meshopt output uses: normalized int16 positions with the scale on
      // the node) become float first: baking the node matrix into a normalized integer array clamps every value at 1
      for (const [k, a] of Object.entries(g.attributes)) if (a.normalized || !(a.array instanceof Float32Array) || a.isInterleavedBufferAttribute) {
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
      }
      g.applyMatrix4(o.matrixWorld);
      const src = Array.isArray(o.material) ? o.material[0] : o.material; // multi-material source meshes: first slot (none in the kit yet)
      parts.push({ g, material: materialFor(o, src, !g.attributes.normal) });
    });
    if (!parts.length) throw new Error('the piece has no meshes');
    const common = Object.keys(parts[0].g.attributes).filter((k) => parts.every((p) => p.g.attributes[k]));
    for (const p of parts) for (const k of Object.keys(p.g.attributes)) if (!common.includes(k)) p.g.deleteAttribute(k);
    if (parts.some((p) => p.g.index) && parts.some((p) => !p.g.index)) for (const p of parts) if (p.g.index) p.g = p.g.toNonIndexed();
    if (parts.length === 1) return { geometry: parts[0].g, material: parts[0].material };
    const geometry = mergeGeometries(parts.map((p) => p.g), true);
    for (const p of parts) p.g.dispose();
    if (!geometry) throw new Error('the piece\'s meshes cannot be merged');
    return { geometry, material: parts.map((p) => p.material) };
  }

  async function buildProto(def, params, layout = null) {
    const { instanced } = splitParams(def);
    const inst = new Set(instanced);
    const slotOf = (name) => (def.materials || []).find((m) => m.slot === name) || null;
    const values = materialValues(def, params);
    const slotMaterial = (slot, flat = false, lod = null, source = null, extra = null) => (slot ? mats.make(slot.preset, extra ? { ...(slot.overrides || {}), ...extra } : slot.overrides, values, inst, { flat, lod, source, body: def.body || null }) : null);
    const plan = drawPlan(def, preset);
    let lods = [], lights = def.lights || [], collider = def.collider || [], effect = null, features = {};
    let shadowLod = null;
    if (def.kind === 'mesh') {
      const keys = [...plan.lods, ...(plan.shadowFrom && !plan.lods.some((l) => l.key === plan.shadowFrom) ? [{ key: plan.shadowFrom, castShadow: false, shadowOnly: true }] : [])];
      for (const { key, castShadow, shadowOnly } of keys) {
        const gltf = await loadGLB(new URL(def.files[key], def.dir).href);
        (shadowOnly ? (x) => { shadowLod = x; } : (x) => lods.push(x))({ key, castShadow, ...collect(gltf.scene, (o, src, flat) => {
          const name = (src?.name || o.name || '').toLowerCase();
          const slot = (def.materials || []).find((m) => m.slot.toLowerCase() === name) || (def.materials || []).find((m) => m.slot.toLowerCase() === (o.name || '').toLowerCase());
          const m = slotMaterial(slot, flat, key, src); // the preset sees which LOD it dresses (ctx.lod), as Boulevard's palms use a lighter material on the middle ring, and the file's own material (ctx.source: imported models)
          if (m) return m;
          const keep = src.clone(); if (flat) keep.flatShading = true; return keep; // no slot or no preset: the file's own material
        }) });
      }
    } else {
      const ctx = {
        THREE, TSL, preset, isWebGPU: !!stage.isWebGPU,
        material: (presetId, overrides = {}) => mats.make(presetId, overrides, values, inst) || new THREE.MeshStandardNodeMaterial(),
        slot: (name, extra = null) => slotMaterial(slotOf(name), false, null, null, extra) || new THREE.MeshStandardNodeMaterial(),
        lampMap: rig.lampMap || null,
        environment: scene.userData.environment?.uniforms || null, // the stage's night, day and sun terms (effects read uNight)
        layout: layout ? structuredClone(layout) : null, // where the other pieces stand (usesLayout modules only)
      };
      const out = await def.module.build(structuredClone(params), ctx);
      if (!out || !out.object || !out.object.isObject3D) throw new Error('build() returned no object');
      if (out.effect && typeof out.effect.create !== 'function') throw new Error('build() returned an effect with no create()');
      const owned = new Set(); out.object.traverse((o) => { if (o.isMesh) owned.add(o.geometry); });
      if (owned.size || !out.effect) lods.push({ key: 'module', castShadow: plan.lods[0]?.castShadow ?? true, ...collect(out.object, (o, src) => src) });
      for (const g of owned) g.dispose(); // collect() cloned them
      if (Array.isArray(out.lights)) lights = out.lights;
      if (Array.isArray(out.collider)) collider = out.collider;
      effect = out.effect || null; features = out.features || {};
    }
    if (plan.shadowFrom && !shadowLod) shadowLod = lods.find((l) => l.key === plan.shadowFrom) || null;
    const talk = def.kind === 'mesh' && (registry.behaviour?.('talk')?.targets || ['character']).some((t) => targetsOf(def).includes(t)) ? talkShape([...lods, shadowLod].filter(Boolean)) : null;
    return { def, params, lods, shadowLod, distances: plan.distances, lights, collider, instanced, effect, features, talk, layoutKey: layout ? layoutKey(layout) : null, dispose() { for (const l of new Set([...lods, shadowLod].filter(Boolean))) l.geometry.dispose(); } };
  }

  // ---------- talk: the shader path on a talk-capable piece's materials (lib/talk/talk-node.mjs) ----------
  function talkShape(lods) {
    let minY = Infinity, maxY = -Infinity;
    for (const l of lods) { l.geometry.computeBoundingBox(); minY = Math.min(minY, l.geometry.boundingBox.min.y); maxY = Math.max(maxY, l.geometry.boundingBox.max.y); }
    const shape = { minY, height: maxY - minY };
    for (const l of lods) for (const m of Array.isArray(l.material) ? l.material : [l.material]) {
      if (!m || m.userData.talkNode) continue; // a cached material shared by two LOD sets of the same file
      if (!('positionNode' in m)) continue; // not a node material (a file's own material kept as it is)
      m.positionNode = talkPositionNode(TSL, { ...shape, base: m.positionNode || null });
      m.userData.talkNode = true; m.needsUpdate = true;
    }
    return shape;
  }
  const talkAmp = new Map(); // uid -> amplitude of the piece that talks
  function writeTalk(mesh, k, it) {
    const a = mesh.geometry.getAttribute(TALK_ATTRIBUTE); if (!a) return;
    const amp = talkAmp.get(it.uid) || 0;
    a.setXYZW(k, amp, Math.cos(it.yaw), Math.sin(it.yaw), it.s); a.needsUpdate = true;
  }

  // ---------- rebuilds of layout-reading pieces (the terrain) after the layout changed ----------
  const usesLayout = (def) => def.kind === 'generator' && def.module?.usesLayout === true;
  /** The layout in a piece's own frame: the inverse of its transform (as lib/solver/solve.mjs rot, about +Y, then 1 / s). */
  const toLocal = (layout, t = {}) => {
    const p = Array.isArray(t.p) ? t.p : [0, 0, 0], yaw = +t.yaw || 0, s = +t.s > 0 ? +t.s : 1, c = Math.cos(yaw), sn = Math.sin(yaw);
    if (!p[0] && !p[2] && !yaw && s === 1) return layout;
    const mm = (v) => Math.round(v * 1000) / 1000;
    return layout.map((sh) => ({ ...sh, points: sh.points.map(([x, z]) => { const dx = x - p[0], dz = z - p[2]; return [mm((c * dx - sn * dz) / s), mm((sn * dx + c * dz) / s)]; }) }));
  };
  const pending = new Map(), wantLayout = new Map(); // batch key -> { def, params, layout, key } | the latest layout key
  let draining = null;
  function scheduleRebuild(key, job) { pending.set(key, job); if (!draining) draining = drain().finally(() => { draining = null; }); }
  async function drain() {
    while (pending.size && !disposed) {
      const [key, job] = pending.entries().next().value;
      pending.delete(key);
      let proto;
      try { proto = await buildProto(job.def, job.params, job.layout); } catch (e) { console.error('rebuild failed', job.def.ref, e); continue; }
      const run = chain.then(() => swapProto(key, proto));
      chain = run.catch(() => {});
      await run.catch((e) => console.error('rebuild swap failed', e));
    }
  }
  /** Draws a finished rebuild when it is the layout the scene wants now, or a step towards it while a newer rebuild is still
   * to come (so a long drag shows the terrain following); never over the wanted one, never once nothing newer is coming. */
  function swapProto(key, proto) {
    const b = batches.get(key), want = wantLayout.get(key);
    const stale = proto.layoutKey !== want && !pending.has(key);
    if (disposed || !b || stale || b.proto.layoutKey === want) { proto.dispose(); return; }
    const old = b.proto;
    for (const m of b.meshes) { m.removeFromParent(); m.dispose(); }
    b.meshes = []; b.capacity = 0; b.proto = proto;
    for (const it of b.members) it.batch = b;
    ensureCapacity(b, b.members.length);
    writeBatch(b);
    protos.set(key, Promise.resolve(proto));
    old.dispose();
    collidersOut = []; for (const it of items.values()) collidersOut.push(...worldColliders(it));
    markGround();
    const uids = b.members.map((it) => it.uid);
    for (const cb of [...rebuildCbs]) { try { cb(uids); } catch (e) { console.error('scene view onRebuild', e); } }
  }

  // ---------- a batch: the InstancedMeshes (one per LOD) of one proto ----------
  function makeBatch(key, proto) {
    return { key, proto, ref: proto.def.ref, meshes: [], capacity: 0, members: [] };
  }
  // the shadow-only mesh (draw.<preset>.shadowFrom): every instance, from the chosen LOD's shape, on SHADOW_LAYER
  function shadowCameras() {
    scene.traverse((o) => { if (o.isLight && o.shadow?.camera) { o.shadow.camera.layers.enable(SHADOW_LAYER); for (const l of o.shadow.shadowNode?.lights || []) l.shadow?.camera?.layers.enable(SHADOW_LAYER); } });
  }
  function ensureCapacity(batch, n) {
    if (batch.capacity >= n && batch.meshes.length) return;
    for (const m of batch.meshes) { m.removeFromParent(); m.dispose(); }
    if (batch.shadowMesh) { batch.shadowMesh.removeFromParent(); batch.shadowMesh.dispose(); batch.shadowMesh = null; }
    const cap = THREE.MathUtils.ceilPowerOfTwo(Math.max(1, n));
    const sl = batch.proto.shadowLod;
    if (sl) {
      for (const name of batch.proto.instanced) if (!batch.proto.lods.includes(sl)) { const n2 = instanceItemSize(batch.proto.def, name); sl.geometry.setAttribute(instanceAttributeName(name), new THREE.InstancedBufferAttribute(new Float32Array(cap * n2), n2)); }
      const sm = new THREE.InstancedMesh(sl.geometry, sl.material, cap);
      sm.name = `${batch.ref} ${sl.key} shadow`; sm.castShadow = true; sm.receiveShadow = false; sm.count = 0; sm.visible = false; sm.frustumCulled = false;
      sm.layers.set(SHADOW_LAYER); sm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      sm.userData = { ref: batch.ref, lod: sl.key, shadowProxy: true, batchKey: batch.key };
      root.add(sm); batch.shadowMesh = sm;
      shadowCameras();
    }
    if (batch.proto.talk) for (const l of new Set([...batch.proto.lods, sl].filter(Boolean))) l.geometry.setAttribute(TALK_ATTRIBUTE, new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
    batch.meshes = batch.proto.lods.map((lod, i) => {
      for (const name of batch.proto.instanced) { const n = instanceItemSize(batch.proto.def, name); lod.geometry.setAttribute(instanceAttributeName(name), new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n)); }
      const mesh = new THREE.InstancedMesh(lod.geometry, lod.material, cap);
      mesh.name = `${batch.ref} ${lod.key}`; mesh.castShadow = lod.castShadow; mesh.receiveShadow = true; mesh.count = 0; mesh.visible = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData = { ref: batch.ref, lod: lod.key, lodIndex: i, uids: [], batchKey: batch.key };
      if (batch.proto.def.area) mesh.layers.enable(GROUND_LAYER); // the surfaces particles land on (ground-height.mjs)
      root.add(mesh);
      return mesh;
    });
    batch.capacity = cap;
  }
  const colour = new THREE.Color();
  /** The index of the LOD an item with `lodMin` (a LOD key) is drawn at least as light as; the lightest when the piece has no such LOD. */
  const lodFloor = (batch, key) => { const i = batch.meshes.findIndex((m) => m.userData.lod === key); return i < 0 ? batch.meshes.length - 1 : i; };
  function writeBatch(batch) {
    const nLod = batch.meshes.length, step = LOD_STEP[preset], dist = batch.proto.distances, bias = stage.lodBias || 1; // the fps gate's LOD bias (builder/perf-gate.js)
    if (batch.shadowMesh) {
      const sm = batch.shadowMesh;
      const shown = batch.members.filter((it) => !hidden.has(it.uid) && !veiled.has(it.uid));
      shown.forEach((it, k) => sm.setMatrixAt(k, it.matrix));
      sm.count = shown.length; sm.visible = sm.count > 0; sm.instanceMatrix.needsUpdate = true;
    }
    if (!nLod) return; // an effect-only piece: the component's effect draws it (syncEffects)
    const camPos = camera.getWorldPosition(tmpV);
    const buckets = batch.meshes.map(() => []);
    for (const it of batch.members) {
      if (hidden.has(it.uid) || veiled.has(it.uid)) { it.mesh = null; continue; }
      const d = camPos.distanceTo(it.anchor.position) * bias;
      let lod = 0;
      if (nLod > 1 && dist) { while (lod < nLod - 1 && lod < dist.length && d >= dist[lod]) lod++; } // component.json draw: metres, as Boulevard
      else if (nLod > 1) lod = Math.min(nLod - 1, Math.floor(d / (step * Math.max(it.s, 0.25))));
      if (it.src?.lodMin && nLod > 1) lod = Math.max(lod, lodFloor(batch, it.src.lodMin)); // an item that is never drawn heavier than this LOD (the wave ghosts)
      buckets[lod].push(it);
    }
    batch.meshes.forEach((mesh, i) => {
      const list = buckets[i];
      list.forEach((it, k) => {
        mesh.setMatrixAt(k, it.matrix);
        if (batch.proto.talk) writeTalk(mesh, k, it);
        for (const name of batch.proto.instanced) {
          const a = mesh.geometry.getAttribute(instanceAttributeName(name));
          if (a.itemSize === 1) a.setX(k, +it.params[name]); else { colour.set(it.params[name]); a.setXYZ(k, colour.r, colour.g, colour.b); }
        }
      });
      for (const name of batch.proto.instanced) mesh.geometry.getAttribute(instanceAttributeName(name)).needsUpdate = true;
      mesh.count = list.length; mesh.visible = list.length > 0;
      mesh.userData.uids = list.map((it) => it.uid);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null; mesh.boundingBox = null;
      if (list.length) mesh.computeBoundingSphere();
      for (const it of list) it.mesh = mesh;
    });
  }
  function relod(force = false) {
    const p = camera.getWorldPosition(tmpV);
    const bias = stage.lodBias || 1;
    if (!force && bias === lastBias && p.distanceToSquared(lastCam) < 1) return;
    lastCam.copy(p); lastBias = bias;
    for (const b of batches.values()) if (b.meshes.length > 1) writeBatch(b);
  }
  const offFrame = stage.onFrame ? stage.onFrame((dt) => {
    relod(false);
    for (const fx of effects.values()) { try { fx.frame?.(dt); } catch (err) { console.error('effect frame', err); } }
  }) : null;

  // ---------- effects: one per component, every instance of it ----------
  function dropEffect(ref) { const fx = effects.get(ref); if (!fx) return; fx.object.removeFromParent(); fx.dispose?.(); effects.delete(ref); }
  function syncEffects() {
    const byRef = new Map();
    for (const it of items.values()) {
      const maker = it.batch.proto.effect; if (!maker) continue;
      if (!byRef.has(it.ref)) byRef.set(it.ref, { maker, list: [] });
      byRef.get(it.ref).list.push({ uid: it.uid, matrix: it.matrix, params: it.params });
    }
    for (const ref of [...effects.keys()]) if (!byRef.has(ref)) dropEffect(ref);
    for (const [ref, { maker, list }] of byRef) {
      let fx = effects.get(ref);
      if (!fx) {
        fx = maker.create({ renderer: stage.renderer || null, camera, ground });
        if (!fx?.object?.isObject3D || typeof fx.set !== 'function') throw new Error(`${ref}: effect.create() returned no effect`);
        fx.object.userData.ref = ref;
        (fx.layer === 'fx' && stage.fxScene ? stage.fxScene : root).add(fx.object);
        effects.set(ref, fx);
      }
      fx.set(list);
    }
  }


  // ---------- lights and colliders with the instance transform applied ----------
  function worldLights(it) {
    const out = [], { def, lights } = it.batch.proto;
    for (const l of lights) {
      const pos = tmpV.set(...(l.pos || [0, 0, 0])).applyMatrix4(it.matrix);
      const li = { uid: it.uid, id: l.id, type: l.type, position: [pos.x, pos.y, pos.z], direction: null,
        kelvin: l.kelvin, shadow: l.shadow || 'off', rays: !!l.rays, bulb: l.bulb || null };
      for (const k of ['lumens', 'candela', 'angle', 'penumbra', 'ies', 'range']) if (l[k] !== undefined) li[k] = l[k];
      if (l.dir || l.type === 'spot' || l.type === 'ies') {
        tmpQ.setFromRotationMatrix(tmpM.extractRotation(it.matrix));
        const d = new THREE.Vector3(...(l.dir || [0, -1, 0])).applyQuaternion(tmpQ).normalize();
        li.direction = [d.x, d.y, d.z];
      }
      for (const p of def.params || []) if (p.affects === 'light' && LIGHT_FIELDS.includes(p.name)) {
        if (p.name === 'lumens' && li.candela !== undefined && li.lumens === undefined) continue; // a candela light keeps its unit
        li[p.name] = it.params[p.name];
      }
      out.push(li);
    }
    return out;
  }
  function worldColliders(it) {
    const out = [], s = it.s;
    for (const c of it.batch.proto.collider) {
      const w = { ...structuredClone(c), uid: it.uid };
      if (Array.isArray(c.pos)) { const p = new THREE.Vector3(...c.pos).applyMatrix4(it.matrix); w.pos = [p.x, p.y, p.z]; }
      if (Array.isArray(c.half)) w.half = c.half.map((v) => v * s);
      if (typeof c.radius === 'number') w.radius = c.radius * s;
      if (typeof c.halfHeight === 'number') w.halfHeight = c.halfHeight * s;
      if (c.type === 'cuboid' || c.type === 'box') w.rotY = (c.rotY || 0) + it.yaw; // 'box': imported models (lib/import/import.mjs)
      if (Array.isArray(c.scale)) w.scale = c.scale.map((v) => v * s); // heightfield: yaw is not applied
      if (Array.isArray(c.vertices)) {
        const v = new THREE.Vector3(); w.vertices = [];
        for (let i = 0; i < c.vertices.length; i += 3) { v.set(c.vertices[i], c.vertices[i + 1], c.vertices[i + 2]).applyMatrix4(it.matrix); w.vertices.push(v.x, v.y, v.z); }
      }
      out.push(w);
    }
    return out;
  }

  // ---------- sync ----------
  async function doSync(doc) {
    if (disposed) throw new Error('scene view disposed');
    const missing = [];
    const env = doc?.environment ? JSON.stringify(doc.environment) : '';
    if (env && env !== lastEnv && typeof stage.setEnvironment === 'function') { stage.setEnvironment(doc.environment); lastEnv = env; }
    const all = [...(Array.isArray(doc?.areas) ? doc.areas : []), ...(Array.isArray(doc?.instances) ? doc.instances : []), ...extras];
    const groups = new Map(), seen = new Set();
    for (const src of all) {
      const uid = src?.uid, ref = src?.component;
      if (typeof uid !== 'string' || !uid) { missing.push({ uid: String(uid), ref: String(ref), reason: 'instance has no uid' }); continue; }
      if (seen.has(uid)) { missing.push({ uid, ref, reason: 'duplicate uid' }); continue; }
      seen.add(uid);
      const def = registry.get(ref);
      if (!def) { missing.push({ uid, ref, reason: registry.problem ? registry.problem(ref) : 'unknown component' }); continue; }
      const params = effectiveParams(def, src.params || {});
      const { shape } = splitParams(def), shapeParams = {};
      for (const k of shape) shapeParams[k] = params[k];
      // a piece that shapes itself round the scene is its own batch, keyed by its uid and transform too (its layout is in its frame)
      const key = usesLayout(def) ? `${ref}|${stable(shapeParams)}|${uid}|${stable(src.transform || {})}` : `${ref}|${stable(shapeParams)}`;
      if (!groups.has(key)) groups.set(key, { def, shapeParams, list: [] });
      groups.get(key).list.push({ uid, ref, src, params });
    }
    // where the pieces stand, for the pieces that shape themselves round the rest (the terrain)
    let layoutAll = null;
    for (const g of groups.values()) if (usesLayout(g.def)) {
      layoutAll ??= sceneLayout(doc, registry);
      const own = new Set(g.list.map((it) => it.uid));
      g.layout = toLocal(layoutAll.filter((s) => !own.has(s.uid)), g.list[0].src.transform);
      g.layoutKey = layoutKey(g.layout);
    }
    // build what is new (in parallel); a failed build reports its instances and the rest is drawn
    await Promise.all([...groups].map(async ([key, g]) => {
      const defaults = effectiveParams(g.def, g.shapeParams);
      if (!protos.has(key)) protos.set(key, buildProto(g.def, defaults, g.layout || null));
      if (g.layout) wantLayout.set(key, g.layoutKey);
      try {
        g.proto = await protos.get(key);
        const drawn = batches.get(key)?.proto || g.proto;
        if (g.layout && drawn.layoutKey !== g.layoutKey) scheduleRebuild(key, { def: g.def, params: defaults, layout: g.layout });
        else pending.delete(key);
      }
      catch (e) {
        protos.delete(key);
        for (const it of g.list) missing.push({ uid: it.uid, ref: it.ref, reason: `build failed: ${e.message}` });
        groups.delete(key);
      }
    }));
    if (disposed) throw new Error('scene view disposed');
    // drop batches no longer used
    for (const [key, b] of batches) if (!groups.has(key)) {
      for (const m of b.meshes) { m.removeFromParent(); m.dispose(); }
      if (b.shadowMesh) { b.shadowMesh.removeFromParent(); b.shadowMesh.dispose(); }
      b.proto.dispose(); batches.delete(key); protos.delete(key); pending.delete(key); wantLayout.delete(key);
    }
    for (const [key, p] of protos) if (!groups.has(key)) { p.then((x) => x.dispose(), () => {}); protos.delete(key); }
    // items, anchors and instance data
    const next = new Map();
    for (const [key, g] of groups) {
      let b = batches.get(key);
      if (!b) { b = makeBatch(key, g.proto); batches.set(key, b); }
      b.members = [];
      for (const it of g.list) {
        const t = it.src.transform || {}, p = Array.isArray(t.p) ? t.p : [0, 0, 0], yaw = +t.yaw || 0, s = +t.s > 0 ? +t.s : 1;
        const anchor = items.get(it.uid)?.anchor || new THREE.Object3D();
        anchor.name = it.uid; anchor.position.set(p[0], p[1], p[2]); anchor.rotation.set(0, yaw, 0); anchor.scale.setScalar(s);
        anchor.updateMatrix(); anchor.updateMatrixWorld();
        anchor.userData = { uid: it.uid, ref: it.ref, params: it.params, batchKey: key };
        // the instance matrix carries the size params too (value / default), the anchor only the document's transform
        const k = scaleOf(g.def, it.params);
        const item = { ...it, yaw, s: s * k, k, anchor, matrix: anchor.matrix.clone().scale(new THREE.Vector3(k, k, k)), batch: b, mesh: null };
        b.members.push(item); next.set(it.uid, item);
      }
      ensureCapacity(b, b.members.length);
    }
    for (const [uid, it] of items) if (!next.has(uid)) it.anchor.removeFromParent();
    for (const it of next.values()) if (!it.anchor.parent) anchors.add(it.anchor);
    items = next;
    syncEffects();
    for (const b of batches.values()) writeBatch(b);
    lastCam.copy(camera.getWorldPosition(tmpV));
    lightsOut = []; collidersOut = [];
    for (const it of items.values()) { lightsOut.push(...worldLights(it)); collidersOut.push(...worldColliders(it)); }
    if (rig.setWater) rig.setWater((layoutAll ?? sceneLayout(doc, registry)).filter((sh) => sh.water && sh.shape === 'polygon').map((sh) => sh.points)); // the lamps the water mirrors
    rig.set(lightsOut);
    markGround();
    return { drawn: items.size, missing };
  }

  const raycaster = new THREE.Raycaster();
  return {
    root,
    lightRig: rig,
    sync(doc) { const run = chain.then(() => doSync(doc), () => doSync(doc)); chain = run.catch(() => {}); return run; },
    /** Resolves when the pending rebuilds of layout-reading pieces (the terrain after a piece moved) are drawn. */
    async settled() { await chain; while (draining) { await draining; await chain; } },
    objectOf: (uid) => items.get(uid)?.anchor || null,
    /** What the instance's piece draws on this preset (build()'s `features`, e.g. { spray: false } off High WebGPU). */
    features: (uid) => ({ ...(items.get(uid)?.batch.proto.features || {}) }),
    /** The component's one effect (its handle), or null. */
    effect: (ref) => effects.get(ref) || null,
    /** Talk: the piece's amplitude 0..1 for the shader path this frame (0 stops it). */
    setTalk(uid, amp) {
      const it = items.get(uid); const a = Math.max(0, Math.min(1, +amp || 0));
      if (a > 0) talkAmp.set(uid, a); else talkAmp.delete(uid);
      if (!it?.batch.proto.talk) return false;
      const k = it.mesh ? it.mesh.userData.uids.indexOf(uid) : -1;
      if (k >= 0) writeTalk(it.mesh, k, it);
      const sm = it.batch.shadowMesh, j = it.batch.members.indexOf(it);
      if (sm && j >= 0 && !it.batch.proto.lods.some((l) => l.geometry === sm.geometry)) writeTalk(sm, j, it);
      return k >= 0;
    },
    /** Talk: where the piece's mouth is (local to its anchor, objectOf(uid)) and the motion its file offers (lib/talk/motion.mjs)
     * against the motion drawn here ('shader': see the header). null when the piece does not take talk. */
    async talk(uid) {
      const it = items.get(uid), t = it?.batch.proto.talk; if (!t) return null;
      const def = it.batch.proto.def;
      let offered = { path: 'shader' };
      try { if (def.files?.lod0) offered = chooseMotion((await loadGLB(new URL(def.files.lod0, def.dir).href)).scene); } catch { /* the drawn LODs are what counts */ }
      const k = it.s / Math.max(1e-6, it.anchor.scale.x); // the size params' factor (the anchor carries the document's scale)
      return { mouth: [0, (t.minY + 0.9 * t.height) * k, 0.08 * k], height: t.height * it.s, offered: offered.path, drawn: 'shader' };
    },
    talkAmp: (uid) => talkAmp.get(uid) || 0,
    /** The size params' scale of a piece (affects: "scale": value / default; 1 for most). */
    scaleOf: (uid) => items.get(uid)?.k ?? 1,
    /** The ground height target effects collide with (lib/runtime/ground-height.mjs); groundFor(key) gives a user its own. */
    ground, groundFor,
    uidAt([x, y]) {
      camera.updateMatrixWorld();
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const meshes = []; for (const b of batches.values()) for (const m of b.meshes) if (m.visible && m.count > 0) meshes.push(m);
      for (const fx of effects.values()) fx.object.traverseVisible((o) => { if (o.isInstancedMesh && o.count > 0 && Array.isArray(o.userData.uids)) meshes.push(o); }); // effects drawn per component (searchlight beams)
      for (const fx of effects.values()) fx.object.traverse((o) => { if (o.userData.pick && o.isInstancedMesh && o.count > 0 && Array.isArray(o.userData.uids) && !meshes.includes(o)) meshes.push(o); }); // pick-only volumes (never drawn)
      const hit = raycaster.intersectObjects(meshes, false).find((h) => h.instanceId !== undefined);
      return hit ? hit.object.userData.uids[hit.instanceId] ?? null : null;
    },
    colliders: () => collidersOut.map((c) => structuredClone(c)),
    /** The piece's drawn shape (its first LOD, as drawn on this preset) in world metres: { vertices: Float32Array (x, y, z),
     * indices: Uint32Array, triangles }, or null. The walk's ground collider is the terrain's own surface (lib/walk/level.mjs). */
    surface(uid) {
      const it = items.get(uid), lod = it?.batch.proto.lods[0];
      if (!lod) return null;
      const g = lod.geometry, P = g.attributes.position, v = new THREE.Vector3(), vertices = new Float32Array(P.count * 3);
      for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(it.matrix); vertices[i * 3] = v.x; vertices[i * 3 + 1] = v.y; vertices[i * 3 + 2] = v.z; }
      const indices = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: P.count }, (_, i) => i);
      return { vertices, indices, triangles: indices.length / 3 };
    },
    /** fn(uids) after a layout rebuild (the terrain re-shaped round moved pieces) is drawn; returns the unsubscribe. */
    onRebuild(fn) { rebuildCbs.add(fn); return () => rebuildCbs.delete(fn); },
    /** Instances drawn beside the document's on every sync (the walk's player); [] removes them. Then sync again. */
    setExtras(list = []) { extras = Array.isArray(list) ? list.map((x) => structuredClone(x)) : []; },
    /** Stops (on = true) or resumes drawing an instance, without a sync: an actor (lib/runtime/actors.mjs) stands in for it. */
    hide(uid, on = true) {
      const it = items.get(uid); if (on) hidden.add(uid); else hidden.delete(uid);
      if (it) writeBatch(it.batch);
      return !!it;
    },
    isHidden: (uid) => hidden.has(uid),
    /** The pieces not drawn because the camera is on top of them: exactly these uids (the walk's camera, each frame it
     * changes). Their instance is left out and whatever hangs from their anchor (an actor) is not drawn either. It is
     * kept apart from hide(): a piece hidden for another reason stays hidden when the veil lifts. → true when it changed. */
    veil(uids = []) {
      const next = new Set(uids);
      if (next.size === veiled.size && [...next].every((u) => veiled.has(u))) return false;
      const touched = new Set([...veiled, ...next]);
      veiled.clear(); for (const u of next) veiled.add(u);
      const batches = new Set();
      for (const u of touched) { const it = items.get(u); if (!it) continue; it.anchor.visible = !veiled.has(u); if (it.batch) batches.add(it.batch); }
      for (const b of batches) writeBatch(b);
      return true;
    },
    veiled: () => [...veiled],
    /** Moves a drawn instance (the walk's player) without a sync: position [x, y, z], yaw; its batch is rewritten. */
    place(uid, p, yaw = 0, tilt = null) {
      const it = items.get(uid); if (!it) return false;
      it.anchor.position.set(p[0], p[1], p[2]);
      // tilt { pitch, roll } (radians, in the figure's own frame after the yaw): the walk's lean and bank
      if (tilt && (tilt.pitch || tilt.roll)) it.anchor.rotation.set(tilt.pitch || 0, yaw, tilt.roll || 0, 'YXZ'); else it.anchor.rotation.set(0, yaw, 0, 'XYZ'); it.anchor.updateMatrix(); it.anchor.updateMatrixWorld();
      const k = it.s / (it.anchor.scale.x || 1);
      it.matrix.copy(it.anchor.matrix).scale(tmpV.set(k, k, k)); it.yaw = yaw;
      writeBatch(it.batch);
      return true;
    },
    lights: () => lightsOut.map((l) => ({ ...l, position: [...l.position], direction: l.direction ? [...l.direction] : null })),
    /** Re-sorts instances between LODs now (the view also does it each frame the camera moves). */
    relod: () => relod(true),
    dispose() {
      if (disposed) return; disposed = true;
      offFrame?.();
      for (const ref of [...effects.keys()]) dropEffect(ref);
      for (const g of grounds.values()) g.dispose();
      for (const b of batches.values()) { for (const m of b.meshes) m.dispose(); b.shadowMesh?.dispose(); b.proto.dispose(); }
      batches.clear(); protos.clear(); items.clear();
      root.removeFromParent();
      mats.dispose(); ktx2?.dispose();
      for (const p of glbs.values()) p.then((g) => g.scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); } }), () => {});
      glbs.clear();
      if (ownRig) rig.dispose();
    },
  };
}
