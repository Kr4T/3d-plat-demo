// library/core/pbr.js: the PBR control layer every library material shares (Kereem, 11 Nov 2026: "PBR control is good").
// Every control is a TSL uniform, so a slider changes the look live with no shader rebuild and no rebake.
// Starts from r187: webgpu_materials (node-material channels), webgpu_loader_gltf_sheen (sheen on cloth),
// webgpu_reflection_roughness (roughness response on an environment), webgpu_tsl_procedural_terrain (mx_noise fields).
// Recipes: threejs-procedural-materials (one cause stack drives colour, roughness, normal and AO together; specular AA
// from normal derivatives), threejs-textures (sRGB colour, linear data maps, anisotropic filtering).
// Wetness is the standard porous-surface model (darken by porosity, roughness toward a water film, normal flattened
// under the film), written here; nothing is copied from the GPL rain example of threejs-precipitation-surfaces.
//
// API
//   createControls(defaults, extra = {}) -> { u, set(values), values(), schema }
//     defaults: { tint, roughness, metalness, wear, wetness, scale, sheen, sheenRoughness, sheenColor } (any subset)
//     extra:    { name: { value, min, max, step?, colour? } } material-specific controls (weave, pattern colours...)
//     u.<name>  the uniform node; set({ name: value }) updates it live; schema lists ranges for a GUI.
//   loadScan(base, prefix, quality) -> { color, normal, arh, ready, meta } textures from maps/<512|1k>/ (fetch_scan.py)
//   scanChannels({ scan, controls, coord, porosity, normalStrength, roughMean, retint }) -> { albedo, rough, normal, ao, height, wet, wear, st }
//     coord: a vec2 node in metres (uv in metres, or positionWorld.xz); the scale control is metres per tile.
//     roughMean: the scan's mean roughness (maps/<prefix>.json rough_mean); the roughness control is centred on it.
//   specularAA(roughNode, normalViewNode) -> roughness widened by the normal's screen-space variance.
//   wornMask(height, coord, wearNode) -> 0..1, wear on the exposed high points first, broken up by noise.
import * as THREE from 'three/webgpu';
import {
  uniform, float, vec2, vec3, texture, normalMap, mix, smoothstep, max, sqrt, dot, dFdx, dFdy, mx_noise_float, normalView, luminance,
} from 'three/tsl';

export const BASE_CONTROLS = {
  tint: { value: '#ffffff', colour: true },
  roughness: { value: 0.6, min: 0.02, max: 1 },
  metalness: { value: 0, min: 0, max: 1 },
  wear: { value: 0, min: 0, max: 1 },
  wetness: { value: 0, min: 0, max: 1 },
  scale: { value: 0.5, min: 0.02, max: 4, step: 0.01 },
  sheen: { value: 0, min: 0, max: 1 },
  sheenRoughness: { value: 0.5, min: 0.05, max: 1 },
  sheenColor: { value: '#ffffff', colour: true },
};

export function createControls(defaults = {}, extra = {}) {
  const schema = {};
  for (const [k, s] of Object.entries(BASE_CONTROLS)) if (k in defaults) schema[k] = { ...s, value: defaults[k] };
  for (const [k, s] of Object.entries(extra)) schema[k] = { ...s };
  const u = {};
  for (const [k, s] of Object.entries(schema)) {
    u[k] = s.colour ? uniform(new THREE.Color(s.value)) : uniform(Number(s.value));
    u[k].name = k;
  }
  const set = (values = {}) => {
    for (const [k, v] of Object.entries(values)) {
      if (!u[k]) continue;
      if (schema[k].colour) u[k].value.set(v); else u[k].value = Math.min(schema[k].max ?? Infinity, Math.max(schema[k].min ?? -Infinity, Number(v)));
    }
  };
  const values = () => Object.fromEntries(Object.entries(u).map(([k, n]) => [k, schema[k].colour ? '#' + n.value.getHexString() : n.value]));
  return { u, set, values, schema };
}

const cache = new Map();
function loadTex(href, srgb) {
  if (!cache.has(href)) {
    let done; const ready = new Promise((r) => { done = r; });
    const t = new THREE.TextureLoader().load(href, () => done(true), undefined, () => done(false));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    cache.set(href, { t, ready });
  }
  return cache.get(href);
}

/** The three maps fetch_scan.py writes, for one preset (phone: 512, high: 1k). `base` is the material folder URL. */
export function loadScan(base, prefix = 'base', quality = 'high') {
  const q = quality === 'phone' ? '512' : '1k';
  const at = (n) => new URL(`maps/${q}/${prefix}_${n}.jpg`, base).href;
  const c = loadTex(at('color'), true), n = loadTex(at('normal'), false), a = loadTex(at('arh'), false);
  const meta = fetch(new URL(`maps/${prefix}.json`, base)).then((r) => r.json()).catch(() => ({}));
  // a missing map must fail the page (and so the shot), never render a bare material that still passes
  const ready = Promise.all([c.ready, n.ready, a.ready]).then((ok) => { if (ok.includes(false)) throw new Error(`scan maps failed to load: ${base} ${prefix} ${q}`); return meta; });
  return { color: c.t, normal: n.t, arh: a.t, meta, ready };
}

export function specularAA(rough, nView = normalView) {
  const dx = dFdx(nView), dy = dFdy(nView);
  const variance = max(dot(dx, dx), dot(dy, dy)).mul(0.5).min(0.18);
  return sqrt(rough.mul(rough).add(variance)).clamp(0.02, 1);
}

export function wornMask(height, coord, wear) {
  const n = mx_noise_float(vec3(coord.mul(3.1), 1.7)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(vec3(coord.mul(17.0), 4.2)).mul(0.5).add(0.5);
  const exposure = height.mul(0.6).add(n.mul(0.3)).add(n2.mul(0.1));
  return smoothstep(float(1).sub(wear), float(1).sub(wear).add(0.18), exposure).mul(smoothstep(0, 0.05, wear));
}

/**
 * The shared channels of a scan-based material. Wetness and wear act on the same causes:
 *  - wet: albedo darkens and saturates by porosity, roughness drops toward a water film (0.06), and the micro normal
 *    flattens under the film; the low points (height) fill first.
 *  - wear: exposed high points fade toward a lighter, rougher, flatter surface (abraded fibre, polished stone edge...).
 */
export function scanChannels({ scan, controls, coord, porosity = 0.6, normalStrength = 1, roughMean = 0.6, retint = null }) {
  const u = controls.u;
  const st = coord.div(u.scale);
  const col = texture(scan.color, st), nrm = texture(scan.normal, st), arh = texture(scan.arh, st);
  const ao = arh.r, scanRough = arh.g, height = arh.b;
  const wet = smoothstep(height.sub(0.15), height.add(0.35), u.wetness.mul(1.3)).mul(u.wetness.min(1)).toVar();
  const wear = u.wear ? wornMask(height, coord, u.wear).toVar() : float(0);
  // retint { meanLum, detail }: keep only the scan's luminance detail and take the hue from the tint (a dyed or
  // bleached fibre whose scan was shot in another colour); otherwise the tint multiplies the scan's own colour.
  const base = retint
    ? (u.tint ?? vec3(1)).mul(mix(float(1), luminance(col.rgb).div(retint.meanLum), retint.detail ?? 1))
    : col.rgb.mul(u.tint ?? vec3(1));
  const worn = mix(base, vec3(luminance(base)).mul(1.12).min(1), wear.mul(0.55));
  const wetAlb = worn.mul(worn.mul(0.5).add(0.5)).mul(float(1).sub(float(porosity).mul(0.45)));
  const albedo = mix(worn, wetAlb, wet);
  const r0 = scanRough.add((u.roughness ?? float(roughMean)).sub(roughMean)).clamp(0.03, 1);
  const rWorn = mix(r0, r0.add(0.15).min(1), wear);
  const rough = mix(rWorn, float(0.06), wet.mul(0.92));
  const strength = float(normalStrength).mul(float(1).sub(wet.mul(0.8))).mul(float(1).sub(wear.mul(0.4)));
  const normal = normalMap(nrm, vec2(strength));
  return { albedo, rough, normal, ao, height, wet, wear, st };
}
