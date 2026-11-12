// Automatic r187 material assignment for ANY GLB (builder capability; coordinator, 11 Nov 2026: "load any GLB and apply
// r187 materials automatically", generic for people, aliens, animals and props). Every glTF PBR material becomes one r187
// node material that keeps the asset's own maps and adds, per texel, what its texels are (auto-recipe.js classes, the
// same rule here in TSL):
//   - skin texels: subsurface scattering (MeshSSSNodeMaterial thickness, masked: webgpu_materials_sss);
//   - cloth texels (matte non-metal, non-skin): sheen (webgpu_loader_gltf_sheen);
//   - metal texels: the glTF metalness, with specular anti-aliasing (library/core/pbr.js specularAA);
//   - everything: base colour x tint, roughness and metalness scaled by live controls (library createControls), normal
//     and occlusion maps kept, environment response set by the recipe.
// The recipe (which layers are on) comes from the material's own maps (materialStats on a 64 x 64 read-back).
//
//   const made = await autoMaterials(root, { quality })   // replaces every mesh material in place
//   made.list() -> [{ mesh, material, recipe, share }], made.controls[<material name>].set({ tint, roughness, ... })
import * as THREE from 'three/webgpu';
import { texture, uv, vec3, float, uniform, max, min, mix, smoothstep, step, normalView, sRGBTransferOETF } from 'three/tsl';
import { createControls, specularAA } from '../library/core/pbr.js';
import { materialStats, chooseRecipe, mapTrust, SKIN_RULE, HAIR_RULE, HAIR_ROUGH, HAIR_SPEC, SKIN_SPEC, CLOTH_SPEC, CLOTH_MIN_ROUGH, CLASS_ROUGH, COAT, COAT_ROUGH, METAL_MIN_LUM, METAL_MIN, CLOTH_ROUGH, SKIN_ROUGH, DEFAULT_ROUGH } from './auto-recipe.js';

function readPixels(tex, size = 64) {
  const img = tex?.image;
  if (img?.data && img.width && img.height) {            // a DataTexture: nearest samples of its own bytes
    const out = new Uint8ClampedArray(size * size * 4), c = img.data.length / (img.width * img.height);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const s = (Math.floor(y * img.height / size) * img.width + Math.floor(x * img.width / size)) * c;
      out.set([img.data[s], img.data[s + 1], img.data[s + 2], c > 3 ? img.data[s + 3] : 255], 4 * (y * size + x));
    }
    return out;
  }
  if (!img || typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(img, 0, 0, size, size); return g.getImageData(0, 0, size, size).data; } catch { return null; }
}

/** TSL skin mask (0..1) of an sRGB colour node, the auto-recipe SKIN_RULE (hue band, saturation, luminance), soft-edged. */
function skinMask(c) {
  const mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), d = mx.sub(mn);
  const sat = d.div(max(mx, 1e-4));
  // red is the max and hue = 60 * (g - b) / d in [hueMin, hueMax] degrees
  const hue = float(60).mul(c.g.sub(c.b)).div(max(d, 1e-4));
  const redMax = step(c.g, c.r).mul(step(c.b, c.r));
  const lum = c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722));
  const R = SKIN_RULE;
  // soft edges INSIDE the band: the mask is 0 wherever auto-recipe's classifyTexel says not skin, so nothing the CPU
  // classes as cloth scatters (run 2, 11 Nov: red check texels at hue -5.7 got 0.3 skin from an edge straddling -5)
  const band = (x, lo, hi, w) => smoothstep(lo, lo + 2 * w, x).mul(float(1).sub(smoothstep(hi - 2 * w, hi, x)));
  return redMax.mul(band(hue, R.hueMin, R.hueMax, 4)).mul(band(sat, R.satMin, R.satMax, 0.04)).mul(band(lum, R.lumMin, R.lumMax, 0.02));
}

/** TSL dark-fibre mask (hair, beard, black fur): the auto-recipe HAIR_RULE, soft-edged. */
function hairMask(c) {
  const mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  const sat = mx.sub(mn).div(max(mx, 1e-4)), lum = c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722));
  const H = HAIR_RULE;
  return float(1).sub(smoothstep(H.lumMax - 0.015, H.lumMax + 0.015, lum)).mul(float(1).sub(smoothstep(H.satMax - 0.05, H.satMax + 0.05, sat)));
}

export function autoMaterial(src, { quality = 'high', body = null } = {}) {
  const base = src.map || null, mr = src.metalnessMap || src.roughnessMap || null;
  const basePx = readPixels(base) || new Uint8ClampedArray([255, 255, 255, 255]), mrPx = readPixels(mr);
  const trust = mapTrust(basePx, mrPx);
  const stats = materialStats(basePx, mrPx,
    mr ? { metal: src.metalness ?? 1, rough: src.roughness ?? 1 } : { metal: src.metalness ?? 0, rough: src.roughness ?? 0.8 }, trust);
  stats.trust = trust;
  const recipe = chooseRecipe(stats, { body });
  const controls = createControls({ tint: '#ffffff', roughness: 1, metalness: 1, sheen: recipe.sheen, sheenRoughness: recipe.sheenRoughness, sheenColor: '#ffffff' },
    { skin: { value: recipe.sss ? 1 : 0, min: 0, max: 1 } });
  const u = controls.u;
  const m = recipe.sss ? new THREE.MeshSSSNodeMaterial() : new THREE.MeshPhysicalNodeMaterial();
  m.name = src.name || 'auto';
  const t = (tx) => texture(tx, uv(tx.channel ?? 0));
  const albedo = base ? t(base).rgb.mul(vec3(src.color.r, src.color.g, src.color.b)) : vec3(src.color.r, src.color.g, src.color.b);
  m.colorNode = albedo.mul(u.tint);
  // the class rules are written for sRGB texels (auto-recipe.js); the sampled albedo is linear, so convert exactly (a 2.2 power is far off near black, where dark fibre lives)
  const srgb = sRGBTransferOETF(albedo.max(0));
  const hairC = hairMask(srgb), skinC = skinMask(srgb).mul(float(1).sub(hairC));
  // a degenerate map (mapTrust) is not used: non-metal, and roughness per texel class (skin SKIN_ROUGH, else DEFAULT_ROUGH)
  // an untrusted map (degenerate, or near-flat matte: research PR #55 finding 2): roughness by texel class (CLASS_ROUGH)
  const roughMap = mr && trust.rough ? t(mr).g.mul(src.roughness ?? 1)
    : mr ? mix(mix(float(CLASS_ROUGH.cloth), float(CLASS_ROUGH.skin), skinC), float(CLASS_ROUGH.hair), hairC) : float(src.roughness ?? 0.8);
  // metal only where the albedo is bright enough to be metal (a dark "metal" texel is leather: the hero's belt, 11 Nov 2026)
  const lumS = srgb.r.mul(0.2126).add(srgb.g.mul(0.7152)).add(srgb.b.mul(0.0722));
  const metalMap = (mr && trust.metal ? t(mr).b.mul(src.metalness ?? 1) : mr ? float(0) : float(src.metalness ?? 0))
    .mul(smoothstep(METAL_MIN_LUM - 0.03, METAL_MIN_LUM + 0.03, lumS));
  const metal = metalMap.mul(u.metalness).clamp(0, 1);
  let rough = roughMap.mul(u.roughness).clamp(0.03, 1);
  // dark fibre: rough, half the dielectric specular, no sheen, no SSS (coordinator, 11 Nov 2026)
  const hair = hairC.mul(float(1).sub(step(METAL_MIN, metal)));
  rough = mix(rough, max(rough, float(HAIR_ROUGH)), hair);
  // cloth (matte non-metal, non-skin, non-fibre texels): roughness floor and a third of the specular (CLOTH_MIN_ROUGH, CLOTH_SPEC)
  const clothC = float(1).sub(skinC).mul(float(1).sub(hair)).mul(float(1).sub(step(METAL_MIN, metal)))
    .mul(smoothstep(CLOTH_ROUGH - 0.05, CLOTH_ROUGH + 0.05, rough));
  rough = mix(rough, max(rough, float(CLOTH_MIN_ROUGH)), clothC);
  // specular intensity per class: skin F0 0.028 (IOR 1.4), dark fibre a quarter, cloth a third, everything else glTF's default
  m.specularIntensityNode = mix(mix(mix(float(1), float(SKIN_SPEC), skinC), float(CLOTH_SPEC), clothC), float(HAIR_SPEC), hair);
  // a low clearcoat on glossy texels that are not skin, cloth, dark fibre or metal (leather, accessories, eyes): COAT.other
  const otherC = float(1).sub(skinC).mul(float(1).sub(hair)).mul(float(1).sub(step(METAL_MIN, metal)))
    .mul(float(1).sub(smoothstep(CLOTH_ROUGH - 0.05, CLOTH_ROUGH + 0.05, rough)));
  m.clearcoatNode = otherC.mul(COAT.other); m.clearcoatRoughnessNode = float(COAT_ROUGH);
  if (recipe.metalSpecAA) rough = mix(rough, specularAA(rough, normalView), step(METAL_MIN, metal));
  m.roughnessNode = rough; m.metalnessNode = metal;
  if (src.normalMap) { m.normalMap = src.normalMap; m.normalScale = src.normalScale; }
  if (src.aoMap) { m.aoMap = src.aoMap; m.aoMapIntensity = src.aoMapIntensity; }
  if (src.emissiveMap || (src.emissive && src.emissive.getHex() !== 0)) { m.emissive = src.emissive; m.emissiveMap = src.emissiveMap; m.emissiveIntensity = src.emissiveIntensity; }
  if (src.transparent || src.alphaTest > 0) { m.transparent = src.transparent; m.alphaTest = src.alphaTest; m.opacity = src.opacity; if (base) m.alphaMap = null; }
  m.side = src.side;
  const skin = skinC.mul(float(1).sub(step(METAL_MIN, metal))).mul(u.skin);
  if (recipe.sheen > 0) {
    const cloth = float(1).sub(skin).sub(hair).max(0).mul(float(1).sub(step(METAL_MIN, metal))).mul(smoothstep(CLOTH_ROUGH - 0.05, CLOTH_ROUGH + 0.05, rough));
    // r187: sheenNode IS the sheen colour (MeshPhysicalNodeMaterial: vec3(sheenNode); there is no sheenColorNode). It
    // follows the cloth's own colour, so dark or coloured cloth never gets a white sheen.
    m.sheenNode = albedo.mul(u.sheenColor).mul(cloth).mul(u.sheen); m.sheenRoughnessNode = u.sheenRoughness;
  }
  if (recipe.sss) {
    // r187 webgpu_materials_sss parameters; the scattered light is the skin's own albedo (no fixed tint), masked to the
    // skin texels (nothing elsewhere scatters)
    m.thicknessColorNode = albedo.mul(skin);
    m.thicknessDistortionNode = uniform(0.12); m.thicknessAmbientNode = uniform(0.0); m.thicknessAttenuationNode = uniform(0.8);
    m.thicknessPowerNode = uniform(8.0); m.thicknessScaleNode = uniform(quality === 'phone' ? 0.25 : 0.35);
  }
  m.envMapIntensity = recipe.envIntensity;
  return { material: m, recipe, stats, controls };
}

export async function autoMaterials(root, opts = {}) {
  const made = new Map(), rows = [], controls = {};
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((src) => {
      if (!made.has(src)) made.set(src, autoMaterial(src, opts));
      const r = made.get(src); controls[r.material.name] = r.controls;
      rows.push({ mesh: o.name, material: r.material.name, recipe: r.recipe.name, share: r.stats.share, trust: r.stats.trust,
        maps: { base: !!src.map, metallicRoughness: !!(src.metalnessMap || src.roughnessMap), normal: !!src.normalMap } });
      return r.material;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    o.castShadow = true; o.receiveShadow = true;
  });
  return { controls, uniforms: {}, list: () => rows };
}
