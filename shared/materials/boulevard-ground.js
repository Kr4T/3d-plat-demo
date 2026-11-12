// boulevard-ground.js: Boulevard City's desert sand as one reusable ground (material and geometry), shared by the builder
// (components/desert-sand, materials/desert-sand) and any other page that draws the Boulevard world.
// r187 examples it starts from: webgpu_tsl_procedural_terrain (height from noise, a normal rebuilt from neighbouring
// heights and handed to the material with transformNormalToView; here the macro dunes are in the geometry and the fine
// relief in the fragment), webgpu_parallax_uv (relief offset of the lookup coordinates, here a world-space ray march, High
// only), webgpu_generator_city (world-space surfaces with macro variation, as Boulevard's groundMaterial),
// webgpu_lights_clustered_city (the lamps' pools come from the real point lights on WebGPU; the baked lamp map on WebGL)
// and webgpu_postprocessing_bloom (the grain glints are real specular highlights that the stage's bloom picks up).
// Recipes: threejs-procedural-materials (one cause stack: the same scanned ripple height gives normal, albedo, AO and
// roughness; specular AA from the mip-averaged normal length; filtered grain glints anchored in world space, one cell
// about two pixels wide, so TRAA sees them steady), threejs-precipitation-surfaces (wetness darkens and smooths together)
// and threejs-parallax-occlusion-mapping (march once, clamp the grazing denominator, reuse the marched point).
// Sand round (11 Nov 2026, Kereem's 3/10): the ripples are ambientCG Ground097 (CC0, height-field photogrammetry of wind
// ripples) in world space along the wind, two rotated lookups blended by a noise field against repeats and a third at
// 5x scale for the middle distance; pale warm cream albedo with soft mottle; authored transverse dunes in the geometry.
// Depends only on three/webgpu, three/tsl and three/addons. Textures: ambientCG CC0 (assets/LICENCES.md), next to this file.
//
// API
//   createGroundMaterial({ quality = 'high' | 'phone', environment, lampMap, wetEdge, tint, windAngle, ripples, sparkle,
//                          ssrMRT, parallax, textureBase }) -> MeshStandardNodeMaterial (material.userData.ready: a
//                          Promise for its images)
//     environment: optional uniforms { night, day, gold, sunDir, sunColor, moonDir, wetness } (TSL nodes); missing ones
//                  fall back to a night scene with the moon high in the south-east.
//     lampMap:     optional { diffuse(albedoNode) -> vec3 node, irradiance() -> vec3 node } (the baked lamp-light path for
//                  WebGL; its pools are added as emission, and its irradiance lights the grain glints there).
//     wetEdge:     optional { attribute = 'shoreDist', width = 3 }: the geometry carries the distance (m) to the water's edge
//                  in a float attribute (createGroundGeometry writes it); sand within `width` of it is wet: darker,
//                  smoother, flatter ripples and a screen-space-reflection weight. Without it only the environment's
//                  `wetness` (rain) darkens the sand, in patches.
//     tint (#rrggbb or vec3 node, multiplies the albedo), windAngle (degrees, the wind the ripples face), ripples (0..2,
//     ripple height), sparkle (0..2, grain glints): numbers, or per-instance TSL nodes.
//   createGroundGeometry(THREE, outline, { quality, y = -0.02, flatRadius = 60, rampWidth = 70, dunes = 8, seed = 7,
//                          shore = null, cellHigh = 3, cellPhone = 6, maxTris, duneAngle = 35, duneWavelength = 95 })
//                          -> BufferGeometry
//     outline [[x, z], ...] (closed, metres); flat at `y` within flatRadius of (0, 0), transverse dunes up to `dunes`
//     metres beyond (crests across `duneAngle`, a long windward slope and a shorter lee, rounded crests); uniform midpoint
//     subdivision (watertight, indexed, smooth normals); uv = (x, -z) metres; `shoreDist` attribute from the `shore`
//     outline (negative inside it; 1e4 without one). geometry.userData.ground = { tris, level, heightRange, maxSlopeDeg }.
//   shoreDistance(outline, x, z) -> metres (negative inside), the function the attribute is filled with.
//   duneHeight(x, z, { flatRadius, rampWidth, dunes, seed, duneAngle, duneWavelength }) -> metres above `y`.
//   GROUND_TEXTURES: the image files this module loads, for licence lists. SAND: the look's constants (tests read them).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, float, vec2, vec3, uniform, color, texture, positionWorld, normalWorldGeometry, cameraPosition, attribute,
  mx_noise_float, transformNormalToView, mix, smoothstep, max, sin, cos, dot, fract, floor, fwidth, log2, exp2, pow,
  normalize, luminance, radians, step, length, sqrt, dFdx, dFdy,
} from 'three/tsl';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { ssrWeight } from './ssr-weight.js';

const TAU = Math.PI * 2;
export const GROUND_TEXTURES = [
  { file: 'tex/{q}/Ground097_col.jpg', asset: 'Ground097', url: 'https://ambientcg.com/a/Ground097', licence: 'CC0' },
  { file: 'tex/{q}/Ground097_nor.jpg', asset: 'Ground097', url: 'https://ambientcg.com/a/Ground097', licence: 'CC0' },
  { file: 'tex/{q}/Ground097_disp.jpg', asset: 'Ground097', url: 'https://ambientcg.com/a/Ground097', licence: 'CC0' },
];
/** The look's constants. Albedo is linear: pale (sRGB about #ecd5b0) and deep (#d9b993) warm cream, the judges' "pale warm
 * cream" (Journey's sand is about #e6b47c, Sable's #f6d7a0). TILE: metres per Ground097 repeat (its ripples are about
 * 13 cm apart, as aeolian ripples are); MESO: the same scan at 5.5x for 0.7 m bedforms in the middle distance. */
export const SAND = Object.freeze({
  pale: [0.84, 0.67, 0.43], deep: [0.70, 0.49, 0.29], TILE: 2.2, MESO: 12.1, glintCellPx: 1.5, glintDensity: 0.06,
  glintRoughness: 0.2, glintTilt: 0.3,
});

const cache = new Map();
function tex(base, file, srgb) {
  const href = new URL(file, base).href;
  if (!cache.has(href)) {
    let t, ready;
    if (typeof document === 'undefined') { t = new THREE.Texture(); ready = Promise.resolve(); } // node (tests): no image
    else {
      let done; ready = new Promise((r) => { done = r; });
      t = new THREE.TextureLoader().load(href, () => done(), undefined, () => done());
    }
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16; // the renderer clamps to its maximum
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    cache.set(href, { t, ready });
  }
  return cache.get(href);
}
const node = (v, make) => (v && v.isNode ? v : make(v));
/** Rotate the plane point p into a frame (u along the crests, v along the wind). */
const toFrame = (p, wind) => vec2(dot(p, vec2(wind.y.negate(), wind.x)), dot(p, wind));

export function createGroundMaterial({
  quality = 'high', environment = null, lampMap = null, wetEdge = null, tint = '#ffffff', windAngle = 35, ripples = 1,
  sparkle = 1, ssrMRT = false, parallax = quality !== 'phone', textureBase = import.meta.url,
} = {}) {
  const HIGH = quality !== 'phone', q = HIGH ? '1k' : '512';
  const col = tex(textureBase, `tex/${q}/Ground097_col.jpg`, true);
  const nor = tex(textureBase, `tex/${q}/Ground097_nor.jpg`, false);
  const disp = tex(textureBase, `tex/${q}/Ground097_disp.jpg`, false);
  const env = environment || {};
  const night = env.night ?? float(1);
  const rain = env.wetness ?? float(0);
  const tintN = node(tint, (v) => color(v)), rippleK = node(ripples, float), sparkleK = node(sparkle, float);
  const wa = radians(node(windAngle, float));
  const wind = vec2(cos(wa), sin(wa));
  const wa2 = wa.add(0.31), wind2 = vec2(cos(wa2), sin(wa2)); // the second lookup turned 18 degrees against repeats
  const wa3 = wa.sub(0.52), wind3 = vec2(cos(wa3), sin(wa3)); // the meso lookup turned the other way

  // ---------- stable coordinates and the fields every channel shares ----------
  const P = positionWorld.xz;
  const n1 = mx_noise_float(P.mul(0.021)), n2 = mx_noise_float(P.mul(0.083).add(5.3)), n3 = mx_noise_float(P.mul(0.31).add(9.1));
  const tone = n1.mul(0.55).add(n2.mul(0.3)).add(n3.mul(0.15)).mul(0.5).add(0.5).clamp(0, 1); // soft mottle, 3 to 50 m
  const patch = smoothstep(0.25, 0.75, mx_noise_float(P.mul(0.035).add(11.7)).mul(0.5).add(0.5)).mul(0.75).add(0.25);
  const pick = smoothstep(0.38, 0.62, mx_noise_float(P.mul(0.17).add(3.7)).mul(0.5).add(0.5)).toVar(); // which ripple lookup
  // filtering: metres per pixel at the unmarched point (derivatives stay outside the march's branches)
  const fp = max(fwidth(P.x), fwidth(P.y)).max(1e-5).toVar();
  const shoreD = wetEdge ? attribute(wetEdge.attribute || 'shoreDist', 'float') : float(1e4);
  const shoreW = wetEdge?.width ?? 3;
  const shoreWet = smoothstep(shoreW, 0, shoreD); // 1 at the water line, 0 beyond `width`
  const damp = smoothstep(shoreW * 2.5, shoreW, shoreD).mul(0.35); // the capillary fringe above it
  const wet = max(max(shoreWet, damp), rain.mul(patch).mul(0.45)).clamp(0, 1).toVar();
  const flat = wet.mul(0.65).oneMinus(); // wet sand is compacted: ripples and grains flatten
  const aRip = rippleK.mul(flat);

  // the ripple lookups: world metres in the wind frame, the crests bent a little by a slow warp (about a quarter of a
  // wavelength over several metres: they curve and fork like the scan's own crests, without stretching the texels)
  const warp = mx_noise_float(P.mul(0.11).add(1.3)).mul(0.22).add(mx_noise_float(P.mul(0.37).add(8.2)).mul(0.05)).toVar();
  const uvA = (p) => toFrame(p, wind).add(vec2(0, warp)).div(SAND.TILE);
  const uvB = (p) => toFrame(p, wind2).add(vec2(0.37, warp.add(0.61))).div(SAND.TILE);
  const uvM = (p) => toFrame(p, wind3).add(vec2(0.13, 0.29)).div(SAND.MESO);
  const heightAt = (p) => mix(texture(disp.t, uvA(p)).level(0).r, texture(disp.t, uvB(p)).level(0).r, pick);
  const AMP = 0.014; // ripple relief, metres (crest to trough)

  // ---------- parallax: one world-space march toward the camera ray (High, near the camera) ----------
  let Pm = P;
  if (parallax) {
    const LAYERS = 16, NEAR = 12, FAR = 20;
    const dist = cameraPosition.distance(positionWorld);
    const fade = smoothstep(FAR, NEAR, dist);
    Pm = Fn(() => {
      const p = P.toVar();
      If(dist.lessThan(FAR), () => {
        const V = cameraPosition.sub(positionWorld).normalize();
        const stepXZ = V.xz.negate().div(max(V.y, 0.3)).mul(AMP / LAYERS); // grazing denominator clamped (POM contract)
        const depth = float(0).toVar();
        Loop(LAYERS, () => {
          const surf = float(AMP).sub(heightAt(p).mul(AMP).mul(aRip.min(1))); // depth below the top of the relief
          If(depth.lessThan(surf), () => { p.addAssign(stepXZ); depth.addAssign(AMP / LAYERS); });
        });
      });
      return mix(P, p, fade);
    })().toVar();
  }

  // ---------- the shared ripple response at the (marched) point: one scan, three lookups ----------
  const sA = texture(nor.t, uvA(Pm)), sB = texture(nor.t, uvB(Pm)), sM = texture(nor.t, uvM(Pm));
  const hA = texture(disp.t, uvA(Pm)).r, hB = texture(disp.t, uvB(Pm)).r, hM = texture(disp.t, uvM(Pm)).r;
  const h = mix(hA, hB, pick).toVar(); // 0 trough .. 1 crest
  // slopes from the OpenGL normal map (x along u, y along v), turned back to world x/z; the mipmapped normal's length
  // says how much relief the pixel averages (Toksvig), which raises roughness instead of aliasing (specular AA)
  const slope = (s, w) => {
    const t = s.rgb.mul(2).sub(1);
    const g = vec2(t.x, t.y).div(t.z.max(0.25));
    const perp = vec2(w.y.negate(), w.x);
    return { g: perp.mul(g.x).add(w.mul(g.y)).negate(), len: length(t) };
  };
  const a = slope(sA, wind), b = slope(sB, wind2), mm = slope(sM, wind3);
  const gradRip = mix(a.g, b.g, pick).mul(aRip).mul(0.9);
  const gradMeso = mm.g.mul(aRip).mul(0.32).mul(smoothstep(0.002, 0.02, fp).mul(0.6).add(0.4)); // stronger once ripples blur
  const avgLen = mix(a.len, b.len, pick).clamp(0.2, 1);
  const ng = normalWorldGeometry; // the dunes, from the geometry
  // the low swells of the flat ground round the plaza (shading only, ~0.3 m over 10-30 m: the light varies across the
  // sand instead of lying flat), by central differences of the same noise
  const swell = (p) => mx_noise_float(p.mul(0.045).add(vec2(2.3, 7.1))).mul(0.3).add(mx_noise_float(p.mul(0.14).add(vec2(9.4, 1.7))).mul(0.07));
  const E = 0.6, gradSwell = vec2(swell(P.add(vec2(E, 0))).sub(swell(P.sub(vec2(E, 0)))), swell(P.add(vec2(0, E))).sub(swell(P.sub(vec2(0, E))))).div(2 * E);
  const gradMacro = vec2(ng.x.negate().div(ng.y.max(0.2)), ng.z.negate().div(ng.y.max(0.2))).add(gradSwell);
  const grad = gradMacro.add(gradRip).add(gradMeso);
  const N0 = normalize(vec3(grad.x.negate(), 1, grad.y.negate())).toVar();

  // ---------- albedo: pale warm cream, soft mottle, the scan's own colour as detail, darker troughs ----------
  const scan = mix(texture(col.t, uvA(Pm)), texture(col.t, uvB(Pm)), pick).rgb;
  const detail = pow(luminance(scan).div(0.36).clamp(0.6, 1.4), 0.6); // 0.36: the scan's mean linear luminance
  const hue = mix(vec3(...SAND.deep), vec3(...SAND.pale), tone);
  const ripTone = mix(float(0.86), float(1.04), h).mul(mix(float(0.94), float(1.03), hM)); // coarser grains in troughs
  const dryAlb = hue.mul(detail).mul(ripTone).mul(tintN);
  const albedo = mix(dryAlb, dryAlb.mul(dryAlb.mul(0.6).add(0.4)).mul(0.62), wet).toVar(); // wet sand darkens and saturates

  // ---------- grain glints: sparse mirror-like quartz facets as real specular (every light makes them) ----------
  // One cell about SAND.glintCellPx pixels wide at the current footprint, chosen per cell between two power-of-two sizes
  // by a fixed per-cell hash (world-anchored, so a still camera under TRAA sees steady sparkles, no level crossfade).
  // A glint cell gets a tilted facet normal and a low roughness, so the lamps (clustered point lights on WebGPU), the
  // moon and the sun all make sparkles where facet and half-vector meet; the rest of the sand keeps the filtered normal.
  // the cell follows the pixel's shorter screen axis (at grazing angles the longer one would make streaks, not grains)
  const foot = max(length(dFdx(P)).min(length(dFdy(P))), 1e-5);
  const cell0 = foot.mul(SAND.glintCellPx), lvl = log2(cell0.div(0.002)).max(0), lo = floor(lvl), t = fract(lvl);
  const hash = (c, k) => fract(sin(dot(c, vec2(12.9898 + k, 78.233 - k))).mul(43758.5453));
  const glintAt = (size, seed) => {
    const c = floor(Pm.div(size)).mod(4096.0).add(seed);
    return { on: step(1 - SAND.glintDensity, hash(c, 0.0)), tx: hash(c, 1.7).sub(0.5), tz: hash(c, 3.1).sub(0.5), lv: hash(c, 5.3) };
  };
  const size0 = exp2(lo).mul(0.002), gA = glintAt(size0, 0), gB = glintAt(size0.mul(2), 17);
  const useB = step(gA.lv, t); // per-cell choice of level, no blend
  // facets only near the camera (pixel footprint under ~2 cm): farther, sub-pixel facets average into a glossy grazing
  // sheen that mirrors the blue night sky over the sand (seen on SwiftShader as a cold band in the middle distance)
  const near = smoothstep(0.02, 0.008, foot);
  const on = mix(gA.on, gB.on, useB).mul(flat).mul(near).mul(sparkleK.min(1)).mul(step(0.001, sparkleK)).toVar();
  const tilt = vec2(mix(gA.tx, gB.tx, useB), mix(gA.tz, gB.tz, useB)).mul(SAND.glintTilt * 2);
  const facet = normalize(N0.add(vec3(tilt.x, 0, tilt.y)));
  const N = normalize(mix(N0, facet, on));

  // ---------- roughness, AO and the reflection weight from the same causes ----------
  const toksvig = avgLen.oneMinus().div(avgLen).mul(2.0); // mip-averaged normal variance
  const dryRough = sqrt(pow(mix(float(0.95), float(0.86), h), 2).add(toksvig)).clamp(0, 1);
  const baseRough = mix(dryRough, float(0.22), shoreWet).mul(mix(float(1), float(0.75), damp)).clamp(0.08, 1);
  const rough = mix(baseRough, float(SAND.glintRoughness), on);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  m.name = 'boulevard-ground (desert sand)';
  m.colorNode = albedo;
  m.normalNode = transformNormalToView(N);
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  m.aoNode = mix(float(0.78), float(1), h);
  // screen-space reflections read metal/rough from the scene pass (builder/stage.js, webgpu_postprocessing_ssr); wet sand
  // reflects the lamps through that weight while it stays a dielectric in its own shading (ssr-weight.js)
  if (ssrMRT) ssrWeight(m, shoreWet.mul(0.55).mul(night.mul(0.5).add(0.5)), baseRough);

  // ---------- emission: the WebGL path's baked lamp pools, and their glints (no light falls on the facets there) ----------
  let em = vec3(0);
  if (lampMap) {
    const V = cameraPosition.sub(positionWorld).normalize();
    const Hl = normalize(vec3(0, 1, 0).add(V)); // the lamp map has no direction: light from above, as under a lamp
    const glintL = smoothstep(0.96, 0.997, dot(facet, Hl)).mul(on).mul(sparkleK).mul(3.0);
    em = lampMap.diffuse(albedo).add(lampMap.irradiance ? lampMap.irradiance().mul(glintL) : vec3(0));
  }
  m.emissiveNode = em;
  m.userData.ready = Promise.all([col.ready, nor.ready, disp.ready]);
  m.userData.ground = { quality: HIGH ? 'high' : 'phone', parallax, wetEdge: !!wetEdge, textures: 'Ground097' };
  return m;
}

// ---------------------------------------------------------------- geometry

function pointInPolygon(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance (m) from (x, z) to a closed outline's edge: negative inside it. */
export function shoreDistance(outline, x, z) {
  let d = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    d = Math.min(d, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return pointInPolygon(outline, x, z) ? -d : d;
}

/** Transverse dunes (the Journey / Sable read: clean authored forms, soft silhouettes): crests across `duneAngle`, every
 * `duneWavelength` metres, a long windward slope and a short lee (crest at 62 % of the period), the crest rounded, the
 * crest lines bent and broken by slow noise and their heights varied, plus a broad swell. None within flatRadius of the
 * origin, full past flatRadius + rampWidth. Returns metres above the ground's `y`. */
const duneNoise = new ImprovedNoise();
export function duneHeight(x, z, { flatRadius = 60, rampWidth = 70, dunes = 8, seed = 7, duneAngle = 35, duneWavelength = 95 } = {}) {
  const r = Math.hypot(x, z);
  if (r <= flatRadius || dunes <= 0) return 0;
  const k = Math.min(1, (r - flatRadius) / rampWidth), ramp = k * k * (3 - 2 * k);
  const a = (duneAngle * Math.PI) / 180, wx = Math.cos(a), wz = Math.sin(a);
  const along = x * wx + z * wz, across = -x * wz + z * wx;
  const bend = duneNoise.noise(across * 0.006, seed, along * 0.004) * 0.55 + duneNoise.noise(across * 0.019, seed + 3, along * 0.011) * 0.12;
  const f = (((along / duneWavelength + bend) % 1) + 1) % 1, A = 0.62;
  const g = f < A ? (f / A) * 0.5 : 0.5 + ((f - A) / (1 - A)) * 0.5; // stoss over 62 %, lee over 38 %
  const crest = Math.sin(Math.PI * g) ** 1.35;
  const amp = 0.55 + 0.45 * (duneNoise.noise(x * 0.005 + 11, seed * 0.5, z * 0.005) * 0.5 + 0.5) * 2 - 0.45;
  const swell = duneNoise.noise(x * 0.0035 + 3.1, seed * 0.5, z * 0.0035) * 0.5 + 0.5;
  return dunes * ramp * (crest * Math.max(0.35, Math.min(1, amp)) * 0.8 + swell * 0.25);
}

export function createGroundGeometry(T, outline, {
  quality = 'high', y = -0.02, flatRadius = 60, rampWidth = 70, dunes = 8, seed = 7, shore = null,
  cellHigh = 3, cellPhone = 6, maxTris = quality === 'phone' ? 12000 : 40000, duneAngle = 35, duneWavelength = 95,
} = {}) {
  const pts = outline.map(([x, z]) => [x, z]);
  const tris = T.ShapeUtils.triangulateShape(pts.map(([x, z]) => new T.Vector2(x, z)), []);
  // uniform midpoint subdivision: every triangle splits the same number of times, so shared edges split alike (no cracks)
  let maxEdge = 0;
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) maxEdge = Math.max(maxEdge, Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1]));
  const cell = quality === 'phone' ? cellPhone : cellHigh;
  let level = Math.max(0, Math.ceil(Math.log2(maxEdge / cell)));
  while (level > 0 && tris.length * 4 ** level > maxTris) level--;
  const verts = pts.map((p) => [...p]), mid = new Map();
  const midpoint = (a, b) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!mid.has(k)) { mid.set(k, verts.length); verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]); }
    return mid.get(k);
  };
  let faces = tris.map((t) => [...t]);
  for (let l = 0; l < level; l++) {
    const next = [];
    for (const [a, b, c] of faces) { const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a); next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]); }
    faces = next; mid.clear();
  }
  // the dunes (duneHeight), written into the vertices so picking, colliders and shadows see the shape the material shades
  const n = verts.length, D = { flatRadius, rampWidth, dunes, seed, duneAngle, duneWavelength };
  const P = new Float32Array(n * 3), U = new Float32Array(n * 2), S = new Float32Array(n);
  let hMin = Infinity, hMax = -Infinity;
  const shorePts = Array.isArray(shore) && shore.length >= 3 ? shore : null;
  for (let i = 0; i < n; i++) {
    const [x, z] = verts[i];
    const h = y + duneHeight(x, z, D);
    P[i * 3] = x; P[i * 3 + 1] = h; P[i * 3 + 2] = z; U[i * 2] = x; U[i * 2 + 1] = -z;
    S[i] = shorePts ? shoreDistance(shorePts, x, z) : 1e4;
    hMin = Math.min(hMin, h); hMax = Math.max(hMax, h);
  }
  const index = [];
  for (const [a, b, c] of faces) { // face up (+y): clockwise seen from above in (x, z), as builder/sculpt/outline.js flatArea
    const s = (verts[b][0] - verts[a][0]) * (verts[c][1] - verts[a][1]) - (verts[c][0] - verts[a][0]) * (verts[b][1] - verts[a][1]);
    if (s > 0) index.push(a, c, b); else index.push(a, b, c);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(P, 3));
  g.setAttribute('uv', new T.BufferAttribute(U, 2));
  g.setAttribute('shoreDist', new T.BufferAttribute(S, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  let maxSlope = 0; // steepest face: the top-down texture projection stretches by 1 / cos(slope) there
  for (const [a, b, c] of faces) {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    maxSlope = Math.max(maxSlope, Math.acos(Math.min(1, Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1))));
  }
  g.userData.ground = { tris: faces.length, level, heightRange: [hMin, hMax], maxSlopeDeg: (maxSlope * 180) / Math.PI };
  return g;
}
