// water-ssr.js: the Boulevard world's reflections in one place: the screen-space-reflection settings per quality, the
// per-material SSR weight, and the lake water material. Shared by the builder (builder/stage.js, materials/water) and any
// page that draws the Boulevard world.
// r187 examples it starts from: webgpu_postprocessing_ssr (a scene pass with a metal/rough MRT read by SSRNode, whose
// first-generation trace weights each pixel's reflection by that metalness value and blurs it by roughness),
// webgpu_postprocessing_bloom_selective (a per-material `mrtNode` that overrides one MRT output of the scene pass) and
// webgpu_water (ripples from the three.js waternormals map scrolled at two scales by the TSL clock). Recipe:
// threejs-water-optics (Fresnel from the camera side with the water's index, never a constant opacity; normal bands filtered
// by the pixel footprint; reflection from the same sky as the surround: the scene's PMREM environment).
// Depends only on three/webgpu, three/tsl and three/addons.
//
// API
//   SSR_PRESETS = { high: { quality, blurQuality, maxDistance, thickness, intensity }, phone: null }
//     phone: null means no SSR (the phone budget rule); the lake still reflects the sky through the PMREM environment.
//   applySSRPreset(ssrNode, quality = 'high') -> { intensity } | null : sets an SSRNode's uniforms from the preset; the caller
//     adds `ssr.rgb * intensity` over the beauty pass (SSR outputs premultiplied colour, as the example adds it).
//   ssrWeight(material, weightNode, roughnessNode) : the material writes `metalrough = (weight, roughness)` into the scene
//     pass MRT, so SSR reflects it by `weight` while its own shading keeps its real metalness (water and wet sand stay
//     dielectric). Only for a scene pass that has a `metalrough` MRT output (High WebGPU): without an MRT, three.js would
//     write only this output and the beauty would be lost.
//   schlick(cosTheta, f0 = 0.02) -> float node : Fresnel reflectance, F0 of water from air ((1.333 - 1) / (1.333 + 1))^2.
//   createWaterMaterial({ normalMap, colour = '#224b52', waves = 1, reflection = 0.6, ssr = false, envMap = null }) -> MeshPhysicalNodeMaterial
//     envMap: optional, the scene's PMREM texture: the lake then mirrors the sky at full brightness (envMapIntensity 1)
//     instead of the scene's environmentIntensity (kept low for diffuse fill). night: optional TSL node (0..1): the night
//     sky gradient (builder/vfx/sky.js colours) mirrored by Fresnel off the rippled surface, since the PMREM's sky is black at
//     night. lamps: optional { array, on, colour } (lib/runtime/lights.mjs lampMap on the WebGL path): each lamp's GGX
//     specular off the ripples (lamp glints), as ClusteredLighting's real lights give it on WebGPU.
//     normalMap: a THREE.Texture (three.js waternormals.jpg, repeat-wrapped, NoColorSpace). A dielectric (ior 1.333) whose
//     PMREM sky reflection rises with Fresnel; ripples at 9 m and 23 m scrolled by the clock plus a 3.1 m band that fades out
//     below a few pixels; roughness widened by the unresolved slope (specular anti-aliasing); with ssr, an SSR weight of
//     reflection / 0.6 x (0.55 + 0.45 F), clamped to 1: the lamps and palms in the lake on High (a still lake at night
//     mirrors bright lights even head-on: the lights are HDR, so even a low reflectance shows them).
import * as THREE from 'three/webgpu';
import { float, vec2, vec3, color, texture, positionWorld, cameraPosition, normalMap as normalMapNode, time, max, pow, fwidth, smoothstep, normalize, mix, reflect, dot, Loop, Fn, If } from 'three/tsl';
import { ssrWeight } from './ssr-weight.js';

export const SSR_PRESETS = Object.freeze({
  // metres (the example's values are for a 2-unit scene); quality 0.75 = 48 of SSRNode's 64 steps; thickness 0.6 m keeps
  // palms and lamp posts from smearing down the wet paving
  high: Object.freeze({ quality: 0.75, blurQuality: 2, maxDistance: 160, thickness: 0.6, intensity: 1.0 }),
  phone: null,
});

export function applySSRPreset(ssrNode, quality = 'high') {
  const p = SSR_PRESETS[quality === 'phone' ? 'phone' : 'high'];
  if (!p || !ssrNode) return null;
  ssrNode.quality.value = p.quality; ssrNode.maxDistance.value = p.maxDistance; ssrNode.thickness.value = p.thickness;
  ssrNode.blurQuality = p.blurQuality;
  return { intensity: p.intensity };
}

export { ssrWeight };

export const schlick = (cosTheta, f0 = 0.02) => float(f0).add(float(1 - f0).mul(pow(float(1).sub(max(cosTheta, 0)), 5)));

export function createWaterMaterial({ normalMap, colour = '#224b52', waves = 1, reflection = 0.6, ssr = false, envMap = null, night = null, lamps = null } = {}) {
  const colourN = colour?.isNode ? colour : color(colour);
  const wavesN = waves?.isNode ? waves : float(waves);
  const reflN = reflection?.isNode ? reflection : float(reflection);
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x0b2830, roughness: 0.04, metalness: 0.0, ior: 1.333, clearcoat: 0 });
  m.name = 'water (water-ssr.js)';
  const P = positionWorld.xz;
  const fp = max(fwidth(P.x), fwidth(P.y)).max(1e-5);
  const n1 = texture(normalMap, P.div(9.0).add(vec2(time.mul(0.012), time.mul(0.007)))).rgb;
  const n2 = texture(normalMap, P.div(23.0).sub(vec2(time.mul(0.006), time.mul(-0.009)))).rgb;
  const n3 = texture(normalMap, P.div(3.1).add(vec2(time.mul(-0.02), time.mul(0.016)))).rgb;
  const fine = smoothstep(0.25, 0.04, fp); // the 3.1 m band only where a pixel resolves it
  const nrm = mix(n1.add(n2).mul(0.5), n1.add(n2).add(n3).div(3), fine.mul(0.6));
  m.normalNode = normalMapNode(nrm, vec2(0.35).mul(wavesN));
  // deep water scatters little light back: the body colour is a dim tint under the reflections (x 0.3), so the sky, lamps
  // and palms in it read first, as on a real lake at night; `colour` keeps Boulevard's hue
  m.colorNode = colourN.mul(0.3);
  // specular anti-aliasing: the slope a pixel cannot resolve widens the highlight instead of sparkling
  const variance = smoothstep(0.02, 0.6, fp).mul(0.08);
  const rough = float(0.04).mul(0.04).add(variance).sqrt();
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  // the sky in the lake as bright as the sky above it: the scene's environment intensity is set low for diffuse fill
  // (builder/environment.js), which would leave a mirror black at night; with envMap the material reads the same PMREM at 1
  if (envMap) { m.envMap = envMap; m.envMapIntensity = 1; }
  // the night sky in the lake: at night the visible sky is a gradient drawn over the background (builder/vfx/sky.js, the
  // same colours here), not part of the PMREM, whose SkyMesh is black once the sun is down; the lake mirrors that gradient
  // by Fresnel along the reflected ray (approximated by the level surface), weighted by night^1.5 as the sky draws it
  // the rippled normal in world space, for the night terms below: the same bands and scale as normalNode (uv = (x, -z), so
  // tangent x is +x and tangent y is -z)
  const nt = nrm.mul(2).sub(1), s = float(0.35).mul(wavesN);
  const Nw = normalize(vec3(nt.x.mul(s), nt.z, nt.y.mul(s).negate()));
  const V = normalize(cameraPosition.sub(positionWorld));
  let emissive = null;
  if (night) {
    // the reflected ray, off the rippled surface: the ripples move the sky's gradient in the lake (12 Nov 2026: at night a
    // level-surface mirror read as a flat dark slab)
    const R = reflect(V.negate(), Nw), up = R.y.max(0);
    const grad = mix(vec3(0.03, 0.045, 0.09), vec3(0.006, 0.01, 0.028), up.pow(0.6));
    emissive = grad.mul(schlick(dot(Nw, V).max(0))).mul(night.pow(1.5)).mul(0.94);
  }
  // lamp glints on the WebGL path (lamps: { array: uniformArray of vec4 (x, y, z, candela), on: 0..1 (the lamps' own switch),
  // colour }, from lib/runtime/lights.mjs lampMap): each lamp's specular off the rippled surface, GGX with the material's own
  // roughness and Fresnel, I / d^2 as three.js's physical point lights (decay 2): what ClusteredLighting gives on WebGPU
  if (lamps?.array) {
    // the lobe about as wide as the ripples' own slopes (normal scale 0.35 x waves: tilts of about 0.1-0.2 rad), roughness
    // 0.2 x waves (at least the material's): a lamp's image breaks into a streak of glints down the water, as on a real lake
    // at night (0.3 merged the streaks into one wash on the phone shot). GGX is normalised: widening it spreads the lamp's
    // light, it does not add any
    const rg = rough.max(wavesN.mul(0.2).clamp(0.04, 0.6)), a2 = rg.mul(rg).mul(rg.mul(rg)), nv = dot(Nw, V).max(0.1);
    // the loop lives in an Fn: TSL control flow outside one belongs to no stack and is never emitted (it summed nothing)
    // and only while the lamps are on: by day the loop is skipped (review of PR #24: it ran on every water pixel at noon)
    const on = lamps.on ?? float(1);
    const glintSum = Fn(() => {
      const acc = vec3(0).toVar();
      If(on.greaterThan(0), () => {
        Loop(lamps.array.array?.length ?? 16, ({ i }) => {
          const Lp = lamps.array.element(i), Ld = Lp.xyz.sub(positionWorld), d2 = dot(Ld, Ld).max(1);
          const l = Ld.div(d2.sqrt()), H = normalize(l.add(V)), nh = dot(Nw, H).clamp(0, 1);
          const D = a2.div(nh.mul(nh).mul(a2.sub(1)).add(1).pow(2).mul(Math.PI));
          const F = schlick(dot(V, H).max(0)), nl = dot(Nw, l).max(0);
          acc.addAssign(D.mul(F).mul(Lp.w).div(d2).mul(nl.greaterThan(0).select(float(0.25).div(nv), float(0))));
        });
      });
      return acc;
    });
    const acc = glintSum();
    const glints = acc.mul(lamps.colour ?? vec3(1, 0.8, 0.55)).mul(on);
    emissive = emissive ? emissive.add(glints) : glints;
  }
  if (emissive) m.emissiveNode = emissive;
  if (ssr) {
    const F = schlick(V.y.abs()); // the lake is level: N . V is the view ray's height (camera above the water)
    ssrWeight(m, reflN.div(0.6).mul(float(0.55).add(F.mul(0.45))).clamp(0, 1), rough); // reflection 0.6 (Boulevard) = 0.55 head-on, 1 at grazing
  }
  return m;
}
