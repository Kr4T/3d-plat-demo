// look.js: the date palm's LOOK, and nothing else. r187 examples: webgpu_loader_gltf (a glTF model drawn with node
// materials built in code; here the GLB carries shape, UVs and baked AO only) and webgpu_materials_alphahash (hashed
// leaflet edges resolved by TRAA on High). The look itself lives in shared/materials/palms.js (createPalmMaterial), so
// other pages that draw the Boulevard world share it; it started as Boulevard City's palm.js (Kr4T/3DPLAT round2/boulevard
// 3352816, apps/boulevard-city-3d/palm.js, `palmMaterials`) and was upgraded on 11 Nov 2026 (translucency, per-frond wind,
// hashed alpha under TRAA, bark derivative normals, crown AO: see that file's header). This file only hands it the palm's
// own baked maps (models/palm/, next to this file) and the builder's ctx:
//   - one material per slot (`trunk`, `frond`, `card`, as the GLB names its materials);
//   - the params `lean` (degrees, a rooted bend), `wind` (times Boulevard's sway and flutter), `frondTint` (times the leaf
//     colour): a number / '#rrggbb', or in a scene a per-instance attribute node (lib/runtime/materials.mjs), so palms that
//     differ share one draw per LOD. `height` is not here: the runtime scales the instance matrix (affects: scale);
//   - the material per LOD as main.js buildPalms: physical fronds (sheen) only on High's near LOD (palm_lod0), standard
//     ones on High's middle ring and every Phone LOD (ctx.lod);
//   - the sun and moon for the light through the leaflets from the stage's environment uniforms (builder/environment.js).
import { createPalmMaterial, loadPalmMaps, PALM_MODEL_HEIGHT } from '../../shared/materials/palms.js';

/** The model's own height at scale 1 (palm_lod0, palm.report.json: 10.47 m). */
export const MODEL_HEIGHT = PALM_MODEL_HEIGHT;

/**
 * palmLook({ part: 'trunk' | 'frond' | 'card', preset: 'phone' | 'high', lod, lean, wind, frondTint, environment,
 * temporalAA }) -> a node material.
 */
export function palmLook({ part = 'frond', preset = 'high', lod = 'lod0', lean = 0, wind = 1, frondTint = '#ffffff', environment = null, temporalAA = false } = {}) {
  const maps = loadPalmMaps(new URL('models/palm/', import.meta.url));
  return createPalmMaterial({ part, quality: preset, lod, maps, lean, wind, frondTint, environment, temporalAA });
}
