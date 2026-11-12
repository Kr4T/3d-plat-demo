// palms.js: the Boulevard date palm's look (Phoenix dactylifera) as TSL node materials, shared by the builder
// (components/date-palm/look.js, materials/palm-bark, materials/palm-frond) and any page that draws the Boulevard world.
// The palm's shape stays in its GLB files (3DPLAT's own Blender model: shape, UVs and baked AO in vertex colour).
// r187 examples it starts from: webgpu_loader_gltf (node materials on a glTF model), webgpu_materials_alphahash (hashed
// alpha resolved by a temporal pass: the leaflets' edges on High, where the stage runs TRAA), webgpu_instance_uniform (per
// instance values read by the material) and webgpu_custom_fog_scattering (TreeGenerator foliage lit through by the sun).
// Recipe: threejs-procedural-vegetation (rooted wind: no motion at the root, growing with height; each frond bends about
// its own base with its own phase; leaflets flutter along their length; leaf cards keep their roots), and
// threejs-procedural-materials (derivative normals from a height field: the bark's fibres and leaf-boot rings).
// Copied from Boulevard City's palm.js (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/palm.js,
// `palmMaterials`) and upgraded on 11 Nov 2026 (Kereem: "the tree needs r187"): see "What changed" below.
// Depends only on three/webgpu and three/tsl.
//
// API
//   createPalmMaterial({ part = 'trunk' | 'frond' | 'card', quality = 'high' | 'phone', lod = 'lod0' | 'lod1' | 'card',
//                        maps, lean = 0, wind = 1, frondTint = '#ffffff', environment = null, temporalAA = false })
//     -> MeshStandardNodeMaterial or MeshPhysicalNodeMaterial
//     maps: { frond, frondN, card, cardN } THREE.Textures (the palm's baked maps: frond_maps.png, frond_normal.png,
//           card_maps.png, card_normal.png, glTF UV convention: flipY false, NoColorSpace). loadPalmMaps(baseURL) loads them.
//     lean (degrees), wind (x Boulevard's sway), frondTint: numbers / '#rrggbb', or per-instance TSL nodes.
//     environment: optional uniforms { sunDir, sunColor (sun colour x 1.4), day, night, moonDir }.
//     temporalAA: true when a TRAA pass resolves the frame (High WebGPU): the leaflets use hashed alpha and their edges
//                 resolve smoothly; otherwise alpha test with Boulevard's mip boost. alphaToCoverage is on either way (it
//                 smooths the edges wherever the target is multisampled).
//   loadPalmMaps(baseURL) -> { frond, frondN, card, cardN } (cached per base URL)
//   PALM_MODEL_HEIGHT = 10.47 (palm_lod0 at scale 1)
//
// What changed from palm.js (all within one draw per slot and the same triangles):
//   - translucency: sunlight (and moonlight) through the thin leaflets with a forward-scatter lobe toward the viewer and a
//     wrapped back term, weighted by the baked thickness, in the leaf's transmitted colour (yellower than its reflected
//     colour), instead of palm.js's back-face emissive term alone;
//   - wind: each frond bends about its base with its own phase (from its baked random) as well as the whole-palm sway and
//     the leaflet flutter, so the crown no longer moves as one piece;
//   - edges: hashed alpha under TRAA on High (webgpu_materials_alphahash), alpha-to-coverage everywhere;
//   - bark: a derivative normal from the fibre and boot-ring height field (the trunk was lit flat);
//   - AO: the baked AO, plus the inner crown darker toward the frond bases (leaflets shade each other there);
//   - the trunk: a little lighter fibre colour and a rim sheen from the sky at grazing angles (it read near-black at night).
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, mix, smoothstep, sin, time, hash, instanceIndex, positionLocal, normalWorld, normalView,
  positionView, normalMap, texture, uv, max, dot, uniform, mx_noise_float, fract, fwidth, log2, color, tan, radians, pow,
  cameraPosition, positionWorld, normalize, cross, dFdx, dFdy, abs, sign, faceDirection,
} from 'three/tsl';

export const PALM_MODEL_HEIGHT = 10.47;

const mapCache = new Map();
export function loadPalmMaps(baseURL) {
  const key = String(baseURL);
  if (!mapCache.has(key)) {
    const files = { frond: 'frond_maps.png', frondN: 'frond_normal.png', card: 'card_maps.png', cardN: 'card_normal.png' };
    const out = {};
    for (const [k, f] of Object.entries(files)) {
      const t = new THREE.TextureLoader().load(new URL(f, baseURL).href);
      t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.anisotropy = 4; // glTF UV convention; data, not colour
      t.name = `date-palm ${k}`;
      out[k] = t;
    }
    mapCache.set(key, out);
  }
  return mapCache.get(key);
}

/** A view-space normal bent by a height field (metres) through its screen derivatives (Mikkelsen's surface gradient, as
 * three.js's BumpMapNode does for a texture; here for any procedural height). */
export function derivativeNormal(height, strength = 1) {
  const dpdx = dFdx(positionView), dpdy = dFdy(positionView), n = normalView;
  const r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const h = float(height).mul(strength), dh = vec2(dFdx(h), dFdy(h));
  const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
  return normalize(abs(det).mul(n).sub(grad));
}

export function createPalmMaterial({ part = 'frond', quality = 'high', lod = 'lod0', maps, lean = 0, wind = 1, frondTint = '#ffffff', environment = null, temporalAA = false } = {}) {
  const preset = quality === 'phone' ? 'phone' : 'high';
  const sunDir = environment?.sunDir ?? uniform(new THREE.Vector3(0.3, 0.9, 0.2).normalize());
  // environment.sunColor is the sun's colour x 1.4 (builder/environment.js); palm.js's uPalmSunCol is the colour x day
  const sunCol = environment?.sunColor && environment?.day ? environment.sunColor.div(1.4).mul(environment.day) : uniform(new THREE.Color(1, 0.95, 0.85));
  const moonDir = environment?.moonDir ?? null, night = environment?.night ?? float(0);
  const tint = frondTint?.isNode ? frondTint : color(frondTint);
  const phase = hash(instanceIndex).mul(6.283);
  const num = (v) => (typeof v === 'number' ? float(v) : v);
  const bend = tan(radians(num(lean))).div(PALM_MODEL_HEIGHT), gust = num(wind);
  // rooted wind: the palm sways (none at the root, growing with height squared), each frond bends about its base with its
  // own phase (along^2: none where it joins the crown), the leaflets flutter along their length; then the rooted lean
  const shape = (leafMask, along, frondRand) => {
    const y = positionLocal.y, sway = sin(time.mul(1.1).add(phase)).mul(0.16).add(sin(time.mul(2.3).add(phase.mul(1.7))).mul(0.05)).mul(y.div(10.0).pow(2.0));
    const fPhase = phase.add(frondRand.mul(6.283));
    const frondBob = sin(time.mul(1.7).add(fPhase)).mul(0.09).add(sin(time.mul(3.1).add(fPhase.mul(1.3))).mul(0.03)).mul(along.mul(along)).mul(leafMask);
    const flutter = sin(time.mul(5.0).add(positionLocal.x.mul(2.0)).add(fPhase)).mul(0.05).mul(along).mul(leafMask);
    const swayed = positionLocal.add(vec3(sway, flutter.add(frondBob), sway.mul(0.6)).mul(gust));
    return swayed.add(vec3(y.mul(y).mul(bend), 0, 0));
  };
  const leafColour = (variation, along, oldness, frondRand) => {
    // Phoenix dactylifera leaflets: grey-green with a bluish wax bloom, paler toward the tip, yellowed on old fronds
    const young = mix(vec3(0.16, 0.22, 0.12), vec3(0.30, 0.36, 0.22), along.mul(0.7).add(variation.mul(0.3)));
    const tinted = young.mul(frondRand.mul(0.22).add(0.89)).mul(vec3(0.97, 1.0, 1.04));
    return mix(tinted, vec3(0.50, 0.42, 0.22).mul(variation.mul(0.3).add(0.8)), oldness).mul(tint);
  };
  // light through a thin leaf: a forward-scatter lobe (light behind the leaf, toward the viewer) and a wrapped back term,
  // in the transmitted colour (chlorophyll passes yellow-green), weighted by how thin the leaf is there
  const V = normalize(cameraPosition.sub(positionWorld));
  const through = (L, col, thin, leafCol) => {
    const fwd = pow(max(dot(V, L.negate()), 0), 6).mul(1.6);
    const back = max(dot(normalWorld.negate(), L), 0).mul(0.6).add(max(dot(normalWorld, L), 0).mul(0.15));
    return leafCol.mul(vec3(1.35, 1.55, 0.55)).mul(col).mul(fwd.add(back)).mul(thin);
  };

  if (part === 'card') { // the far impostor (palm.js `card`)
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
    m.alphaToCoverage = true;
    const q = uv(), cm = texture(maps.card, q), cn = texture(maps.cardN, q);
    const ao = cm.r, h = cm.g, kind = cm.b, alpha = cm.a;
    const isLeaf = kind.greaterThan(0.3), v = hash(instanceIndex.add(3));
    const lc = leafColour(float(0.5), h, smoothstep(0.6, 0.95, kind), v);
    m.colorNode = isLeaf.select(lc, vec3(0.38, 0.30, 0.22)).mul(ao.mul(0.6).add(0.4));
    const mip = max(log2(max(fwidth(q.x).mul(1024), fwidth(q.y).mul(512))), 0);
    m.opacityNode = alpha.mul(mip.mul(0.5).add(1));
    m.roughnessNode = float(0.7);
    m.normalNode = normalMap(cn, vec2(1, -1));
    m.emissiveNode = isLeaf.select(through(sunDir, sunCol, float(0.5), lc).mul(0.5), vec3(0));
    m.positionNode = shape(float(0), float(0), float(0));
    m.name = 'date-palm card';
    return m;
  }

  // the near palm (palm.js `full`): physical fronds (sheen) on High's near LOD, standard ones elsewhere (full(true))
  const leaf = part === 'frond';
  const pick = (leafValue, barkValue) => (leaf ? leafValue : barkValue);
  const physical = preset === 'high' && lod === 'lod0';
  const hashed = leaf && temporalAA && preset === 'high';
  const opts = { side: THREE.DoubleSide, ...(hashed ? { alphaHash: true } : { alphaTest: 0.5 }) };
  const m = physical ? new THREE.MeshPhysicalNodeMaterial(opts) : new THREE.MeshStandardNodeMaterial(opts);
  m.alphaToCoverage = leaf;
  const c = attribute('color', 'vec4'), ao = c.x, along = c.y, frondRand = c.z, kind = c.w;
  const oldness = smoothstep(0.6, 0.95, kind);
  const q = uv(), fm = texture(maps.frond, q), fn = texture(maps.frondN, q);
  const leafAo = fm.r, thick = fm.g, variation = fm.b, alpha = fm.a;
  const rachis = smoothstep(0.85, 1.0, thick);
  // bark: fibrous grey-brown, vertical fibres, darker in the crevices between the boots (baked AO), lighter cut ends; its
  // relief (metres) gives the derivative normal: fine fibres and the step at each leaf-boot ring
  const fib = mx_noise_float(vec3(positionLocal.x.mul(18.0), positionLocal.y.mul(2.5), positionLocal.z.mul(18.0))).mul(0.5).add(0.5);
  const ring = fract(q.y.mul(3.4));
  const barkCol = mix(vec3(0.36, 0.28, 0.20), vec3(0.55, 0.46, 0.35), fib).mul(ao.mul(ao).mul(0.8).add(0.2)).mul(ring.mul(0.12).add(0.94));
  const barkHeight = fib.mul(0.006).add(smoothstep(0.0, 0.85, ring).mul(smoothstep(1.0, 0.9, ring)).mul(0.03));
  const lc = mix(leafColour(variation, along, oldness, frondRand), vec3(0.55, 0.5, 0.3), rachis.mul(0.6));
  m.colorNode = pick(lc.mul(leafAo.mul(0.5).add(0.5)).mul(ao.mul(0.5).add(0.5)), barkCol);
  // keep the leaflets' coverage as they shrink below a pixel (palm.js): boost alpha by the mip level the map is read at
  const mip = max(log2(max(fwidth(q.x).mul(256), fwidth(q.y).mul(1024))), 0);
  m.opacityNode = pick(alpha.mul(mip.mul(0.6).add(1)), float(1));
  m.roughnessNode = pick(float(0.55).sub(rachis.mul(0.1)), float(0.92));
  const crown = smoothstep(0.0, 0.45, along).mul(0.35).add(0.65); // leaflets near the crown's centre shade each other
  m.aoNode = pick(leafAo.mul(ao).mul(crown), ao);
  m.normalNode = pick(normalMap(fn, vec2(1, -1)), derivativeNormal(barkHeight, 1.0));
  if (!leaf) {
    // the trunk's rim against the sky: fibres catch the sky and moonlight at grazing angles (a sheen term the standard BRDF
    // lacks for fibrous bark), so the trunk reads as a round, textured column at night instead of a black cut-out
    const rim = pow(float(1).sub(max(dot(normalWorld, V), 0)), 3);
    const skyCol = mix(vec3(0.35, 0.33, 0.30).mul(environment?.day ?? float(1)), vec3(0.10, 0.12, 0.18), night);
    m.emissiveNode = barkCol.mul(skyCol).mul(rim).mul(0.9);
  }
  if (leaf) {
    const thin = float(1).sub(thick).mul(float(1).sub(rachis));
    let e = through(sunDir, sunCol, thin, lc).mul(0.32);
    if (moonDir) e = e.add(through(moonDir, vec3(0.55, 0.62, 0.8).mul(0.12).mul(night), thin, lc));
    m.emissiveNode = e;
  }
  if (m.isMeshPhysicalNodeMaterial) {
    // r187: sheenNode IS the sheen colour (vec3) and sheenRoughnessNode its roughness; there is no sheenColorNode (until
    // 11 Nov this file set sheenNode = 0.6, which r187 reads as a white sheen, and a sheenColorNode it never read). The
    // waxy bloom on date palm leaflets: a grey-green sheen colour times its strength on the fronds, none on the bark.
    const sh = 0.6;
    m.sheen = sh; m.sheenNode = pick(vec3(0.62, 0.70, 0.62).mul(sh), vec3(0)); m.sheenRoughnessNode = float(0.45);
    m.specularIntensityNode = pick(float(0.7), float(0.3));
  }
  m.positionNode = shape(pick(float(1), float(0)), along, frondRand);
  m.name = `date-palm ${part}`;
  return m;
}
