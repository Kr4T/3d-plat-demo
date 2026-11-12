// lights.mjs: the light rig. Lamp lights per backend, as Boulevard City's lamps.js (lib/runtime/lamp-map.mjs):
// - WebGPU: every light is a real PointLight / SpotLight, culled per screen tile by r187 ClusteredLighting
//   (webgpu_lights_clustered_city: renderer.lighting = new ClusteredLighting(n), finite ranges so each light touches few
//   clusters); maxLights 256 on Phone, 1,024 on High. Physical units as webgpu_lights_physical (candela from lumens).
// - WebGL 2 (or ?nocluster): ClusteredLighting is WebGPU-only, so the lamps' light on the ground is baked into a lamp map
//   (bakeLampMap; the webgpu_lightmap_baking idea) at load and after each set(), and exposed as a uniform texture node
//   (`lampMap.irradiance()`, `lampMap.diffuse(albedo)`) that paving and area materials sample (Boulevard groundMaterial).
// Lamps switch on at dusk and dim with the day as Boulevard's setHour (day < 0.6, intensity times 1 - day), read from the
// stage's environment uniforms (stage.scene.userData.environment).
import { DataTexture, RedFormat, LinearFilter, Color, Vector2, Vector3, Vector4, Group, PointLight, SpotLight, SRGBColorSpace } from 'three/webgpu';
import { texture, positionWorld, uniform, uniformArray } from 'three/tsl';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { lampPlan, bakeLampMap, clusteredLampsRendering, lampMapRendering } from './lamp-map.mjs';

const MAP_RES = 256; // lamp-map cells per side; the cell size follows the scene's extent (at least 1 m)
/** How many lamps a mirror-like surface reflects on the WebGL path (lampMap.lamps: x, y, z, candela), per preset. */
export const MIRROR_LAMPS = Object.freeze({ phone: 8, high: 16 });

/**
 * The lamps the water mirrors: the `n` nearest the water outlines (rings of [x, z], world metres; the scene's water areas),
 * ties by candela, then by position, so the pick does not depend on the scene's order. With no water: by candela, then
 * position. (Review of PR #24: picking by candela, then smallest x, kept only the leftmost of 40 equal lamps.)
 */
export function pickMirrorLamps(lamps, water = [], n = MIRROR_LAMPS.high) {
  const segDist = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz); };
  const inside = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
  const dist = (p) => { let d = Infinity; for (const r of water) { if (inside(r, p[0], p[2])) return 0; for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(p[0], p[2], r[i], r[(i + 1) % r.length])); } return d; };
  return lamps.map((l) => ({ l, d: water.length ? dist(l.position) : 0, cd: candelaOf(l) }))
    .sort((a, b) => a.d - b.d || b.cd - a.cd || a.l.position[0] - b.l.position[0] || a.l.position[2] - b.l.position[2] || a.l.position[1] - b.l.position[1])
    .slice(0, n).map((e) => e.l);
}

/** Black-body colour of a colour temperature (Tanner Helland's fit), as an sRGB Color. */
export function kelvinToColor(kelvin, target = new Color()) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.min(255, Math.max(0, v)) / 255;
  return target.setRGB(c(r), c(g), c(b), SRGBColorSpace);
}

/** Luminous intensity in candela: given, or from lumens (point: lm / 4 pi; spot: lm / pi, three.js's power convention). */
export function candelaOf(l) {
  if (typeof l.candela === 'number') return l.candela;
  const lm = typeof l.lumens === 'number' ? l.lumens : 0;
  return l.type === 'spot' || l.type === 'ies' ? lm / Math.PI : lm / (4 * Math.PI);
}

/** A finite range for clustering: where the light falls to about 0.25 lux, 4 to 40 m. */
export const rangeOf = (cd) => Math.min(40, Math.max(4, Math.sqrt(Math.max(cd, 0) / 0.25)));

export function createLightRig(stage, { allowClustered } = {}) {
  const nocluster = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocluster');
  const plan = lampPlan({ preset: stage.preset, isWebGPU: !!stage.isWebGPU, allowClustered: allowClustered ?? !nocluster });
  const group = new Group(); group.name = 'light rig';
  stage.scene.add(group);
  let current = [], used = [], disposed = false, water = [];
  const pool = { point: [], spot: [] };
  const prevLighting = stage.renderer ? stage.renderer.lighting : undefined;

  if (plan.path === 'clustered' && stage.renderer) stage.renderer.lighting = new ClusteredLighting(plan.maxLights);

  // ---------- the lamp map (WebGL path) ----------
  let lampMap = null;
  if (plan.path === 'lightmap') {
    const tex = new DataTexture(new Uint8Array(MAP_RES * MAP_RES), MAP_RES, MAP_RES, RedFormat);
    tex.magFilter = tex.minFilter = LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true; tex.name = 'lamp map';
    const uOrigin = uniform(new Vector2(0, 0)), uSize = uniform(new Vector2(MAP_RES, MAP_RES));
    const uColour = uniform(new Color(0xffc98a)), uStrength = uniform(0);
    const irradiance = () => texture(tex, positionWorld.xz.sub(uOrigin).div(uSize)).r.mul(uStrength).mul(uColour);
    // the lamps themselves, for surfaces that mirror them (the lake: shared/materials/water-ssr.js lamp glints): on WebGPU each
    // lamp is a real light whose specular the water already shows; here the map only lights the ground, so the water reads
    // the lamps' positions and candela from this array, and `uOn` (0 by day, 1 - day at night) as the lights' own switch
    const lamps = uniformArray(Array.from({ length: MIRROR_LAMPS[stage.preset === 'phone' ? 'phone' : 'high'] }, () => new Vector4()), 'vec4'), uOn = uniform(0);
    lampMap = { texture: tex, uOrigin, uSize, uColour, uStrength, cell: 1, peak: 0, irradiance, diffuse: (albedo) => albedo.mul(irradiance()).mul(1 / Math.PI), lamps, uOn, count: 0 };
    stage.scene.userData.lampMap = lampMap; // what later materials read (Task 8 paving)
  }

  function bake(lights) {
    const lamps = lights.filter((l) => l.type === 'point' || l.type === 'spot' || l.type === 'ies' || l.type === 'rect');
    const data = lampMap.texture.image.data;
    const mirror = pickMirrorLamps(lamps, water, lampMap.lamps.array.length).map((l) => ({ p: l.position, cd: candelaOf(l) }));
    lampMap.lamps.array.forEach((v, i) => (mirror[i] ? v.set(mirror[i].p[0], mirror[i].p[1], mirror[i].p[2], mirror[i].cd) : v.set(0, -1e4, 0, 0)));
    lampMap.count = mirror.length;
    if (!lamps.length) { data.fill(0); lampMap.peak = 0; lampMap.texture.needsUpdate = true; return; }
    const cds = lamps.map(candelaOf), radius = Math.max(...cds.map(rangeOf));
    const xs = lamps.map((l) => l.position[0]), zs = lamps.map((l) => l.position[2]);
    const minX = Math.min(...xs) - radius - 2, minZ = Math.min(...zs) - radius - 2;
    const extent = Math.max(Math.max(...xs) - minX, Math.max(...zs) - minZ) + radius + 2;
    const cell = Math.max(1, Math.ceil(extent / MAP_RES));
    const m = bakeLampMap(lamps.map((l) => [l.position[0] - minX, l.position[2] - minZ]), { GW: MAP_RES * cell, GD: MAP_RES * cell, cell, radius });
    data.set(m.data.subarray(0, data.length));
    lampMap.cell = cell; lampMap.uOrigin.value.set(minX, minZ); lampMap.uSize.value.set(MAP_RES * cell, MAP_RES * cell);
    // the map holds the shape of the pools (1 under a lamp); its strength is the mean irradiance under a lamp, I / h^2
    lampMap.peak = cds.reduce((a, cd, i) => a + cd / Math.max(1, lamps[i].position[1]) ** 2, 0) / lamps.length;
    const col = new Color(0, 0, 0), c = new Color();
    for (const l of lamps) col.add(l.colour ? c.set(l.colour) : kelvinToColor(l.kelvin ?? 3000, c));
    lampMap.uColour.value.copy(col.multiplyScalar(1 / lamps.length));
    lampMap.texture.needsUpdate = true;
  }

  function place(lights) {
    for (const l of [...pool.point, ...pool.spot]) l.visible = false;
    const target = stage.controls?.target || new Vector3();
    const sorted = lights.length > plan.maxLights
      ? [...lights].sort((a, b) => target.distanceToSquared(new Vector3(...a.position)) - target.distanceToSquared(new Vector3(...b.position))).slice(0, plan.maxLights)
      : lights;
    const n = { point: 0, spot: 0 };
    used = [];
    for (const d of sorted) {
      const kind = d.type === 'spot' || d.type === 'ies' ? 'spot' : 'point'; // rect and ies: point and spot until Task 7+
      let l = pool[kind][n[kind]++];
      if (!l) {
        l = kind === 'spot' ? new SpotLight() : new PointLight();
        l.castShadow = false; l.decay = 2;
        group.add(l); if (kind === 'spot') group.add(l.target);
        pool[kind].push(l);
      }
      const cd = candelaOf(d);
      l.name = `${d.uid}.${d.id}`;
      l.position.set(...d.position);
      if (d.colour) l.color.set(d.colour); else kelvinToColor(d.kelvin ?? 3000, l.color);
      // the light's own range when it has one (Boulevard's lamps end at 24 m), else where it falls to about 0.25 lux
      l.userData.base = cd; l.intensity = cd; l.distance = typeof d.range === 'number' && d.range > 0 ? d.range : rangeOf(cd);
      if (kind === 'spot') {
        const dir = d.direction || [0, -1, 0];
        l.angle = Math.min(Math.PI / 2 - 0.01, d.angle ?? Math.PI / 4); l.penumbra = d.penumbra ?? 0.3;
        l.target.position.set(d.position[0] + dir[0] * 10, d.position[1] + dir[1] * 10, d.position[2] + dir[2] * 10);
        l.target.updateMatrixWorld();
      }
      l.visible = true;
      used.push(l);
    }
  }

  const envTerms = () => {
    const u = stage.scene.userData.environment?.uniforms;
    return { day: u?.day?.value ?? 0, night: u?.night?.value ?? 1 }; // no environment: night (tests, benches)
  };

  function update() {
    if (disposed) return;
    const { day } = envTerms(), on = day < 0.6, k = on ? 1 - day : 0;
    if (plan.path === 'clustered') for (const l of used) { l.visible = on; l.intensity = l.userData.base * k; }
    else { lampMap.uStrength.value = lampMap.peak * k; lampMap.uOn.value = k; }
  }
  const offFrame = stage.onFrame ? stage.onFrame(update) : null;

  return {
    path: plan.path,
    maxLights: plan.maxLights ?? 0,
    lampMap,
    group,
    /** Sets the lights the scene carries (world space LightInstance list). */
    /** The scene's water outlines (world [x, z] rings): the lamps nearest them are the ones the water mirrors (WebGL path). */
    setWater(rings = []) {
      const next = JSON.stringify(rings);
      if (next === JSON.stringify(water)) return;
      water = rings.map((r) => r.map((p) => [p[0], p[1]]));
      if (plan.path !== 'clustered' && current.length) bake(current);
    },
    set(lights = []) {
      current = lights.slice();
      if (plan.path === 'clustered') place(current); else bake(current);
      update();
    },
    lights: () => current.slice(),
    update,
    /** True only when lamp light really reaches the frame (Boulevard's feature rule). */
    rendering() {
      if (plan.path === 'clustered') return clusteredLampsRendering({ clustered: !!stage.renderer && stage.renderer.lighting instanceof ClusteredLighting, lights: used });
      return lampMapRendering({ path: plan.path, night: lampMap.uStrength.value > 0 ? envTerms().night : 0 });
    },
    dispose() {
      if (disposed) return; disposed = true;
      offFrame?.();
      for (const l of [...pool.point, ...pool.spot]) l.dispose();
      group.removeFromParent();
      if (lampMap) { lampMap.texture.dispose(); if (stage.scene.userData.lampMap === lampMap) delete stage.scene.userData.lampMap; }
      if (plan.path === 'clustered' && stage.renderer && prevLighting !== undefined) stage.renderer.lighting = prevLighting;
    },
  };
}
