// Volumetric clouds for the sky (Kereem, 12 Nov 2026, on the live site: "the clouds - are there no better clouds in
// threejs webGPU templates?").
//
// Started from the official three.js r187 example webgpu_volume_cloud
// (https://github.com/mrdoob/three.js/blob/r187/examples/webgpu_volume_cloud.html, MIT; PROVENANCE.md). Kept from it:
//  - the noise volume: ImprovedNoise (three/addons/math/ImprovedNoise.js) written into a Data3DTexture, RedFormat, linear
//    filter, unpackAlignment 1, sampled with texture3D(texture, uvw, 0) (level 0, so it may sit inside the loop);
//  - the density: smoothstep(threshold - range, threshold + range, noise);
//  - the march: front to back, colour and alpha accumulated under (1 - alpha), Break once alpha reaches 0.95;
//  - the shading of the Lite quality: the example's one-tap density difference along a direction (here toward the light).
// Changed for a sky (the survey of the r187 cloud examples is in builder/REFERENCES.md):
//  - the example marches a unit box round one cloud (RaymarchingBox reads the box mesh's varyings). The sky has no mesh:
//    these nodes are composed into scene.backgroundNode by builder/environment.js, as the old clouds were (no draw, no
//    triangle added), and the ray is bounded by a cloud shell over the ground (base and top altitude on the planet's
//    sphere), so only the occupied segment is marched (threejs-volumetric-clouds: "raymarch only the bounded segment");
//  - the example multiplies the noise by a sphere falloff to make one cloud. Here the same texture is read at three
//    scales: a weather field (where the banks and gaps are), the base shape, and a detail field that erodes the shape
//    (never adds to it), under a vertical profile (flat bases, round tops), with the cover from Environment.clouds;
//  - the High quality lights each sample with a short march toward the light (Beer's law, a two-lobe phase for the
//    silver lining) in place of the one-tap difference;
//  - light and colour follow the time of day: the light's direction and colour and the sky's ambient colour are
//    uniforms set by builder/environment.js hourParams (sun by day, the last sun from below at dusk, the moon by night),
//    and the far clouds dissolve into the sky's own horizon colour (threejs-atmosphere-aerial-perspective: one sun
//    direction and one sky model for the sky and for what is seen through the air).
// The old clouds (builder/vfx/sky.js makeSkyDome, Boulevard's sky dome) stay as the fallback: cloudTier() below picks.
// Effect module (builder/vfx/): sky and light effects may build their own shapes; props may not.
import * as THREE from 'three/webgpu';
import { Fn, If, Break, Loop, float, vec2, vec3, vec4, smoothstep, mix, exp, max, sqrt, fract, texture3D, time, cameraPosition, screenCoordinate } from 'three/tsl';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

/** The two qualities of the volumetric clouds. `steps`: samples along the view ray; `lightSteps`: samples toward the
 * light per lit sample (0: the example's one-tap difference); `detail`: the erosion read; `size`: the noise volume's
 * edge in texels (the example's is 128); `temporal`: the first sample's offset changes each frame, for TRAA to average
 * (High on WebGPU has TRAA; without it the offset must hold still). */
export const CLOUD_QUALITY = Object.freeze({
  high: Object.freeze({ steps: 32, lightSteps: 3, detail: true, size: 96, temporal: true }),
  lite: Object.freeze({ steps: 16, lightSteps: 0, detail: false, size: 64, temporal: false }),
});

/** What the clouds may cost (tests/clouds.test.mjs holds every tier to it; the gate's page budgets are draws and
 * triangles per frame, tools/quality-gate/gate.config.json `budgets`): no draw and no triangle (they live in the
 * background node), a noise volume of at most `textureBytes`, and at most `fetches` texture reads for a sky pixel in the
 * worst case (every sample inside a cloud, no early exit). */
export const CLOUD_BUDGET = Object.freeze({ draws: 0, triangles: 0, textureBytes: 1 << 20, fetches: { high: 260, lite: 64 } });

/** Texture reads for one sky pixel, worst case and for a clear ray (weather and shape only). */
export function cloudCost(quality) {
  const Q = typeof quality === 'string' ? CLOUD_QUALITY[quality] : quality;
  const empty = 2, lit = empty + (Q.detail ? 3 : 0) + (Q.lightSteps > 0 ? Q.lightSteps : 1); // detail: two detail reads and the shape again
  return { fetchesWorst: Q.steps * lit, fetchesClear: Q.steps * empty, textureBytes: Q.size ** 3, draws: 0, triangles: 0 };
}

/** Which clouds a stage shows. The rule (the existing tier and phone path: builder/stage.js `preset` and `isWebGPU`):
 * High on WebGPU gets the volumetric clouds at High quality; Phone (any backend) and ?webgl (any preset) keep the old
 * flat clouds, because their frame time with the new ones has not been measured on real hardware (headless Chromium is
 * SwiftShader: docs/gpu/clouds-shots.json asks the Platform worker for the real numbers). `force` is the page's ?clouds
 * flag: `flat` forces the old ones anywhere; `volumetric` forces the new ones, at Lite quality where the rule would have
 * said flat (for those measurements, not for users). */
export function cloudTier({ preset = 'high', isWebGPU = false, force = null } = {}) {
  const natural = preset === 'high' && isWebGPU;
  if (force === 'flat') return { kind: 'flat', quality: null, reason: 'forced by ?clouds=flat' };
  if (natural) return { kind: 'volumetric', quality: 'high', reason: 'High on WebGPU' };
  if (force === 'volumetric') return { kind: 'volumetric', quality: 'lite', reason: 'forced by ?clouds=volumetric' };
  return { kind: 'flat', quality: null, reason: preset === 'phone' ? 'Phone preset: the old clouds' : 'WebGL 2 (?webgl or no WebGPU): the old clouds' };
}

/** The cloud layer, in km: base and top over the ground, the planet's radius (builder/atmosphere.js RG), and the three
 * scales the noise volume is read at (one mirrored tile of the volume spans this many km). */
export const CLOUD_LAYER = Object.freeze({ baseKm: 1.4, topKm: 3.0, planetKm: 6360, weatherTileKm: 46, shapeTileKm: 7.5, detailTileKm: 1.9, hazeKm: 42, hazeGain: 0.7, windKmS: 0.02,
  // the builder's camera looks level or down (OrbitControls maxPolarAngle), so the clouds are seen low in the sky, 5 to
  // 35 km away: at most `marchKm` of the shell is marched along a ray (the steps stay finer than a cloud), and the layer
  // is gone into the horizon's haze between `fadeFromKm` and `fadeToKm`
  marchKm: 12, fadeFromKm: 20, fadeToKm: 38 });

const noiseCache = new Map();
/** The noise volume's bytes, by the example's method: ImprovedNoise sampled on a size^3 grid into a Uint8Array as
 * 128 + 128 * noise. The example writes one octave times a sphere falloff (one cloud in a box); a sky layer needs a
 * field with no centre, so the falloff is left out and three octaves are summed (weights 0.625, 0.25, 0.125). Cached per
 * size: the bytes are the same for every stage on the page. */
export function cloudNoiseData(size = CLOUD_QUALITY.high.size) {
  if (noiseCache.has(size)) return noiseCache.get(size);
  const data = new Uint8Array(size * size * size), perlin = new ImprovedNoise();
  const f = 4 / size; // 4 lattice cells across the volume at the first octave
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = 0.625 * perlin.noise(x * f, y * f, z * f) + 0.25 * perlin.noise(x * f * 2 + 31.4, y * f * 2 + 7.7, z * f * 2 + 13.1) + 0.125 * perlin.noise(x * f * 4 + 5.2, y * f * 4 + 19.3, z * f * 4 + 47.9);
        data[i++] = Math.min(255, Math.max(0, 128 + 128 * n * 1.6));
      }
    }
  }
  noiseCache.set(size, data);
  return data;
}

/** The noise volume as a texture (the example's settings; mirrored repeat, so the volume tiles without a seam: Perlin
 * noise on a 4-cell grid does not wrap by itself). */
export function makeCloudNoise(size = CLOUD_QUALITY.high.size) {
  const tex = new THREE.Data3DTexture(cloudNoiseData(size), size, size, size);
  tex.format = THREE.RedFormat; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.MirroredRepeatWrapping; tex.generateMipmaps = false;
  tex.name = 'cloud-noise'; tex.needsUpdate = true;
  return tex;
}

// distance along a ray (cosine mu with the zenith) from radius r0 to the shell H km higher, written without the
// cancellation of -r0 mu + sqrt(r0^2 mu^2 + ...) so 32-bit floats hold it
const shellDist = (r0, mu, H) => { const k = H.mul(r0.mul(2).add(H)), b = r0.mul(mu); return k.div(b.add(sqrt(b.mul(b).add(k)))); };
const hg = (c, g) => float(1 - g * g).div(float(1 + g * g).sub(c.mul(2 * g)).pow(1.5)); // Henyey-Greenstein x 4 pi

/**
 * The volumetric clouds as background nodes. ctx: `dir` (the view direction), `uClouds` (cover 0..1), `uLightDir` (unit,
 * toward the light: the true sun, or the moon), `uLightColor` (the light on a cloud), `uAmbient` (the sky's light on a
 * cloud), `horizon(dir)` (the sky's colour at the horizon in a direction), `quality` ('high' | 'lite').
 * Returns { node (vec4: colour, cover), texture, quality, userData, dispose() }.
 */
export function makeVolumeClouds(ctx) {
  const quality = CLOUD_QUALITY[ctx.quality] ? ctx.quality : 'high', Q = CLOUD_QUALITY[quality], L = CLOUD_LAYER;
  const noise = makeCloudNoise(Q.size), { uClouds, uLightDir, uLightColor, uAmbient } = ctx;
  const thick = L.topKm - L.baseKm;
  const tap = (uvw) => texture3D(noise, uvw, 0).r.sub(0.5).mul(1.25).add(0.5); // spread the fbm's narrow histogram round 0.5
  const wind = time.mul(L.windKmS);

  // density 0..1 at p (km: x east, y the altitude over the base, z south), hf = y / thickness. `weather` is passed in
  // by the light taps (it varies over tens of km, so the view sample's value serves)
  const weatherAt = (p) => tap(vec3(p.x.add(wind.mul(0.5)).div(L.weatherTileKm), 0.37, p.z.div(L.weatherTileKm)));
  // detail: a finer read of the same volume. It only ever takes density away (it lowers the noise before the threshold,
  // most where the cloud is thin), so the smooth masses break into billows without growing
  const detailAt = (p) => tap(vec3(p.x.add(wind.mul(1.6)), p.y.add(wind.mul(0.3)), p.z).div(L.detailTileKm)).add(tap(vec3(p.z, p.x.add(wind.mul(2.2)), p.y).div(L.detailTileKm * 0.37)).mul(0.5)).div(1.5);
  const shapeAt = (p, hf, weather, detail = null) => {
    const cover = uClouds.mul(0.6).add(weather.sub(0.5).mul(0.8)).clamp(0, 1); // seen from the side a fifth of the area already fills half the view
    const profile = smoothstep(0.0, 0.14, hf).mul(smoothstep(1.0, weather.mul(0.5).add(0.15), hf)); // flat base, round top; taller where the weather is thick
    const threshold = cover.mul(profile).oneMinus();
    const n = tap(vec3(p.x.add(wind), p.y, p.z.add(wind.mul(0.35))).div(L.shapeTileKm));
    const m = detail ? n.sub(detail.mul(0.3)) : n.sub(0.1); // without the detail read: its mean, so the light taps see the same mass
    return smoothstep(threshold.sub(0.065), threshold.add(0.065), m); // the example's threshold and range
  };

  const node = Fn(() => {
    const out = vec4(0).toVar();
    const d = ctx.dir.normalize(), mu = d.y;
    If(mu.greaterThan(0.004).and(uClouds.greaterThan(0.001)), () => {
      const hc = cameraPosition.y.div(1000).clamp(0, L.baseKm - 0.2), r0 = hc.add(L.planetKm);
      const t0 = shellDist(r0, mu, float(L.baseKm).sub(hc)), t1 = shellDist(r0, mu, float(L.topKm).sub(hc));
      const seg = t1.sub(t0).min(L.marchKm), dt = seg.div(Q.steps);
      const origin = vec3(cameraPosition.x.div(1000), 0, cameraPosition.z.div(1000));
      // interleaved gradient noise on the pixel: the first sample's offset, so the steps do not band. With `temporal` the
      // offset also moves with the TSL clock (not the frame count: a frozen clock, as the gate's bench sets, holds it still)
      const jitter = fract(float(52.9829189).mul(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715)))).add(Q.temporal ? time.mul(37.0) : 0));
      const t = t0.add(dt.mul(jitter)).toVar();
      const cosL = d.dot(uLightDir);
      const phase = mix(float(1), mix(hg(cosL, -0.25), hg(cosL, 0.72), 0.5), 0.55).min(2.0); // back and forward lobes: the silver lining toward the sun
      const acc = vec4(0).toVar();
      Loop(Q.steps, () => {
        const hf = t.sub(t0).div(t1.sub(t0)), flat = origin.add(d.mul(t));
        const p = vec3(flat.x, hf.mul(thick), flat.z);
        const weather = weatherAt(p).toVar();
        const dens = shapeAt(p, hf, weather).toVar(); // the mass without detail: most samples are clear and stop here
        If(dens.greaterThan(0.01), () => {
          if (Q.detail) dens.assign(shapeAt(p, hf, weather, detailAt(p)));
          const lit = float(0).toVar();
          if (Q.lightSteps > 0) { // a short march toward the light: Beer's law, with a soft floor for the light scattered round
            const od = float(0).toVar();
            for (let i = 0; i < Q.lightSteps; i++) {
              const s = 0.14 * 2.2 ** i, pl = p.add(uLightDir.mul(s));
              od.addAssign(shapeAt(pl, pl.y.div(thick), weather).mul(s * (i === 0 ? 1 : 0.55)));
            }
            const beer = exp(od.mul(-12.0));
            lit.assign(max(beer, exp(od.mul(-1.2)).mul(0.28)).mul(phase));
          } else { // the example's shading: the density difference along a direction (toward the light)
            const pl = p.add(uLightDir.mul(0.25));
            lit.assign(dens.sub(shapeAt(pl, pl.y.div(thick), weather)).mul(0.9).add(0.55).clamp(0.08, 1.4));
          }
          const amb = mix(0.5, 1.0, hf); // bases sit in their own shade
          const col = uLightColor.mul(lit).add(uAmbient.mul(amb));
          const a = exp(dens.mul(dt).mul(-14.0)).oneMinus(); // extinction per km of full density
          acc.rgb.addAssign(acc.a.oneMinus().mul(a).mul(col));
          acc.a.addAssign(acc.a.oneMinus().mul(a));
          If(acc.a.greaterThanEqual(0.95), () => { Break(); });
        });
        t.addAssign(dt);
      });
      // aerial perspective: far clouds take the horizon's colour, and the layer fades out at the horizon itself
      const air = exp(t0.div(-L.hazeKm)), rim = smoothstep(L.fadeToKm, L.fadeFromKm, t0);
      const col = mix(ctx.horizon(d).mul(L.hazeGain), acc.rgb.div(max(acc.a, 1e-4)), air);
      out.assign(vec4(col, acc.a.mul(rim)));
    });
    return out;
  })();

  let disposed = false;
  return {
    node, texture: noise, quality,
    userData: { vfx: { module: 'sky-clouds-volumetric', example: 'webgpu_volume_cloud' } },
    dispose() { if (disposed) return; disposed = true; noise.dispose(); },
  };
}
