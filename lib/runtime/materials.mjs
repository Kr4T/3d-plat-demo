// materials.mjs: the materials registry at run time (spec §6): presets loaded by name from materials/<preset>/
// (material.json + material.js exporting create(params, ctx) -> NodeMaterial) and a cache of the materials made from them.
// r187 examples: webgpu_loader_gltf (glTF materials replaced by node materials), webgpu_instance_uniform and
// webgl_instancing_scatter (a per-instance value read by the material: here an InstancedBufferAttribute `inst_<param>`
// read with TSL attribute(), so each slot decides whether a per-instance colour applies to it), and
// webgpu_lights_clustered_city (MeshStandardNodeMaterial that receives clustered lights).
import * as TSL from 'three/tsl';

/** The attribute name a per-instance param is written to on an instanced geometry. */
export const instanceAttributeName = (param) => `inst_${param}`;

/** A param varies per instance (instance attribute, not its own mesh) when it is a colour or a number that affects the
 * material: a vec3 attribute for a colour, a float one for a number (a palm's lean and wind, Task 7 review). */
export const isInstanceParam = (p) => !!p && (p.type === 'colour' || p.type === 'number') && p.affects === 'material';
/** Kept for callers of Task 4: a colour that affects the material. */
export const isInstanceColour = (p) => !!p && p.type === 'colour' && p.affects === 'material';

/**
 * Loads one preset: `<materialsURL><id>/material.json` and `<materialsURL><id>/material.js`.
 * Returns MaterialDef { id, meta, params, create, url } or throws with the reason.
 */
export async function loadMaterial(id, materialsURL, fetchFn) {
  const dir = new URL(`${id}/`, materialsURL);
  const r = await fetchFn(new URL('material.json', dir).href);
  if (!r.ok) throw new Error(`materials/${id}/material.json: HTTP ${r.status}`);
  const meta = await r.json();
  if (meta.id !== id) throw new Error(`materials/${id}/material.json: id is "${meta.id}"`);
  const mod = await import(new URL('material.js', dir).href);
  if (typeof mod.create !== 'function') throw new Error(`materials/${id}/material.js: no create(params, ctx) export`);
  const params = Array.isArray(meta.params) ? meta.params : [];
  return Object.freeze({ id, meta, params, create: mod.create, url: dir.href });
}

/**
 * The parameters a preset's create() gets: the preset's defaults, then component params of the same name (the instance's
 * value; a per-instance colour as a vec3 TSL attribute node, a per-instance number, such as a bulb's lumens, as a float
 * one), then the slot overrides (only names the preset exposes), which win: they are fixed for that slot.
 */
export function presetParams(def, overrides = {}, componentValues = {}, instanced = new Set()) {
  const out = {}, exposed = new Set(def.params.map((p) => p.name));
  for (const p of def.params) out[p.name] = structuredClone(p.default);
  for (const [k, v] of Object.entries(componentValues || {})) if (exposed.has(k)) out[k] = structuredClone(v);
  // a slot's own override is fixed for that slot: a component param of the same name meant for another slot (the lake's water
  // `colour`) never reaches it (lake basin, 12 Nov 2026: the coping took the water's teal)
  for (const [k, v] of Object.entries(overrides || {})) if (exposed.has(k)) out[k] = structuredClone(v);
  for (const k of instanced) if (exposed.has(k) && !Object.hasOwn(overrides || {}, k)) out[k] = TSL.attribute(instanceAttributeName(k), def.params.find((p) => p.name === k).type === 'number' ? 'float' : 'vec3');
  return out;
}

/**
 * A material factory for one scene view. ctx is what every create() gets:
 * { THREE, TSL, preset, isWebGPU, lampMap (null unless the light-map path is in use), environment (stage uniforms) },
 * plus `lod` (the LOD key the material dresses: lod0, lod1, card; null for generator pieces) when make() is given one,
 * and `source` (the glTF material the file carries on that mesh) when make() is given one: an imported model's preset
 * (auto-r187) builds its material from the file's own maps. One material per source material (its uuid is in the key).
 */
export function createMaterials({ THREE, preset, isWebGPU, lampMap = null, environment = null }, registry) {
  const ctx = Object.freeze({ THREE, TSL, preset, isWebGPU, lampMap, environment });
  const cache = new Map();
  // The cache key of a set of params. A per-instance param is a TSL attribute node, the same for every build of the piece: it
  // is keyed by its attribute's name and type. (JSON.stringify with a replacer was used here; it calls a node's toJSON()
  // first, which carries the node's uuid, so no two builds ever shared a material: every new area, and the terrain each time
  // it was rebuilt round a dropped piece, got a new material and with it a new shader build. Drop latency, 12 Nov 2026.)
  const stable = (v) => (v && v.isNode ? `#node:${v._attributeName !== undefined ? `${v._attributeName}:${v.nodeType}` : v.uuid}`
    : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
      : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'undefined');
  return {
    ctx,
    /** A material from a preset, or null when the preset is unknown. `flat` for geometry without normals. */
    make(presetId, overrides = {}, componentValues = {}, instanced = new Set(), { flat = false, lod = null, source = null, body = null } = {}) {
      const def = registry.material(presetId);
      if (!def) return null;
      const params = presetParams(def, overrides, componentValues, instanced);
      const key = `${presetId}|${stable(params)}|${[...instanced].filter((k) => def.params.some((p) => p.name === k)).sort().join(',')}|${flat}|${lod ?? ''}|${source?.uuid ?? ''}|${body ?? ''}`;
      if (!cache.has(key)) {
        const m = def.create(params, lod || source || body ? Object.freeze({ ...ctx, ...(lod ? { lod } : {}), ...(source ? { source } : {}), ...(body ? { body } : {}) }) : ctx);
        if (!m || !m.isMaterial) throw new Error(`material preset ${presetId}: create() returned no material`);
        if (flat) m.flatShading = true;
        m.name = m.name || presetId;
        m.userData.preset = presetId;
        cache.set(key, m);
      }
      return cache.get(key);
    },
    size: () => cache.size,
    dispose() { for (const m of cache.values()) m.dispose(); cache.clear(); },
  };
}
