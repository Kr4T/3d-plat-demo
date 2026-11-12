// dunes.js: the aeolian dune field of the builder's desert terrain (builder/sculpt/desert-terrain.js). r187 examples:
// webgpu_tsl_procedural_terrain (a terrain height from noise, its normal rebuilt from neighbouring heights) and
// webgl_geometry_terrain (a height field written once into a grid mesh). Recipe: threejs-procedural-fields (named fields per
// frequency band: dune form, crest bending, height variation, regional swell; the coordinates are domain-warped, not the
// results, so crests bend and break instead of running as sine stripes). Pure: no three.js objects, only its ImprovedNoise.
//
// Wind: windAngle (degrees) is the direction the wind blows TOWARD, (cos, sin) in world (x, z): the sand material's own
// convention for its ripples (shared/materials/boulevard-ground.js `wind`), so ripples and dunes face one wind. Downwind
// coordinate a = x cos + z sin, crosswind c = -x sin + z cos.
// Slopes: every form is built with its steepest face (the slip face) at most `maxSlope` degrees (nominal 0.94 of it, so the
// crest bending of the warp stays under the cap; the terrain's face limiter takes what is left). The sand's top-down texture
// projection stretches by 1 / cos(slope): 15 degrees is 3.5 %, the 25 degree maximum 10 % (tests/sand-round.test.mjs).
// Height: the tallest dune a form can have at a spacing and cap is limited (a slip face at the cap and a windward side at
// most half as steep must fit in one spacing), so `height` asks and `effectiveHeight` says what the form gives.
// Types (all deterministic per seed):
//   transverse  crests across the wind: long gentle windward (stoss) side, sharp brink, steep lee slip face, interdune flats
//               for low dunes; crest lines bent by a slow warp, heights varied and broken along the crest (irregularity).
//   barchan     isolated crescents on the plain: a convex windward body, the slip face inside the crescent, horns pointing
//               downwind (the crest line bends downwind towards the sides); one per jittered cell, some cells empty.
//   star        a peak with 3-5 sinuous arms at multi-directional angles, sharp arm crests, steep flanks; one per cell.
//   linear      seif ridges along the wind: symmetric flanks, sharp sinuous crests, peaks and saddles along the ridge.
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

export const DUNE_TYPES = Object.freeze(['transverse', 'barchan', 'star', 'linear']);
const RAD = Math.PI / 180, TAU = Math.PI * 2;
const perlin = new ImprovedNoise();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** |d| rounded over w (its slope never exceeds 1): a crest the mesh can carry. */
const softAbs = (d, w) => (w > 0 ? Math.sqrt(d * d + w * w) - w : Math.abs(d));
/** Distance from (u, v) to the parabola u = b v^2: the closest point's v solves t^3 + p t + q = 0 (Cardano, or the three
 * trigonometric roots, nearest kept). */
function parabolaDistance(b, u, v) {
  const p = (1 - 2 * b * u) / (2 * b * b), q = -v / (2 * b * b), D = (q * q) / 4 + (p * p * p) / 27;
  const d = (t) => Math.hypot(u - b * t * t, v - t);
  if (D >= 0) { const s = Math.sqrt(D); return d(Math.cbrt(-q / 2 + s) + Math.cbrt(-q / 2 - s)); }
  const r = 2 * Math.sqrt(-p / 3), phi = Math.acos(Math.max(-1, Math.min(1, ((3 * q) / (2 * p)) * Math.sqrt(-3 / p)))) / 3;
  return Math.min(d(r * Math.cos(phi)), d(r * Math.cos(phi - (2 * Math.PI) / 3)), d(r * Math.cos(phi - (4 * Math.PI) / 3)));
}
/** Polynomial smooth minimum: its gradient is a blend of the two, so it never steepens either. */
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
/** A hash of two cell indices, the seed and a channel, in [0, 1). */
function hash(i, j, seed, k) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(seed | 0, 2246822519) ^ Math.imul(k | 0, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The dune field: { height(x, z, w = 0) -> metres >= 0 (w: crests rounded over w metres, the mesh's cell there), effectiveHeight (the tallest dune the form gives), maxHeight (with the
 * regional swell: an upper bound of height()), type, opts }.
 * opts: type (DUNE_TYPES), height (m, asked), spacing (m between crests or dunes), windAngle (deg), irregularity (0..1),
 * seed (integer), maxSlope (deg).
 */
export function duneField({ type = 'transverse', height = 10, spacing = 140, windAngle = 35, irregularity = 0.5, seed = 7, maxSlope = 15 } = {}) {
  if (!DUNE_TYPES.includes(type)) throw new Error(`dunes: unknown type "${type}" (${DUNE_TYPES.join(', ')})`);
  const lam = Math.max(1, +spacing), H = Math.max(0, +height), irr = clamp(+irregularity || 0, 0, 1), sd = Math.round(+seed || 0);
  const th = (+windAngle || 0) * RAD, wx = Math.cos(th), wz = Math.sin(th);
  const tanCap = Math.tan(clamp(+maxSlope || 15, 1, 60) * RAD), m = tanCap * 0.94;
  const sy = sd * 1.618034 + 0.5; // the seed picks a slice of the noise volume
  const N = (x, k, z) => perlin.noise(x, sy + k * 13.37, z);
  const frame = (x, z) => [x * wx + z * wz, -x * wz + z * wx];
  // regional swell, the broad band under every form (about 600 m), 12 % of the height
  const swell = (x, z) => H * 0.12 * (0.5 + 0.5 * N(x / 600 + 0.31, 20, z / 600 + 0.77));
  // along-crest height variation and breaks (irregularity), shared by transverse and linear
  const amp = (x, z) => {
    const u = 0.5 + 0.5 * N(x / (3.5 * lam) + 0.13, 7, z / (3.5 * lam) + 0.29);
    const br = N(x / (1.7 * lam) + 0.41, 11, z / (1.7 * lam) + 0.83);
    return (1 - 0.5 * irr * (1 - u)) * (1 - irr * 0.85 * (1 - smooth(-0.55, -0.2, br)));
  };
  let form, eff;

  if (type === 'transverse') {
    // one crest family: the downwind coordinate domain-warped (slow crest bending, 3.2 spacings across and up to 0.9 of a
    // spacing, plus a smaller band), the profile laid along it with the slip face at the cap
    const family = (x, z, a, c, L, f, Hask, gH, w) => {
      const warp = (aa, cc) => aa + L * irr * (0.9 * N(cc / (3.2 * L) + 0.5 + 7 * f, 1, aa / (6 * L)) + 0.28 * N(cc / (1.1 * L), 3 + 5 * f, aa / (2.3 * L) + 0.5));
      const s = warp(a, c), e = 0.75;
      const G = Math.max(1, Math.hypot((warp(a + e, c) - warp(a - e, c)) / (2 * e), (warp(a, c + e) - warp(a, c - e)) / (2 * e)));
      // the slope along the warped coordinate that keeps the true slope at m, with the height variation's own slope beside it
      const ml = Math.sqrt(Math.max(m * m - gH * gH, 0.04 * m * m)) / G;
      // the cap on height does not follow the local warp (no steps along a crest), except where the warp stretches past its
      // design and the slip face would not fit in a spacing (a step in the profile at the wrap)
      const Hl = Math.min(Hask, (L * m) / (3.4 * Gd), (L * ml) / 1.6);
      if (Hl <= 1e-4) return 0;
      const u = ((((s / L) % 1) + 1) % 1) * L;
      const Ll = Hl / ml, uc = L - Ll, Lw = Math.min(uc, (3.5 * Hl) / ml); // slip face, brink, windward length
      const lee = Hl * (1 - (u - uc) / Ll);
      const t = (u - (uc - Lw)) / Lw;
      const wind = t <= 0 ? 0 : t >= 1 ? Hl + ((0.6 * Hl) / Lw) * (u - uc) : Hl * (0.6 * t + 0.4 * t * t * (3 - 2 * t)); // gentle, convex near the brink (its tangent past it)
      return w > 0 ? Math.max(0, smin(wind, lee, w * ml)) : Math.max(0, Math.min(wind, lee)); // the brink rounded over the mesh's cell
    };
    const Gd = 1 + 0.45 * irr; // the warp's design stretch: crest height is planned for it
    eff = Math.min(H, (lam * m) / (3.4 * Gd));
    form = (x, z, w) => {
      const [a, c] = frame(x, z), A = amp(x, z), e = 2;
      const gA = H * Math.hypot(amp(x + e, z) - amp(x - e, z), amp(x, z + e) - amp(x, z - e)) / (2 * e);
      const h1 = family(x, z, a, c, lam, 0, H * A, gA, w);
      if (irr <= 0) return h1;
      // a second, closer-spaced crest family where a slow mask lets it: where the two meet, crests merge and split
      // (Y-junctions) instead of running as parallel stripes. The maximum of two capped surfaces stays capped.
      const K2 = (xx, zz) => irr * smooth(0.05, 0.45, N(xx / (4 * lam) + 0.21, 29, zz / (4 * lam) + 0.63));
      const k2 = K2(x, z);
      if (k2 <= 0.01) return h1;
      const g2 = H * Math.hypot(amp(x + e, z) * K2(x + e, z) - amp(x - e, z) * K2(x - e, z), amp(x, z + e) * K2(x, z + e) - amp(x, z - e) * K2(x, z - e)) / (2 * e);
      return Math.max(h1, family(x, z, a, c, lam * 0.78, 1, H * A * k2, g2, w));
    };
  } else if (type === 'linear') {
    // seif ridges: the crosswind coordinate warped by the downwind one (sinuous crests), symmetric flanks
    const warp = (a, c) => c + lam * irr * (0.5 * N(a / (4 * lam) + 0.5, 1, c / (3 * lam)) + 0.15 * N(a / (1.3 * lam), 3, c / (1.6 * lam) + 0.5));
    const Gd = 1 + 0.3 * irr;
    eff = Math.min(H, (0.42 * lam * m * 0.9) / Gd);
    form = (x, z, w) => {
      const [a, c] = frame(x, z), s = warp(a, c), e = 0.75;
      const G = Math.max(1, Math.hypot((warp(a + e, c) - warp(a - e, c)) / (2 * e), (warp(a, c + e) - warp(a, c - e)) / (2 * e)));
      const hv = (xx, zz) => { const [aa, cc] = frame(xx, zz); return H * amp(xx, zz) * (0.75 + 0.25 * N(aa / (3 * lam), 17, cc / lam)); }; // peaks and saddles
      const eh = 2, gH = Math.hypot(hv(x + eh, z) - hv(x - eh, z), hv(x, z + eh) - hv(x, z - eh)) / (2 * eh);
      const mf = (0.9 * Math.sqrt(Math.max(m * m - gH * gH, 0.04 * m * m))) / G, u = ((((s / lam) % 1) + 1) % 1) * lam;
      const Hl = Math.min(hv(x, z), (0.42 * lam * 0.9 * m) / Gd);
      if (Hl <= 1e-4) return 0;
      const crest = lam * (0.5 + 0.08 * irr * N(a / (2 * lam), 19, 0.5)); // the crest off-centre, as seif flanks alternate
      const Hf = Math.min(Hl, 0.97 * Math.min(crest, lam - crest) * mf); // both flanks inside the spacing (no step at the wrap)
      return Math.max(0, Hf - softAbs(u - crest, w) * mf);
    };
  } else if (type === 'barchan') {
    // crescents: an elliptical cone (rounded upwind nose, gentle windward side) whose apex sits half a windward length
    // downwind of the brink, cut on its downwind side by the slip face, a surface at the cap that rises upwind from the
    // brink curve u = bend Lc q^2 (its height falls with the true distance to that curve). The brink bends downwind towards the sides, so the cone's flanks run on past the slip
    // face as horns pointing downwind, round a lee bay. min(cone, slip face) stays under the cap.
    const Ca = lam, Cc = lam * 0.9, bend = 0.9, mw = 0.36 * m;
    const W0 = 0.42 * Cc; // crescent half-width in a full-size cell
    eff = Math.min(H, 0.35 * lam * mw);
    form = (x, z, w) => {
      const [a, c] = frame(x, z), ci = Math.floor(a / Ca), cj = Math.floor(c / Cc);
      let best = 0;
      for (let i = ci - 2; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        if (hash(i, j, sd, 3) > 0.85) continue; // an empty cell: the plain between barchans
        const jit = 0.15 + 0.6 * irr;
        const ca = (i + 0.3 + jit * (hash(i, j, sd, 1) - 0.5)) * Ca, cc = (j + 0.5 + (i & 1 ? 0.25 : -0.25) * (1 - irr) + jit * 0.6 * (hash(i, j, sd, 2) - 0.5)) * Cc;
        const k = 1 - 0.45 * irr * hash(i, j, sd, 4), W = W0 * Math.sqrt(k);
        const Hb = Math.min(H * k, 0.35 * lam * k * mw), Lu = Hb / mw, u0 = 0.5 * Lu, Hc = Hb + mw * u0, Lc = Hc / mw;
        let u = a - ca, v = c - cc;
        if (Math.abs(v) > W + 1 || u < -Lu - 1 || u > u0 + Lc + 1) continue;
        v += irr * 0.08 * W * N(u / W, 23 + (i & 7), v / W); // a little asymmetry between the horns
        const cone = Hc - mw * Math.hypot(u - u0, (v * Lc) / W);
        if (cone <= best) continue;
        // signed distance to the brink parabola u = b v^2, positive upwind: its gradient is a unit vector
        const bq = (bend * Lc) / (W * W);
        const dist = parabolaDistance(bq, u, v), sdist = u > bq * v * v ? -dist : dist;
        const h = smin(cone, Hb + 0.9 * m * sdist, w * m);
        if (h > best) best = h;
      }
      return best;
    };
  } else { // star
    const C = lam, wig = irr * 0.1 * 1.5 * Math.PI; // the arms' sinuous offset steepens their flanks by up to `wig`
    const side = (0.75 * m) / (1 + wig), dropK = 0.5; // flank slope; the crest falls by dropK x m along an arm
    eff = Math.min(H, (dropK * m * 0.42 * C) / 0.55);
    form = (x, z, w) => {
      const ci = Math.floor(x / C), cj = Math.floor(z / C);
      let best = 0;
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        const cx = (i + 0.25 + 0.5 * hash(i, j, sd, 1)) * C, cz = (j + 0.25 + 0.5 * hash(i, j, sd, 2)) * C;
        const dx = x - cx, dz = z - cz, r = Math.hypot(dx, dz);
        const k = 1 - 0.45 * irr * hash(i, j, sd, 4), Ra = 0.42 * C * k;
        const Hs = Math.min(H * k, (dropK * m * Ra) / 0.55), drop = (0.55 * Hs) / Ra, Hend = Hs - drop * Ra;
        if (r > Ra + Hs / side + 2 * w + 1) continue;
        const na = 3 + Math.floor(hash(i, j, sd, 5) * 3), th0 = th + hash(i, j, sd, 6) * TAU;
        let h = Hs - (Math.hypot(r, w) - w) * side; // the peak
        for (let n = 0; n < na; n++) {
          const ang = th0 + (n * TAU) / na + irr * (hash(i, j, sd, 10 + n) - 0.5) * 0.8, ux = Math.cos(ang), uz = Math.sin(ang);
          const t = dx * ux + dz * uz, tt = Math.min(Math.max(t, 0), Ra); // every arm counts everywhere (behind the peak it is the peak), so the smooth maximum has no steps
          const d = -dx * uz + dz * ux - irr * 0.1 * Ra * Math.sin((tt / Ra) * Math.PI * 1.5 + n * 2.1) * Math.min(1, tt / (0.3 * Ra)); // sinuous arm
          const ha = t <= 0 ? Hs - side * (Math.hypot(t, d, w) - w) : t <= Ra ? Hs - drop * t - softAbs(d, w) * side : Hend - side * (Math.hypot(t - Ra, d, w) - w); // the arm, then its rounded end
          h = -smin(-h, -ha, w * side); // arms joined without creases finer than the mesh
        }
        h = Math.min(h, Hs); // each smooth join lifts by up to a quarter of its width: never past the dune's own peak (review 22b)
        if (h > best) best = h;
      }
      return best;
    };
  }
  return {
    type, effectiveHeight: eff, maxHeight: H > 0 ? eff + H * 0.12 : 0, opts: { type, height: H, spacing: lam, windAngle: +windAngle || 0, irregularity: irr, seed: sd, maxSlope: +maxSlope },
    height: H > 0 ? (x, z, w = 0) => Math.max(0, form(x, z, w)) + swell(x, z) : () => 0,
  };
}
