// atmosphere.js: the builder's physically based sky model, in plain JavaScript (no three.js import), so the page and the
// unit tests run the very same numbers. Environment rig, 11 Nov 2026 (the time-of-day review: Preetham's SkyMesh had no
// ozone and no multiple scattering, a green band at golden hour, and an earth-shadow cutoff at -2.3 degrees that did not
// match the exposure curve).
//
// Model: Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR), as the
// threejs-atmosphere-aerial-perspective skill's LUT tier: Rayleigh + Mie + ozone with the skill contract's Earth defaults
// (references/atmosphere-system-contract.md: radii, coefficients, scale heights, the ozone tent), a transmittance LUT, a
// multiple-scattering LUT (psi_ms, Hillaire section 5.5: isotropic second order times 1 / (1 - f_ms)) and a sky-view LUT
// (azimuth from the sun x elevation, the horizon-weighted v = sqrt(elevation / 90 degrees) of section 5.3). The
// transmittance and multiple-scattering LUTs depend only on the aerosol amount (`haze`), so they are built once per haze
// value; the 32 x 32 sky-view LUT is built on the CPU for each sun elevation (a few ms) and uploaded as a half-float
// texture that the sky node only samples (builder/environment.js). Nothing is raymarched on the GPU, so the phone pays one
// texture fetch per sky pixel, as it paid for the old cube.
//
// One curve drives everything (the review's fix list): the sky meter (the hemisphere's mean luminance, from the same LUT)
// gives the exposure, the star visibility and the night floor's share, so the sky never goes darker at dusk than at night
// and the stars come out only once the sky itself is dark.
//
// Units: lengths in km, the sun's irradiance of luminance 1 outside the atmosphere (SUN_E), radiance relative to it; SKY_GAIN is
// the one conversion to the scene's light units (a clear zenith a fifth of a white sunlit surface, see ZENITH_TO_WHITE).

export const RG = 6360, RT = 6460; // ground and top radii (km)
const RAY = [5.802e-3, 13.558e-3, 33.1e-3], RAY_H = 8; // Rayleigh scattering (1/km) and scale height (km)
const MIE_S = 3.996e-3, MIE_E = 4.44e-3, MIE_H = 1.2, MIE_G = 0.8; // Mie scattering, extinction, scale height, phase g
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3], OZ_C = 25, OZ_W = 15; // ozone absorption (1/km), tent centre and half width
const ALBEDO = 0.3; // the ground's albedo for the multiple-scattering bounce: desert sand (Bruneton's default is 0.1)
const SUN_R = 0.004675; // the sun's angular radius (rad)
// the sun's irradiance outside the atmosphere, white-balanced: set (below, SUN_E) so that the sun seen through the air
// at 60 degrees and the default haze is white, as a camera balanced for daylight sees it (the skill contract's solar
// irradiance 1.474, 1.8504, 1.91198 tinted the noon sun green once the ozone had taken its share)
let SUN_E = [1, 1, 1];
export const CAMERA_ALT = 0.2; // km above the ground: the eye of a builder view
const D2R = Math.PI / 180;

/** The aerosol optical depth for Environment.haze 0..1: 0.01 (very clear) .. 0.21 (dusty), 0.035 at the default
 * 0.35, which keeps a golden 1-degree sun (Mie air mass ~40 there). Returned as the Mie density multiplier. */
export const DEFAULT_HAZE = 0.35;
export const mieScale = (haze = DEFAULT_HAZE) => (0.01 + 0.2 * haze * haze) / (MIE_E * MIE_H);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function medium(h, k, out) { // scattering R, scattering M, extinction rgb at altitude h (km)
  const dr = Math.exp(-h / RAY_H), dm = Math.exp(-h / MIE_H) * k, oz = Math.max(0, 1 - Math.abs(h - OZ_C) / OZ_W);
  out.sm = MIE_S * dm;
  for (let i = 0; i < 3; i++) { out.sr[i] = RAY[i] * dr; out.et[i] = out.sr[i] + MIE_E * dm + OZONE[i] * oz; }
  return out;
}
const newMedium = () => ({ sr: [0, 0, 0], sm: 0, et: [0, 0, 0] });
// distance along a ray from radius r with cosine mu to the sphere of radius R (the far hit), and to the ground (or -1)
const toTop = (r, mu) => { const d = r * r * (mu * mu - 1) + RT * RT; return Math.max(0, -r * mu + Math.sqrt(Math.max(0, d))); };
const toGround = (r, mu) => { const d = r * r * (mu * mu - 1) + RG * RG; return mu < 0 && d >= 0 ? -r * mu - Math.sqrt(d) : -1; };

// ---------- transmittance LUT (Bruneton's mapping: x_mu by distance to the top, x_r by rho) ----------
const TW = 128, TH = 32, HH = Math.sqrt(RT * RT - RG * RG);
function transmittanceUV(r, mu) {
  const rho = Math.sqrt(Math.max(0, r * r - RG * RG)), d = toTop(r, mu), dmin = RT - r, dmax = rho + HH;
  return [(d - dmin) / Math.max(1e-9, dmax - dmin), rho / HH];
}
function buildTransmittance(k) {
  const data = new Float32Array(TW * TH * 3), m = newMedium();
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const xm = x / (TW - 1), xr = y / (TH - 1), rho = HH * xr, r = Math.sqrt(rho * rho + RG * RG);
    const dmin = RT - r, dmax = rho + HH, d = dmin + xm * (dmax - dmin);
    const mu = d === 0 ? 1 : clamp((HH * HH - rho * rho - d * d) / (2 * r * d), -1, 1);
    const N = 40, dt = d / N, od = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * dt, h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG; medium(Math.max(0, h), k, m);
      for (let c = 0; c < 3; c++) od[c] += m.et[c] * dt;
    }
    const o = (y * TW + x) * 3; for (let c = 0; c < 3; c++) data[o + c] = Math.exp(-od[c]);
  }
  return data;
}
function bilinear(data, W, H, u, v, out) { // texel-centred, clamp to edge: what the GPU's linear filter does
  const fx = clamp(u * W - 0.5, 0, W - 1), fy = clamp(v * H - 0.5, 0, H - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * W + x0) * 3 + c], b = data[(y0 * W + x1) * 3 + c], d = data[(y1 * W + x0) * 3 + c], e = data[(y1 * W + x1) * 3 + c];
    out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
  }
  return out;
}
// the LUT is sampled at texel centres spanning [0, 1]: map x in [0,1] to the centre of texel 0 .. W-1
const centred = (x, W) => (0.5 + x * (W - 1)) / W;

/** Transmittance from radius r towards the sun at cosine mu_s, with the sun's disc setting behind the planet. */
function sunTransmittance(A, r, mus, out) {
  const muH = -Math.sqrt(Math.max(0, 1 - (RG / r) * (RG / r)));
  const vis = smoothstep(-SUN_R, SUN_R, mus - muH);
  if (vis <= 0) { out[0] = out[1] = out[2] = 0; return out; }
  const [u, v] = transmittanceUV(r, Math.max(mus, muH + 1e-4));
  bilinear(A.T, TW, TH, centred(u, TW), centred(v, TH), out);
  out[0] *= vis; out[1] *= vis; out[2] *= vis;
  return out;
}

// ---------- multiple-scattering LUT (Hillaire 5.5) ----------
const MW = 16, MH = 16, MS_DIRS = 64; // 16 x 16: psi_ms is smooth in altitude and sun angle (Hillaire uses 32 x 32 on the GPU; on the CPU this keeps a new haze step under ~100 ms)
function buildMultiScattering(A) {
  const data = new Float32Array(MW * MH * 3), m = newMedium(), ts = [0, 0, 0];
  const dirs = []; // a Fibonacci sphere
  for (let i = 0; i < MS_DIRS; i++) { const y = 1 - (2 * (i + 0.5)) / MS_DIRS, s = Math.sqrt(1 - y * y), p = i * Math.PI * (3 - Math.sqrt(5)); dirs.push([Math.cos(p) * s, y, Math.sin(p) * s]); }
  for (let yy = 0; yy < MH; yy++) for (let xx = 0; xx < MW; xx++) {
    const mus = -1 + (2 * xx) / (MW - 1), h = Math.max(0.01, ((RT - RG) * yy) / (MH - 1)), r = RG + h;
    const sun = [Math.sqrt(1 - mus * mus), mus, 0], L2 = [0, 0, 0], F = [0, 0, 0];
    for (const w of dirs) {
      const mu = w[1], tg = toGround(r, mu), tmax = tg > 0 ? tg : toTop(r, mu), N = 20, dt = tmax / N, Tv = [1, 1, 1];
      for (let i = 0; i < N; i++) {
        const t = (i + 0.5) * dt, px = w[0] * t, py = r + w[1] * t, pz = w[2] * t, rr = Math.hypot(px, py, pz);
        medium(Math.max(0, rr - RG), A.k, m);
        sunTransmittance(A, rr, (px * sun[0] + py * sun[1] + pz * sun[2]) / rr, ts);
        for (let c = 0; c < 3; c++) {
          const ss = m.sr[c] + m.sm, et = m.et[c], st = Math.exp(-et * dt), integ = (1 - st) / et;
          L2[c] += Tv[c] * ss * ts[c] * (1 / (4 * Math.PI)) * integ / MS_DIRS;
          F[c] += Tv[c] * ss * integ / MS_DIRS;
          Tv[c] *= st;
        }
      }
      if (tg > 0) { // the sunlit ground bounces light back up
        const gx = w[0] * tg, gy = r + w[1] * tg, gz = w[2] * tg, gr = Math.hypot(gx, gy, gz), gmu = (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr;
        sunTransmittance(A, gr, gmu, ts);
        for (let c = 0; c < 3; c++) L2[c] += Tv[c] * ts[c] * Math.max(0, gmu) * (ALBEDO / Math.PI) / MS_DIRS;
      }
    }
    const o = (yy * MW + xx) * 3; for (let c = 0; c < 3; c++) data[o + c] = L2[c] / (1 - F[c]);
  }
  return data;
}
function multiScattering(A, h, mus, out) {
  return bilinear(A.M, MW, MH, centred(clamp((mus + 1) / 2, 0, 1), MW), centred(clamp(h / (RT - RG), 0, 1), MH), out);
}

const cache = new Map();
/** Haze is quantised to 1/HAZE_STEPS for the LUTs (review S-a: a new haze value cost ~230 ms of LUT building). */
export const HAZE_STEPS = 20;
/** The atmosphere for a haze value: its transmittance and multiple-scattering LUTs (built once per haze step). */
export function atmosphere(haze = DEFAULT_HAZE) {
  const key = Math.round(clamp(haze, 0, 1) * HAZE_STEPS) / HAZE_STEPS; // quantised: a haze drag builds one LUT set per step
  if (!cache.has(key)) {
    const A = { haze: key, k: mieScale(key) };
    A.T = buildTransmittance(A.k); A.M = buildMultiScattering(A);
    if (cache.size > HAZE_STEPS + 1) cache.delete(cache.keys().next().value);
    cache.set(key, A);
  }
  return cache.get(key);
}

const rayleighPhase = (c) => (3 / (16 * Math.PI)) * (1 + c * c);
const miePhase = (c) => { const g = MIE_G, g2 = g * g; return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5)); }; // Cornette-Shanks

/** Sky radiance (sun irradiance 1) towards elevation `el` and azimuth `az` from the sun (radians), sun at `sunEl`. */
export function skyRadianceRaw(A, el, az, sunEl, out = [0, 0, 0], N = 24) {
  const r0 = RG + CAMERA_ALT, ce = Math.cos(el), dir = [ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)], sun = [Math.cos(sunEl), Math.sin(sunEl), 0];
  const cosT = dir[0] * sun[0] + dir[1] * sun[1], pR = rayleighPhase(cosT), pM = miePhase(cosT);
  const tmax = toTop(r0, dir[1]), m = newMedium(), ts = [0, 0, 0], ms = [0, 0, 0], Tv = [1, 1, 1];
  out[0] = out[1] = out[2] = 0;
  let t0 = 0;
  for (let i = 0; i < N; i++) {
    const t1 = tmax * Math.pow((i + 1) / N, 2), dt = t1 - t0, t = 0.5 * (t0 + t1); t0 = t1; // denser near the eye
    const px = dir[0] * t, py = r0 + dir[1] * t, pz = dir[2] * t, r = Math.hypot(px, py, pz), h = Math.max(0, r - RG);
    const mus = (px * sun[0] + py * sun[1]) / r;
    medium(h, A.k, m); sunTransmittance(A, r, mus, ts); multiScattering(A, h, mus, ms);
    for (let c = 0; c < 3; c++) {
      const s = (m.sr[c] * pR + m.sm * pM) * ts[c] + (m.sr[c] + m.sm) * ms[c], et = m.et[c], st = Math.exp(-et * dt);
      out[c] += Tv[c] * s * (1 - st) / et; Tv[c] *= st;
    }
  }
  out[0] *= SUN_E[0]; out[1] *= SUN_E[1]; out[2] *= SUN_E[2];
  return out;
}

// ---------- the sky-view LUT ----------
export const SKY_W = 32, SKY_H = 32;
/** LUT coordinates of a direction: u = |azimuth from the sun| / pi, v = sqrt(elevation / 90 degrees) (horizon-weighted);
 * below the horizon the horizon row is used. The sky node computes the same in TSL (builder/environment.js skyUV). */
export function skyUV(el, az) {
  let a = Math.abs(az) % (2 * Math.PI); if (a > Math.PI) a = 2 * Math.PI - a;
  return [centred(a / Math.PI, SKY_W), centred(Math.sqrt(clamp(el / (Math.PI / 2), 0, 1)), SKY_H)];
}
/** The sky-view LUT for a sun elevation (radians): Float32 RGB, SKY_W x SKY_H, radiance x SKY_GAIN (scene units). */
export function buildSkyView(A, sunEl) {
  const data = new Float32Array(SKY_W * SKY_H * 3), c = [0, 0, 0];
  for (let y = 0; y < SKY_H; y++) {
    const v = y / (SKY_H - 1), el = v * v * (Math.PI / 2);
    for (let x = 0; x < SKY_W; x++) {
      skyRadianceRaw(A, Math.max(el, 0.0005), (x / (SKY_W - 1)) * Math.PI, sunEl, c, 16); // 16 steps: the LUT is rebuilt per frame while the hour moves
      const o = (y * SKY_W + x) * 3; data[o] = c[0] * SKY_GAIN; data[o + 1] = c[1] * SKY_GAIN; data[o + 2] = c[2] * SKY_GAIN;
    }
  }
  return data;
}
export const sampleSky = (lut, el, az, out = [0, 0, 0]) => { const [u, v] = skyUV(el, az); return bilinear(lut, SKY_W, SKY_H, u, v, out); };

SUN_E = (() => { const T = sunTransmittance(atmosphere(DEFAULT_HAZE), RG + CAMERA_ALT, Math.sin(60 * D2R), [0, 0, 0]), w = T.map((v) => 1 / v), l = luminance(w); return w.map((v) => v / l); })();
export const SUN_WHITE_BALANCE = SUN_E;

/** The scene's sun: a DirectionalLight of this intensity is the noon sun's irradiance (a white Lambert surface facing it
 * shows SUN_SCENE / pi), builder/environment.js KEY.sun. */
export const SUN_SCENE = 3.4;
/** The scene-unit gain, set by one measured ratio: a clear noon zenith is about a fifth as bright as a white surface in
 * the sun (zenith 3,000-8,000 cd/m2 against ~30,000 for white paper at 100 klx: CIE clear-sky data). The first version
 * matched the old Preetham sky's zenith (4x brighter), which made the horizon - and so the haze - 3x brighter than the
 * sand it lay over: the coordinator saw the 12:00 frame washed out. */
export const ZENITH_TO_WHITE = 0.2;
export const SKY_GAIN = (() => { const A = atmosphere(DEFAULT_HAZE); return (ZENITH_TO_WHITE * SUN_SCENE / Math.PI) / luminance(skyRadianceRaw(A, Math.PI / 2, 0, 45 * D2R, [0, 0, 0], 48)); })();

// ---------- the night floor: moonlit airglow overhead, Riyadh's warm city glow along the horizon ----------
// (the old night overlay of builder/vfx/sky.js and the night haze of the scene-quality pass: Kereem's approved 21:00)
const GRAD_LOW = [0.03, 0.045, 0.09], GRAD_HIGH = [0.006, 0.01, 0.028], CITY = [0.027, 0.017, 0.015];
export function nightFloor(el, out = [0, 0, 0]) {
  const up = Math.max(0, Math.sin(el)), g = Math.pow(up, 0.6), w = smoothstep(0, 0.12, up);
  for (let c = 0; c < 3; c++) { const grad = GRAD_LOW[c] + (GRAD_HIGH[c] - GRAD_LOW[c]) * g; out[c] = CITY[c] + (grad - CITY[c]) * w; }
  return out;
}
export const NIGHT_FLOOR = { GRAD_LOW, GRAD_HIGH, CITY };

/** The sky meter: the mean luminance of the upper hemisphere (cosine-weighted, as an incident-light meter) of a sky-view
 * LUT, with or without the night floor. */
export function skyMeter(lut, { floor = true } = {}) {
  let sum = 0, wsum = 0; const c = [0, 0, 0], f = [0, 0, 0];
  for (let i = 0; i < 12; i++) {
    const el = ((i + 0.5) / 12) * (Math.PI / 2), w = Math.cos(el) * Math.sin(el); // solid angle x cosine
    for (let j = 0; j < 12; j++) {
      sampleSky(lut, el, ((j + 0.5) / 12) * Math.PI, c);
      let L = luminance(c); if (floor) L += luminance(nightFloor(el, f));
      sum += L * w; wsum += w;
    }
  }
  return sum / wsum;
}

const meterCache = new Map();
/** The atmosphere-only sky meter at a sun elevation (degrees), cached per haze and 0.01 degree. */
export function meterAt(A, elD) {
  const key = `${A.haze}:${Math.round(elD * 100)}`;
  if (!meterCache.has(key)) { if (meterCache.size > 4000) meterCache.clear(); meterCache.set(key, skyMeter(buildSkyView(A, elD * D2R), { floor: false })); }
  return meterCache.get(key);
}
const floorMeter = (() => { let sum = 0, wsum = 0; const f = [0, 0, 0]; for (let i = 0; i < 12; i++) { const el = ((i + 0.5) / 12) * (Math.PI / 2), w = Math.cos(el) * Math.sin(el); sum += luminance(nightFloor(el, f)) * w * 12; wsum += w * 12; } return sum / wsum; })();
export const NIGHT_METER = floorMeter;

/** Exposure from the meter: EXPOSURE.day at the reference sky (sun 45 degrees), EXPOSURE.night once the sky is as dim
 * as at sunset (sun at EXPOSURE.fullAtDeg), a power law between (adaptation, as the eye and a camera do) and constant
 * below. Review of PR #21 (M1): the first curve reached the night value only at the night floor, so the light on the
 * ground fell 10x from noon to golden hour while the exposure rose 1.4x, and the moonlit night came out as bright as
 * golden hour. Now the eye is adapted by sunset; from there to night the light falls and the exposure holds, so the frame
 * darkens monotonically. Displayed brightness = meter x exposure still rises with the meter: the sky is never darker at
 * dusk than at night. */
export const EXPOSURE = Object.freeze({ day: 0.95, night: 1.7, fullAtDeg: 0 });
export function exposureFor(A, meter) {
  const ref = refMeter(A), low = meterAt(A, EXPOSURE.fullAtDeg) + NIGHT_METER, a = Math.log(EXPOSURE.night / EXPOSURE.day) / Math.log(ref / low);
  return clamp(EXPOSURE.day * Math.pow(Math.max(meter, NIGHT_METER) / ref, -a), EXPOSURE.day, EXPOSURE.night);
}

export const refMeter = (A) => meterAt(A, 45) + NIGHT_METER;

/** Star visibility from the sky's own brightness: 0 while the atmosphere is brighter than at a -6 degree sun (civil
 * dusk), 1 once it is as dark as at -12 degrees (nautical dusk), smooth in log luminance between. */
export function starVisibility(A, atmMeter) {
  const hi = meterAt(A, -6), lo = meterAt(A, -12), eps = 1e-7 * meterAt(A, 45);
  return 1 - smoothstep(Math.log(lo + eps), Math.log(hi + eps), Math.log(atmMeter + eps));
}

/** The direct sun at the eye (sun elevation in radians): its irradiance through the air (colour and strength). */
export function sunAtEye(A, sunEl, out = [0, 0, 0]) { sunTransmittance(A, RG + CAMERA_ALT, Math.sin(sunEl), out); for (let c = 0; c < 3; c++) out[c] *= SUN_E[c]; return out; }

/** The mean colour of the sky (cosine-weighted upper hemisphere, night floor included) and of its horizon row: the sky
 * fill's colour and the haze's mean colour. */
export function skyColours(lut) {
  const sky = [0, 0, 0], hor = [0, 0, 0], c = [0, 0, 0], f = [0, 0, 0]; let w = 0;
  for (let i = 0; i < 8; i++) {
    const el = ((i + 0.5) / 8) * (Math.PI / 2), wi = Math.cos(el) * Math.sin(el); nightFloor(el, f);
    for (let j = 0; j < 8; j++) { sampleSky(lut, el, ((j + 0.5) / 8) * Math.PI, c); for (let k = 0; k < 3; k++) sky[k] += (c[k] + f[k]) * wi; w += wi; }
  }
  nightFloor(0, f);
  for (let j = 0; j < 16; j++) { sampleSky(lut, 0, ((j + 0.5) / 16) * Math.PI, c); for (let k = 0; k < 3; k++) hor[k] += (c[k] + f[k]) / 16; }
  return { sky: sky.map((v) => v / w), horizon: hor };
}

/** Extinction at the ground (1/km, luminance-weighted): Rayleigh + the haze's aerosols (+ no ozone down here). */
export const groundExtinction = (haze) => luminance(RAY) + MIE_E * mieScale(haze);

/** Everything the stage needs from the sky for one sun elevation (degrees) and haze. */
export function skyState(haze, elD) {
  const A = atmosphere(haze), lut = buildSkyView(A, elD * D2R), atm = skyMeter(lut, { floor: false }), meter = atm + NIGHT_METER;
  return { A, lut, atmMeter: atm, meter, cloudLight: Math.min(1, Math.sqrt(meter / refMeter(A))), exposure: exposureFor(A, meter), stars: starVisibility(A, atm), sun: sunAtEye(A, elD * D2R), ...skyColours(lut) };
}

/** The sky's colour in one direction exactly as the background node composes it (without clouds and the sun disc):
 * LUT x 1 + night floor + stars x visibility (`star` 0..1 for a star pixel). The CPU test of rendered sky colour. */
export function skyPixel(state, el, az, star = 0) {
  const c = sampleSky(state.lut, el, az), f = nightFloor(el), s = star * state.stars * STAR_GAIN * smoothstep(0, 0.08, Math.max(0, Math.sin(el)));
  return [c[0] + f[0] + STAR_COLOR[0] * s, c[1] + f[1] + STAR_COLOR[1] * s, c[2] + f[2] + STAR_COLOR[2] * s];
}
export const STAR_COLOR = [0.9, 0.93, 1.0], STAR_GAIN = 1.6; // builder/vfx/sky.js stars
