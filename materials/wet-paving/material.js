// wet-paving: the paving surface (slot `surface` of wet-paving). r187 examples: webgpu_postprocessing_ssr (a wet floor the
// SSR pass reflects: low roughness and some metalness at night, written to the metal/rough MRT the stage reads) and
// webgpu_generator_city (world-space TSL surfaces). Boulevard City's groundMaterial (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/main.js) for its paver (GC.PAVE: concrete_pavers_03, 2.5 m a tile, roughness 0.7) and plaza
// (GC.PLAZA: large_sandstone_blocks_01, 4 m, 0.6) classes, unchanged: Poly Haven CC0 diffuse and OpenGL normal maps in world
// space at two scales against repeats (x 2.7, offset 0.37, 0.71), macro (0.045 / m) and micro (0.31 / m) variation, the CC0
// albedo x 0.82; at night the stone turns glossy (roughness x mix(1, 0.42, night)) and a little metallic (0.3 x night) so
// SSR shows the lamps in it. `wetness` scales that night gloss (1 = Boulevard), `tint` multiplies the albedo (white =
// Boulevard). 512 px maps on Phone, 1k on High (main.js TEXQ). Left out: the class grid, the build-mode reveal and the far
// Sentinel-2 tint (smoothstep 140-900 m), which belong to Boulevard's whole-map ground. On the WebGL light-map path
// (ctx.lampMap) the lamps' baked light is added as emission: albedo / pi times the lamp map (lib/runtime/lights.mjs).
// Upgraded 11 Nov 2026 (scene quality pass; Kereem: "im not seeing proper reflection"): puddles where the environment's
// rain wetness is up (darker, mirror-smooth, relief drowned), and on High WebGPU an SSR weight with a Fresnel term for the
// water film (shared/materials/ssr-weight.js). At the defaults with no rain the shading is Boulevard's; the SSR weight is
// higher at grazing angles than Boulevard's metalness alone.
// material.userData.ready resolves when the image files have loaded (builder/sculpt/paving.js waits for it).
const SETS = {
  pavers: { asset: 'concrete_pavers_03', metres: 2.5, roughness: 0.7 },
  sandstone: { asset: 'large_sandstone_blocks_01', metres: 4, roughness: 0.6 },
};
import { ssrWeight } from '../../shared/materials/ssr-weight.js';

const cache = new Map();
function tex(THREE, file, srgb) {
  if (!cache.has(file)) {
    let done; const ready = new Promise((r) => { done = r; });
    const t = new THREE.TextureLoader().load(new URL(file, import.meta.url).href, () => done(), undefined, () => done());
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    cache.set(file, { t, ready });
  }
  return cache.get(file);
}

export function create(params, { THREE, TSL, preset, isWebGPU = false, lampMap = null, environment = null }) {
  const { texture, positionWorld, cameraPosition, vec2, mix, max, smoothstep, mx_noise_float, normalMap, color, float } = TSL;
  const S = SETS[params.stoneSet] || SETS.pavers, q = preset === 'phone' ? '512' : '1k';
  const diff = tex(THREE, `tex/${q}/${S.asset}_diff.jpg`, true), nor = tex(THREE, `tex/${q}/${S.asset}_nor.jpg`, false);
  const tint = params.tint?.isNode ? params.tint : color(params.tint);
  const wetness = params.wetness?.isNode ? params.wetness : float(params.wetness);
  const night = environment?.night ?? float(1); // the stage's night term (Boulevard's uNight); no stage: night
  const xz = positionWorld.xz, uvA = xz.div(S.metres), uvB = xz.div(S.metres * 2.7).add(vec2(0.37, 0.71)); // two scales against repeats
  const macro = mx_noise_float(xz.mul(0.045)).mul(0.5).add(0.5), micro = mx_noise_float(xz.mul(0.31)).mul(0.5).add(0.5);
  const alb = mix(texture(diff.t, uvA), texture(diff.t, uvB), macro.mul(0.55)).rgb.mul(tint);
  const shade = mix(float(0.86), float(1.1), macro).mul(mix(float(0.95), float(1.04), micro)); // macro variation
  const albedo = alb.mul(shade).mul(0.82); // CC0 albedos are bright; Riyadh stone under a hard sun
  const wet = night.mul(wetness);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  m.name = 'wet-paving';
  // puddles (scene quality pass, 11 Nov; our own field, no GPL puddle code): where the environment's rain wetness is up,
  // water stands in the low spots of one broad noise field; there the stone darkens, goes mirror-smooth and its relief
  // drowns (normal scale and roughness from the same mask: threejs-precipitation-surfaces, "puddles are not only roughness")
  const rain = environment?.wetness ?? float(0);
  const field = mx_noise_float(xz.mul(0.13).add(vec2(3.7, 1.9))).mul(0.5).add(0.5).add(micro.sub(0.5).mul(0.12));
  const puddle = smoothstep(mix(float(0.86), float(0.56), rain), mix(float(0.9), float(0.62), rain), field).mul(wet).mul(rain.mul(4).clamp(0, 1));
  m.colorNode = albedo.mul(mix(float(1), float(0.62), puddle));
  m.normalNode = normalMap(texture(nor.t, uvA).rgb, vec2(float(1).sub(puddle.mul(0.92))));
  const rough = float(S.roughness).mul(mix(float(1), float(0.42), wet)).clamp(0.08, 1.0); // polished stone at night (Boulevard)
  m.roughnessNode = mix(rough, float(0.04), puddle);
  m.metalnessNode = wet.mul(0.3); // lets SSR reflect lamps and screens at night
  // the SSR weight on High WebGPU (shared/materials/ssr-weight.js): Boulevard's night metalness, plus a Fresnel term for the
  // water film on wet stone (grazing views mirror more), and near-mirror puddles; shading keeps Boulevard's metalness
  if (preset !== 'phone' && isWebGPU) {
    const V = cameraPosition.sub(positionWorld).normalize();
    const F = float(0.04).add(float(0.96).mul(float(1).sub(V.y.abs()).pow(5)));
    // a wet film reflects as a smoother surface than the stone under it: the SSR reads roughness x 0.55 (less blur), so the
    // lamps streak down the paving as on a wet night street
    ssrWeight(m, max(wet.mul(float(0.45).add(F.mul(0.5))), puddle.mul(0.95)).clamp(0, 1), m.roughnessNode.mul(mix(float(1), float(0.55), wet)));
  }
  if (lampMap) m.emissiveNode = lampMap.diffuse(albedo); // lamp pools on the WebGL path (no light falls on it by day)
  m.userData.ready = Promise.all([diff.ready, nor.ready]);
  return m;
}
