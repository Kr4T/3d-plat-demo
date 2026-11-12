// lamp-map.mjs: copied unchanged from Boulevard City lamps.js (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/lamps.js: lampPlan, clusteredLampsRendering, lampMapRendering, bakeLampMap; PROVENANCE.md).
// r187 examples: webgpu_lights_clustered_city (ClusteredLighting on WebGPU) and webgpu_lightmap_baking (the idea of a
// baked map for light that never moves, on the WebGL 2 fallback). Used by lib/runtime/lights.mjs.
//
// Boulevard's own header follows.
// Street-lamp light at night, per backend (round 0 fix 7).
// - WebGPU (Phone and High): every lamp is a real PointLight, culled per screen tile by r187 ClusteredLighting
//   (webgpu_lights_clustered_city). Phone holds at most 256 (docs/research/prototype-one/world.md §3.3).
// - The WebGL 2 fallback, or ?nocluster: ClusteredLighting is WebGPU-only, so the lamps' light on the ground is baked
//   once into a small light map (the webgpu_lightmap_baking idea: light that never moves is stored, not recomputed),
//   sampled by the ground material at night. It lights the ground only, which is where a lamp's pool is seen.
// The feature report (visualFeatures in main.js) reads clusteredLampsRendering / lampMapRendering, so it says a lamp
// feature is on only when its light really reaches the frame (verifier finding, round 0).

/** Which lamp-light path a preset and backend get. */
export function lampPlan({ preset, isWebGPU, allowClustered }) {
  if (isWebGPU && allowClustered) return { path: 'clustered', maxLights: preset === 'phone' ? 256 : 1024 };
  return { path: 'lightmap' };
}

/** True only when ClusteredLighting is installed and at least one lamp light is visible and lit. */
export function clusteredLampsRendering({ clustered, lights }) {
  return !!clustered && lights.some((l) => l.visible && l.intensity > 0);
}

/** True only on the light-map path once it is dark enough for the map to show. */
export function lampMapRendering({ path, night }) {
  return path === 'lightmap' && night > 0.05;
}

/**
 * Bakes lamp light on the ground: one byte per `cell` metres, the sum of each lamp's windowed falloff
 * (the (1 - (d/r)^4)^2 window three.js uses for punctual lights, times a soft inverse-square), clamped to 1.
 * lamps: [[x, z], ...] in grid metres. Returns { data: Uint8Array(w*h), w, h, cell }.
 */
export function bakeLampMap(lamps, { GW, GD, cell = 2, radius = 16 }) {
  const w = Math.ceil(GW / cell), h = Math.ceil(GD / cell), acc = new Float32Array(w * h), R = Math.ceil(radius / cell);
  for (const [x, z] of lamps) {
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    for (let j = Math.max(0, cj - R); j <= Math.min(h - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(w - 1, ci + R); i++) {
      const d = Math.hypot((i + 0.5) * cell - x, (j + 0.5) * cell - z);
      if (d >= radius) continue;
      const win = (1 - (d / radius) ** 4) ** 2, fall = 1 / (1 + (d / 5) ** 2); // 5 m: about the lamp's height
      acc[j * w + i] += win * fall;
    }
  }
  const data = new Uint8Array(w * h);
  for (let k = 0; k < data.length; k++) data[k] = Math.round(Math.min(1, acc[k]) * 255);
  return { data, w, h, cell };
}
