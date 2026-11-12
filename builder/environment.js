// environment.js: the builder's environment rig: the sky, the key light (sun by day, moon by night), the sky fill, the
// haze (aerial perspective plus height fog), clouds, stars and the environment light, all set by one Environment object
// (doc.environment). Any scene gets the same rig; nothing here knows the plaza.
//
// History: copied and adapted from Kr4T/3DPLAT round2/boulevard 3352816 apps/boulevard-city-3d/main.js (the sky and light
// block: SkyMesh + CubeCamera, sunAt, setHour, updateEnv; PROVENANCE.md). Environment rig (11 Nov 2026): the Preetham
// SkyMesh is replaced by the physically based atmosphere of builder/atmosphere.js (Rayleigh, Mie, ozone, multiple
// scattering; Hillaire 2020 LUTs, the threejs-atmosphere-aerial-perspective skill), whose one sky meter drives the
// exposure, the stars and the night floor; the date, latitude and longitude moved into the document (no viewer clock).
// r187 examples it is built from (builder/REFERENCES.md): webgpu_sky (the sky as the background, sun position from the
// light), webgpu_lights_sunlight (the daylight-driven sun colour and the fog colour that follows it), webgpu_custom_fog_
// background (the fog colour taken from the background, so the haze meets the horizon), webgpu_fog_height
// (exponentialHeightFogFactor with renderGroup uniforms), webgpu_generator_city (updateSun: PMREM of the sky without its
// sun disc, one reused render target), webgpu_shadowmap_csm (CSM on High) and webgpu_lights_clustered_city (the background
// and fog slots). Clouds (12 Nov 2026): webgpu_volume_cloud, as builder/vfx/clouds.js (volumetric, on High with WebGPU);
// the old flat clouds of builder/vfx/sky.js stay as the fallback (cloudTier).
// Environment = { hour 0..24, date 'YYYY-MM-DD', latitude, longitude (degrees), moon, clouds, fog, haze 0..1, keyLight
// 0..2, wetness 0..1, waterLevel } (scenes/scene.schema.json; ENV_RANGES below).
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec2, vec3, float, mix, min, max, smoothstep, clamp, sqrt, acos, exp, texture, fog as fogNode, exponentialHeightFogFactor,
  renderGroup, positionWorldDirection, positionWorld, cameraPosition,
} from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { makeSkyDome, makeSkyBox } from './vfx/sky.js';
import { makeVolumeClouds, cloudTier } from './vfx/clouds.js';
import { makeMoon as makeMoonSprite } from './vfx/moon.js';
import { skyState, atmosphere, sunAtEye, groundExtinction, luminance, SKY_W, SKY_H, NIGHT_FLOOR, DEFAULT_HAZE, SUN_SCENE } from './atmosphere.js';

export const DEFAULT_ENVIRONMENT = Object.freeze({
  hour: 17, date: '2026-11-11', latitude: 24.77, longitude: 46.6, // a fixed reference day and Riyadh: a saved hour reproduces exactly
  moon: true, clouds: 0.5, fog: 0.5, haze: DEFAULT_HAZE, keyLight: 1, wetness: 0, waterLevel: 0,
});
/** The numeric ranges of the environment keys (the schema, the browser check and the patch rules use the same). */
export const ENV_RANGES = Object.freeze({ hour: [0, 24], clouds: [0, 1], fog: [0, 1], wetness: [0, 1], haze: [0, 1], keyLight: [0, 2], latitude: [-89, 89], longitude: [-180, 180] });
export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'YYYY-MM-DD' -> true when it names a real calendar day. */
export function isISODate(s) {
  const m = typeof s === 'string' && ISO_DATE.exec(s); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
/** 'YYYY-MM-DD' -> day of the year (1..366). */
export function dayOfYearISO(s) {
  const m = ISO_DATE.exec(isISODate(s) ? s : DEFAULT_ENVIRONMENT.date);
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(+m[1], 0, 0)) / 864e5);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const inRange = (k, v, fallback) => Math.min(ENV_RANGES[k][1], Math.max(ENV_RANGES[k][0], num(v, fallback)));

// One Environment from a partial one, on top of `base`. Reads the uew-scene@1 names too: `time` for the hour, and
// `moon` as an object (shown unless it says visible: false).
export function normalizeEnvironment(env = {}, base = DEFAULT_ENVIRONMENT) {
  const moon = typeof env.moon === 'boolean' ? env.moon : env.moon && typeof env.moon === 'object' ? env.moon.visible !== false : base.moon;
  return {
    hour: inRange('hour', env.hour ?? env.time, base.hour),
    date: isISODate(env.date) ? env.date : base.date,
    latitude: inRange('latitude', env.latitude, base.latitude),
    longitude: inRange('longitude', env.longitude, base.longitude),
    moon,
    clouds: clamp01(num(env.clouds, base.clouds)),
    fog: clamp01(num(env.fog, base.fog)),
    haze: clamp01(num(env.haze, base.haze)),
    keyLight: inRange('keyLight', env.keyLight, base.keyLight),
    wetness: clamp01(num(env.wetness, base.wetness)),
    waterLevel: num(env.waterLevel, base.waterLevel),
  };
}

// The sun by day of the year and local hour at a latitude and longitude (degrees; the clock is the longitude's nominal
// zone, round(longitude / 15) hours from UTC: UTC+3 for Riyadh): elevation and azimuth in radians (Boulevard sunAt, with
// the place as parameters).
export function sunAt(day, hour, lat = DEFAULT_ENVIRONMENT.latitude, lon = DEFAULT_ENVIRONMENT.longitude) {
  const RAD = Math.PI / 180, LAT = lat * RAD, ZONE = Math.round(lon / 15), g = (2 * Math.PI / 365) * (day - 1 + (hour - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const Hh = ((hour - ZONE + lon / 15 + eot / 60) - 12) * 15 * RAD;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(Hh));
  const az = Math.atan2(Math.sin(Hh), Math.cos(Hh) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}
/** The sun for an Environment at an hour (default its own): elevation, azimuth, degrees, and whether it is rising. */
export function sunFor(env, hour = env.hour) {
  const day = dayOfYearISO(env.date), s = sunAt(day, hour, env.latitude, env.longitude);
  return { ...s, elD: (s.el * 180) / Math.PI, rising: sunAt(day, hour + 1 / 60, env.latitude, env.longitude).el > s.el };
}
/** Sunrise and sunset (local hours, the disc's top on the horizon: -0.833 degrees), or null for each when the sun does
 * not cross the horizon that day (polar day or night; `up` then says which). */
export function sunTimes(env) {
  const day = dayOfYearISO(env.date), H = -0.833 * Math.PI / 180, f = (h) => sunAt(day, h, env.latitude, env.longitude).el - H;
  let rise = null, set = null;
  for (let h = 0; h < 24; h += 1 / 12) {
    const a = f(h), b = f(h + 1 / 12);
    if ((a < 0) === (b < 0)) continue;
    let lo = h, hi = h + 1 / 12;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if ((f(m) < 0) === (a < 0)) lo = m; else hi = m; }
    if (a < 0 && rise === null) rise = (lo + hi) / 2; else if (a >= 0 && set === null) set = (lo + hi) / 2;
  }
  return { rise, set, up: f(12) > 0 };
}

const smooth01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
// Boulevard setHour's day, gold and night terms (day 1 at full sun, 0 below -9 degrees; gold peaks at 3 degrees): the
// lamps, the searchlights, the clouds' tint and the sky fill's strength follow them. lat / lon default to Riyadh.
export function daylight(day, hour, lat, lon) {
  const { el, az } = sunAt(day, hour, lat, lon), elD = (el * 180) / Math.PI;
  const d = smooth01((elD + 9) / 12), gold = Math.max(0, 1 - Math.abs(elD - 3) / 10) * d;
  return { el, az, elD, day: d, gold, night: 1 - d, moonUp: d < 0.6, rising: sunAt(day, hour + 1 / 60, lat, lon).el > el };
}

// Lamps and searchlights by the day term: lamps on below LAMPS_DAY (lib/runtime/lights.mjs, Boulevard setHour: day < 0.6,
// intensity times 1 - day), searchlight beams shown below DAYLIGHT (builder/vfx/searchlights.js, Boulevard main.js 1200).
export const LAMPS_DAY = 0.6;
/** The key light: the sun's strength at noon (Boulevard's 3.4), its lowest direction (6 degrees: shadows
 * ~10x the caster's height, while level ground still takes a tenth of the key; at 4 degrees the flat sand went dark, the
 * old rig held 7-8; a lower sun still lights through its colour and strength), its strength compression, the twilight
 * fade (review of PR #21, M1: the key used to fall off a cliff at sunset and leave a hole before the moon): after the
 * disc sets the key keeps the colour of the last sun and fades out between -1 and -4 degrees while the moonlight fades in
 * over the same span, and the moon (vfx/moon.js) as a shadowless light. */
export const KEY = Object.freeze({ sun: SUN_SCENE, minElevationDeg: 6, compress: 0.12, fadeFromDeg: -1, fadeToDeg: -4, moon: 0.2, moonColor: 0x9fb4ff, moonAzDeg: 115, moonElDeg: 38 });
/** The sky fill and the environment light together are the sky's own irradiance on a level surface (pi x the sky
 * meter), scaled by FILL.gain so that noon keeps the approved fill (~0.53 of light on level ground in the scene-quality
 * pass). The PMREM environment keeps its approved intensity FILL.env (its irradiance is pi x the meter too, so it is
 * FILL.env of it), and the HemisphereLight carries the rest. */
export const FILL = Object.freeze({ gain: 0.4, env: 0.12 });
/** Aerial perspective is exaggerated this many times over the real air (the atmosphere's ground extinction), so the
 * haze reads at builder distances (hundreds of metres, not tens of km), as games do. */
export const HAZE_SCENE_SCALE = 10;
/** The light on the volumetric clouds (builder/vfx/clouds.js). The sun reaches a cloud after the ground has lost it: it
 * lights them (from below, once it is under the horizon) until it is `sunToDeg` down, at full strength from
 * `sunFromDeg`; its strength is the transmitted sun's, compressed by the power `compress` (between the physical fall and the
 * key light's KEY.compress: a cloud 2 km up sees a brighter low sun than the ground does), times `sun`. `moon`: the moonlight's share after that. `ambient`:
 * the sky's own light on a cloud (its mean colour, night floor included, `grey` of the way to its own grey: light that
 * has passed through cloud loses the sky's blue) plus a share of the horizon's glow. */
export const CLOUD_LIGHT = Object.freeze({ sun: 1.6, compress: 0.35, sunFromDeg: -1, sunToDeg: -6, moon: 0.35, ambient: 1.0, grey: 0.5, horizon: 0.06 });
const D2R = Math.PI / 180;
const dirFrom = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); // x east, z south
export const MOON_DIR = dirFrom(KEY.moonAzDeg * D2R, KEY.moonElDeg * D2R);
const noonSun = new Map();
const sunNoonLum = (haze) => { if (!noonSun.has(haze)) noonSun.set(haze, luminance(sunAtEye(atmosphere(haze), 60 * D2R))); return noonSun.get(haze); };
const normMax = (c) => { const m = Math.max(c[0], c[1], c[2], 1e-9); return new THREE.Color(c[0] / m, c[1] / m, c[2] / m); };

/** Every number the stage sets for an Environment (the slider's mapping, unit-tested in tests/time-of-day.test.mjs and
 * tests/env-rig.test.mjs): the sun and the sky model's state (LUT, meter, exposure, stars), the key light (direction,
 * colour, strength, sun or moon), the sky fill, the haze and height fog, the environment intensity, the moon, the lamps,
 * the searchlights and the bloom. `env` is a normalized Environment. */
export function hourParams(env = DEFAULT_ENVIRONMENT, preset = 'high') {
  const e = normalizeEnvironment(env), day = dayOfYearISO(e.date);
  const L = daylight(day, e.hour, e.latitude, e.longitude), { el, az, elD } = L, dayT = L.day, gold = L.gold, night = L.night;
  const sky = skyState(e.haze, elD);
  // the sun as a light: its colour and strength through the air (the sky model's transmittance, taken at 0.5 degrees or
  // higher so the colour of the last sun carries through the twilight fade), its strength compressed (partial adaptation:
  // the 1-degree sun is ~1/30 of noon's, shown as ~2/3: the strong low key light the look pass asked for), its direction
  // held above KEY.minElevation
  const T = sunAtEye(sky.A, Math.max(el, 0.5 * D2R));
  const fade = smooth01((elD - KEY.fadeToDeg) / (KEY.fadeFromDeg - KEY.fadeToDeg)); // 1 above -1 degrees, 0 below -4
  const sunStrength = KEY.sun * Math.pow(luminance(T) / sunNoonLum(sky.A.haze), KEY.compress) * fade;
  const sunColor = normMax(T.map((v) => Math.sqrt(Math.max(0, v))));
  const sunDir = dirFrom(az, Math.max(el, KEY.minElevationDeg * D2R));
  const moonStrength = e.moon ? KEY.moon * (1 - fade) : 0; // the moonlight comes in as the twilight key goes out
  const keyBody = sunStrength >= moonStrength ? 'sun' : 'moon';
  // the fill: the sky's irradiance (pi x the meter), in the sky's mean colour at half its chroma, luminance 1
  const skyLum = Math.max(1e-9, luminance(sky.sky)), fillE = FILL.gain * Math.PI * sky.meter;
  const fog = e.fog;
  // the clouds' light: the sun (true direction, so a set sun lights their bases), else the moon
  const cloudFade = smooth01((elD - CLOUD_LIGHT.sunToDeg) / (CLOUD_LIGHT.sunFromDeg - CLOUD_LIGHT.sunToDeg));
  const cloudSunK = CLOUD_LIGHT.sun * (KEY.sun / Math.PI) * Math.pow(luminance(T) / sunNoonLum(sky.A.haze), CLOUD_LIGHT.compress) * cloudFade;
  const cloudMoonK = e.moon ? (KEY.moon / Math.PI) * CLOUD_LIGHT.moon * (1 - cloudFade) : 0;
  const cloudBySun = cloudSunK >= cloudMoonK;
  // (the sun's colour squared: sunColor is the square root of the transmitted colour, the clouds take the full tint)
  const cloudLightColor = cloudBySun ? sunColor.clone().multiply(sunColor).multiplyScalar(cloudSunK) : new THREE.Color(KEY.moonColor).multiplyScalar(cloudMoonK);
  const cloudAmbient = new THREE.Color(...sky.sky.map((v, i) => CLOUD_LIGHT.ambient * (v + (skyLum - v) * CLOUD_LIGHT.grey) + CLOUD_LIGHT.horizon * sky.horizon[i]));
  return {
    ...L, env: e, sky,
    skySun: [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)], // the sky's own sun (x east, z south)
    sunDir, sunColor, sunIntensity: sunStrength * e.keyLight,
    moonDir: MOON_DIR.clone(), moonColor: new THREE.Color(KEY.moonColor), moonIntensity: moonStrength * e.keyLight,
    keyBody, keyDir: keyBody === 'sun' ? sunDir : MOON_DIR.clone(),
    keyColor: keyBody === 'sun' ? sunColor : new THREE.Color(KEY.moonColor),
    keyIntensity: (keyBody === 'sun' ? sunStrength : moonStrength) * e.keyLight,
    hemiColor: new THREE.Color(1, 1, 1).lerp(new THREE.Color(sky.sky[0] / skyLum, sky.sky[1] / skyLum, sky.sky[2] / skyLum), 0.5),
    hemiIntensity: fillE * (1 - FILL.env / FILL.gain),
    hemiGround: new THREE.Color(0x4a3426).lerp(new THREE.Color(0x9a7a58), dayT).lerp(new THREE.Color(0xc08850), gold * 0.4),
    // the haze's colour is the sky's horizon (per view direction on the page; its mean here)
    fogColor: new THREE.Color(...sky.horizon),
    fogDensity: (preset === 'phone' ? 0.0045 : 0.0035) * (fog / 0.5) * (1 + 0.6 * night), // height fog: extinction per metre at the ground
    fogMax: fog > 0 ? 0.94 - 0.4 * night : 0,
    hazeDensity: (groundExtinction(e.haze) / 1000) * HAZE_SCENE_SCALE, // aerial perspective, per metre
    environmentIntensity: FILL.env, // constant: the PMREM is the sky itself, so its light already follows the meter
    exposure: sky.exposure, stars: sky.stars,
    cloudLightDir: cloudBySun ? dirFrom(az, el) : MOON_DIR.clone(), cloudLightColor, cloudAmbient, cloudLightBody: cloudBySun ? 'sun' : 'moon',
    moonVisible: e.moon && L.moonUp,
    lampsOn: dayT < LAMPS_DAY, lampLevel: dayT < LAMPS_DAY ? 1 - dayT : 0,
    searchlights: dayT < 0.75, // builder/vfx/searchlights.js DAYLIGHT
    bloom: 0.04 + 0.16 * night, // builder/stage.js applyNight
  };
}

/** The PMREM rebake while the hour moves (Boulevard updateEnv): at most one bake per `interval` ms, and always one more
 * after the last request, so a drag ends on a full update. flush() bakes a pending request now (the slider's release). */
export function createBakeThrottle({ interval = 250, run, now = () => performance.now(), later = (f, ms) => setTimeout(f, ms), cancel = (t) => clearTimeout(t) }) {
  let last = -1e9, timer = null;
  const fire = () => { if (timer !== null) cancel(timer); timer = null; last = now(); run(); };
  return {
    request() {
      const wait = interval - (now() - last);
      if (wait <= 0) { fire(); return; }
      if (timer === null) timer = later(() => { timer = null; fire(); }, wait + 5);
    },
    flush() { if (timer !== null) fire(); },
    pending: () => timer !== null,
    dispose() { if (timer !== null) cancel(timer); timer = null; },
  };
}

/** At most one environment apply per frame, the latest value winning (review S-a: the sky LUT is rebuilt on every
 * apply, 4-30 ms, and the slider sends an input event far more often than a frame): request(value) stores, tick() (the
 * frame) runs the latest once, flush() runs a pending one now. */
export function createCoalescer(run) {
  let latest, has = false;
  const go = () => { if (!has) return; has = false; const v = latest; latest = undefined; run(v); };
  return { request(v) { latest = v; has = true; }, tick: go, flush: go, pending: () => has };
}

/** The shadow budget per preset (the single-map path; High on WebGPU uses CSM): map size and the largest half-extent. */
export const SHADOW = Object.freeze({ phone: { mapSize: 2048, maxR: 420 }, high: { mapSize: 4096, maxR: 900 } });

// ---------- the sky node: the sky-view LUT, the night floor and the stars, as builder/atmosphere.js skyPixel ----------
function skyNodes({ lut, uSunXZ, uStars, uSunDisc, uSunTrue, stars }) {
  const nightFloor = (d) => {
    const up = max(d.y, 0), g = up.pow(0.6), w = smoothstep(0, 0.12, up);
    const grad = mix(vec3(...NIGHT_FLOOR.GRAD_LOW), vec3(...NIGHT_FLOOR.GRAD_HIGH), g);
    return mix(vec3(...NIGHT_FLOOR.CITY), grad, w);
  };
  const skyUV = (d) => { // atmosphere.js skyUV: |azimuth from the sun| / pi, sqrt(elevation / 90 degrees), texel-centred
    const up = clamp(d.y, 0, 1), el = up.asin();
    const dxz = d.xz.div(max(d.xz.length(), 1e-5)), az = acos(clamp(dxz.dot(uSunXZ), -1, 1));
    const u = az.div(Math.PI).mul(SKY_W - 1).add(0.5).div(SKY_W), v = sqrt(el.div(Math.PI / 2)).mul(SKY_H - 1).add(0.5).div(SKY_H);
    return vec2(u, v);
  };
  const sky = (d) => texture(lut, skyUV(d)).rgb.add(nightFloor(d));
  const withStars = (d) => sky(d).add(stars.mul(uStars).mul(smoothstep(0, 0.08, max(d.y, 0))));
  const sunDisc = (d) => uSunDisc.mul(smoothstep(Math.cos(0.004675 * 1.15), Math.cos(0.004675 * 0.85), d.dot(uSunTrue)));
  const horizon = (d) => texture(lut, skyUV(vec3(d.x, 0, d.z))).rgb.add(vec3(...NIGHT_FLOOR.CITY));
  return { sky, withStars, sunDisc, horizon };
}

// The live environment on a stage. `csm`: cascaded shadows on the sun (High, WebGPU). `deps` replaces the browser-only
// parts in tests (the PMREM generator, the moon sprite, the bake timer).
// `clouds`: which clouds (builder/vfx/clouds.js cloudTier; without it the old flat ones).
export function createEnvironment({ renderer, scene, preset, csm = false, clouds = cloudTier({ force: 'flat' }), initial = {}, deps = {} }) {
  const PHONE = preset === 'phone', SH = PHONE ? SHADOW.phone : SHADOW.high;

  // ---------- key light (sun or moon), sky fill ----------
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.name = 'sun'; sun.castShadow = true; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.5; sun.shadow.radius = 2.5;
  sun.shadow.mapSize.set(SH.mapSize, SH.mapSize);
  if (csm) { // webgpu_shadowmap_csm, with Boulevard's values
    const node = new CSMShadowNode(sun, { cascades: 2, maxFar: 800, mode: 'practical', lightMargin: 300 }); node.fade = true;
    sun.shadow.shadowNode = node; sun.shadow.mapSize.set(2048, 2048);
  }
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x8a6f52, 1.0); hemi.name = 'sky fill';
  // the moonlight: shadowless (review nit: no hard moon shadows at 17:30), fading in as the twilight sun key fades out
  const moonLight = new THREE.DirectionalLight(KEY.moonColor, 0); moonLight.name = 'moonlight';
  scene.add(sun, sun.target, hemi, moonLight, moonLight.target);
  const moon = (deps.makeMoon || makeMoonSprite)({ scene, moonLight });

  // ---------- uniforms the sky, the fog and the components read ----------
  const skyTex = new THREE.DataTexture(new Uint16Array(SKY_W * SKY_H * 4), SKY_W, SKY_H, THREE.RGBAFormat, THREE.HalfFloatType);
  skyTex.minFilter = skyTex.magFilter = THREE.LinearFilter; skyTex.wrapS = skyTex.wrapT = THREE.ClampToEdgeWrapping; skyTex.generateMipmaps = false;
  const u = {
    night: uniform(0), day: uniform(1), gold: uniform(0), sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 0.85, 0.6)),
    clouds: uniform(DEFAULT_ENVIRONMENT.clouds), wetness: uniform(0), waterLevel: uniform(0),
    moonDir: uniform(MOON_DIR.clone()), // where the moonlight comes from (sand glints, light through palm leaflets)
    stars: uniform(0), cloudLight: uniform(1), cloudLightDir: uniform(new THREE.Vector3(0, 1, 0)), cloudLightColor: uniform(new THREE.Color(1, 1, 1)), cloudAmbient: uniform(new THREE.Color(0.3, 0.4, 0.6)), hazeDensity: uniform(0.0004).setGroup(renderGroup), skyLUT: { value: skyTex },
  };
  const uSunXZ = uniform(new THREE.Vector2(1, 0)), uSunTrue = uniform(new THREE.Vector3(0, 1, 0)), uSunDisc = uniform(new THREE.Color(0, 0, 0));
  const skyDome = makeSkyDome({ uNight: u.night, uSunDir: u.sunDir, uGold: u.gold, uDay: u.day, uClouds: u.clouds, uCloudLight: u.cloudLight, preset, dir: positionWorldDirection });
  const S = skyNodes({ lut: skyTex, uSunXZ, uStars: u.stars, uSunDisc, uSunTrue, stars: skyDome.starsNode });

  // the background: the atmosphere (the horizon row below the horizon, so the haze meets it), the sun disc, clouds over
  // (volumetric on High with WebGPU, builder/vfx/clouds.js; the old flat clouds of builder/vfx/sky.js everywhere else)
  const volume = clouds.kind === 'volumetric'
    ? (deps.makeVolumeClouds || makeVolumeClouds)({ dir: positionWorldDirection, uClouds: u.clouds, uLightDir: u.cloudLightDir, uLightColor: u.cloudLightColor, uAmbient: u.cloudAmbient, horizon: (d) => S.horizon(d), quality: clouds.quality })
    : null;
  {
    const d = positionWorldDirection.normalize(), behind = S.withStars(d).add(S.sunDisc(d));
    scene.backgroundNode = volume
      ? Fn(() => { const c = volume.node.toVar(); return mix(behind, c.rgb, c.a); })()
      : mix(behind, skyDome.colorNode, skyDome.opacityNode);
  }

  // ---------- haze: aerial perspective by distance (webgpu_custom_fog_background: the colour of the sky at the horizon in
  // the view's direction) combined with the height fog (webgpu_fog_height): the haze lies below FOG_H and thins upward ----
  const FOG_H = 40, uFogMax = uniform(0.9);
  const fogHeight = uniform(FOG_H).setGroup(renderGroup), fogHDensity = uniform(0.0035 / FOG_H).setGroup(renderGroup);
  {
    const view = positionWorld.sub(cameraPosition), dist = view.length(), dv = view.div(max(dist, 1e-4));
    const height = min(exponentialHeightFogFactor(fogHDensity, fogHeight), uFogMax);
    const aerial = exp(dist.mul(u.hazeDensity).negate()); // transmittance of the air between the eye and the surface
    scene.fogNode = fogNode(S.horizon(dv), float(1).sub(height.oneMinus().mul(aerial)).min(0.985));
  }

  // ---------- environment light: PMREM of the same sky without its sun disc (webgpu_generator_city updateSun) ----------
  const envScene = new THREE.Scene();
  const envBox = makeSkyBox(S.sky(positionWorldDirection.normalize())); envScene.add(envBox);
  const pmrem = deps.pmrem || new THREE.PMREMGenerator(renderer);
  let envRT = null, bakes = 0, disposed = false;
  function bake() {
    if (disposed) return;
    envRT = pmrem.fromScene(envScene, 0, 0.1, 100, envRT ? { renderTarget: envRT } : {});
    scene.environment = envRT.texture; u.envMap = envRT.texture; bakes++; // u.envMap: the same PMREM for mirrors (water) at full sky brightness
  }
  // while the hour moves (the time-of-day slider): at most 4 bakes a second on High, 2.5 on Phone (Boulevard: 400 ms), and
  // always once more at the end, so dragging never rebuilds the PMREM every frame
  const throttle = createBakeThrottle({ interval: PHONE ? 400 : 250, run: bake, ...(deps.later ? { later: deps.later, cancel: deps.cancel } : {}) });

  let env = normalizeEnvironment(initial), terms = null, keyDir = new THREE.Vector3(0, 1, 0);
  const focus = new THREE.Vector3(); // where the key light's shadow is centred (update() moves it with the view)
  function upload(lut) { // the CPU-built sky-view LUT, as half floats
    const d = skyTex.image.data;
    for (let i = 0, n = SKY_W * SKY_H; i < n; i++) {
      d[i * 4] = THREE.DataUtils.toHalfFloat(lut[i * 3]); d[i * 4 + 1] = THREE.DataUtils.toHalfFloat(lut[i * 3 + 1]); d[i * 4 + 2] = THREE.DataUtils.toHalfFloat(lut[i * 3 + 2]); d[i * 4 + 3] = 0x3c00;
    }
    skyTex.needsUpdate = true;
  }
  function apply() {
    const P = hourParams(env, preset), { elD, gold, night } = P, dayT = P.day;
    upload(P.sky.lut);
    const s = P.skySun, h = Math.hypot(s[0], s[2]);
    uSunXZ.value.set(h > 1e-6 ? s[0] / h : 1, h > 1e-6 ? s[2] / h : 0); uSunTrue.value.set(...s);
    uSunDisc.value.setRGB(...P.sky.sun.map((v) => v * 60)); // the disc: the transmitted sun, bright enough to bloom
    keyDir.copy(P.sunDir); sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(keyDir, 1200);
    sun.intensity = P.sunIntensity; sun.color.copy(P.sunColor); u.sunColor.value.copy(P.sunColor).multiplyScalar(1.4);
    moonLight.intensity = P.moonIntensity; moonLight.color.copy(P.moonColor);
    moonLight.target.position.copy(focus); moonLight.position.copy(focus).addScaledVector(P.moonDir, 1000);
    hemi.intensity = P.hemiIntensity; hemi.color.copy(P.hemiColor); hemi.groundColor.copy(P.hemiGround);
    fogHDensity.value = P.fogDensity / FOG_H; uFogMax.value = P.fogMax; u.hazeDensity.value = P.hazeDensity;
    u.night.value = night; u.day.value = dayT; u.gold.value = gold; u.sunDir.value.copy(P.sunDir); u.stars.value = P.stars; u.cloudLight.value = P.sky.cloudLight;
    u.cloudLightDir.value.copy(P.cloudLightDir); u.cloudLightColor.value.copy(P.cloudLightColor); u.cloudAmbient.value.copy(P.cloudAmbient);
    u.clouds.value = env.clouds; u.wetness.value = env.wetness; u.waterLevel.value = env.waterLevel;
    moon.visible = P.moonVisible;
    scene.environmentIntensity = P.environmentIntensity;
    renderer.toneMappingExposure = P.exposure;
    terms = { elevationDeg: elD, day: dayT, gold, night, moonVisible: moon.visible, exposure: P.exposure, lampsOn: P.lampsOn, searchlights: P.searchlights, stars: P.stars, key: P.keyBody, keyIntensity: P.keyIntensity };
    throttle.request();
  }
  apply();

  const lightBasis = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();
  const api = {
    sun, hemi, moonLight, moon, uniforms: u,
    /** Which clouds this stage shows: { kind: 'volumetric' | 'flat', quality, reason } and the noise volume (or null). */
    clouds: Object.freeze({ ...clouds, texture: volume?.texture ?? null, module: volume ? volume.userData.vfx.module : skyDome.userData.vfx.module }),
    get: () => ({ ...env }),
    terms: () => ({ ...terms }),
    /** Change some keys, keeping the others (a script or the URL's ?hour). */
    set(partial = {}) { env = normalizeEnvironment(partial, env); apply(); return api.get(); },
    /** The document's environment as the whole truth: a key it lacks takes its default (review M2: the undo of a new key). */
    replace(full = {}) { env = normalizeEnvironment(full, DEFAULT_ENVIRONMENT); apply(); return api.get(); },
    ready: () => bakes > 0 && !throttle.pending(),
    /** Bake a pending environment light now (the end of a slider drag). */
    flush: () => throttle.flush(),
    // each frame: the moon stays 7 km out along its direction; the key light's shadow follows the view's focus
    update(camera, target) {
      if (moon.visible) moon.position.copy(camera.position).addScaledVector(moon.userData.dir, 7000);
      tmp.copy(target);
      if (!csm) { // a shadow camera fitted round the focus (webgpu_generator_city fits it to the city box), texel-snapped
        const R = Math.min(SH.maxR, Math.max(60, camera.position.distanceTo(target) * 1.1)), texel = (2 * R) / sun.shadow.mapSize.x;
        Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 10, far: 3000 }); sun.shadow.camera.updateProjectionMatrix();
        // threejs-shadow-systems: snap the projection centre to the texel grid in light space, so a moving view does not
        // crawl the shadow edges, and scale the normal bias with the texel
        lightBasis.lookAt(tmp.clone().addScaledVector(keyDir, 1200), tmp, UP).extractBasis(X, Y, Z);
        const x = tmp.dot(X), y = tmp.dot(Y);
        tmp.addScaledVector(X, Math.round(x / texel) * texel - x).addScaledVector(Y, Math.round(y / texel) * texel - y);
        // grazing light on a ground that casts and receives its own shadow (a dune terrain with draw.<preset>.shadow on)
        // needs more offset along the normal: 1.5 texels overhead, up to 3 at the horizon
        sun.shadow.normalBias = texel * (1.5 + 1.5 * (1 - Math.max(0, keyDir.y)));
      }
      focus.copy(tmp); sun.target.position.copy(tmp); sun.position.copy(tmp).addScaledVector(keyDir, 1200);
      moonLight.target.position.copy(tmp); moonLight.position.copy(tmp).addScaledVector(moon.userData.dir, 1000);
    },
    dispose() {
      disposed = true; throttle.dispose();
      scene.remove(sun, sun.target, hemi, moonLight, moonLight.target); moon.userData.dispose();
      sun.dispose(); hemi.dispose(); moonLight.dispose(); sun.shadow.shadowNode?.dispose?.();
      envRT?.dispose(); pmrem.dispose(); envBox.userData.dispose(); skyTex.dispose(); volume?.dispose();
      scene.environment = null; scene.backgroundNode = null; scene.fogNode = null;
    },
  };
  return api;
}
