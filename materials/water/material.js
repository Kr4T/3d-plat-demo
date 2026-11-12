// water: the lake surface (slot `surface` of lake-water). r187 examples: webgpu_water (ripples from a normal map scrolled
// at two scales by the TSL clock, so the water moves by itself), webgpu_postprocessing_ssr (the stage's SSR pass reflects
// the lamps, palms and fountain in it on High) and webgpu_postprocessing_bloom_selective (a per-material MRT output: the
// SSR weight). The look lives in shared/materials/water-ssr.js (createWaterMaterial), so other pages that draw the Boulevard
// world share it. It started as Boulevard City's `waterSimple` (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/main.js: physical, roughness 0.04, the three.js waternormals.jpg at 9 m and 23 m scrolled at
// (0.012, 0.007) and (-0.006, 0.009) per second, normal scale 0.35, colour (0.016, 0.07, 0.085) linear, metalness 0.6 so SSR
// would see it) and was upgraded on 11 Nov 2026 (Kereem: "im not seeing proper reflection"): a dielectric with water's
// index (1.333), so the PMREM sky reflection follows Fresnel instead of a 0.6 metal tint; a third, finer ripple band that
// fades out below a few pixels; roughness widened by the unresolved slope; and on High WebGPU an SSR weight of
// reflection / 0.6 x (0.55 + 0.45 Fresnel), clamped to 1, written to the scene pass's metal/rough output. `waves` scales the ripple normals
// (1 = Boulevard), the sky mirrored from the stage's PMREM at full brightness (environment.envMap), `reflection` the SSR weight (0.6 = Boulevard's metalness), `colour` the body colour.
// 12 Nov 2026 (lake basin, night check tests/e2e/lake-night.mjs): at night the mirrored sky follows the rippled normal, and
// on the WebGL path (ctx.lampMap: no lamp is a light there) the lamps are mirrored from their positions (lamp glints).
// material.userData.ready resolves when the normal map has loaded (builder/sculpt/water.js waits for it).
import { createWaterMaterial } from '../../shared/materials/water-ssr.js';

const cache = new Map();
function tex(THREE, file) {
  if (!cache.has(file)) {
    let done; const ready = new Promise((r) => { done = r; });
    const t = new THREE.TextureLoader().load(new URL(file, import.meta.url).href, () => done(), undefined, () => done());
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
    cache.set(file, { t, ready });
  }
  return cache.get(file);
}

export function create(params, { THREE, preset, isWebGPU, environment = null, lampMap = null }) {
  const n = tex(THREE, 'tex/waternormals.jpg');
  // on the WebGL path (the lamp map) the lamps are not lights, so the water mirrors them from their positions (lamp glints)
  const lamps = lampMap?.lamps ? { array: lampMap.lamps, on: lampMap.uOn, colour: lampMap.uColour } : null;
  const m = createWaterMaterial({ normalMap: n.t, colour: params.colour, waves: params.waves, reflection: params.reflection, ssr: preset !== 'phone' && !!isWebGPU, envMap: environment?.envMap ?? null, night: environment?.night ?? null, lamps });
  m.name = 'water';
  m.userData.ready = n.ready;
  return m;
}
