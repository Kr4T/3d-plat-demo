// Automatic r187 material assignment, the pure part (no three.js): texel classes and the recipe for one glTF material,
// from its own PBR maps (base colour, metallic-roughness). A builder capability (coordinator, 11 Nov 2026: "load any GLB
// and apply r187 materials automatically"): it never asks what the asset is (person, alien, animal, prop), only what
// its texels are. auto-materials.js turns the recipe into node materials; the same classes run per texel there in TSL.
//
//   classifyTexel([r, g, b] sRGB 0..1, { metal, rough }) -> METAL | HAIR | SKIN | CLOTH | OTHER
//   materialStats(baseRGBA Uint8, mrRGBA Uint8 | null, factors) -> { count, share: {class: 0..1}, roughMean, metalMean }
//   chooseRecipe(stats) -> { name, sss, sheen, sheenRoughness, envIntensity, metalSpecAA }

export const SKIN = 'skin', CLOTH = 'cloth', METAL = 'metal', OTHER = 'other', HAIR = 'hair';

// Human skin of every tone sits in one narrow hue band (red-orange, about -5..45 degrees, i.e. 355-45 through red) at moderate saturation, from
// very light to very dark; the band is the same in TSL (auto-materials.js skinMask). Below lumMin a texel is dark fibre.
export const SKIN_RULE = { hueMin: -5, hueMax: 45, satMin: 0.15, satMax: 0.72, lumMin: 0.07, lumMax: 0.92 };
// Dark fibre (hair, beard, eyebrows, black fur; coordinator, 11 Nov 2026: "a hair/beard class: dark, rough, no sheen, no
// SSS"): near-black at any hue that is not strongly saturated. The darkest skin tones sit well above lumMax here.
export const HAIR_RULE = { lumMax: 0.07, satMax: 0.6 };
export const HAIR_ROUGH = 0.9;     // dark fibre: at least this rough
export const HAIR_SPEC = 0.25;     // and a quarter of the dielectric specular: a bundle of fibres shadows most of its own
                                   // reflection, it is not one polished surface (the fidelity guard: it stays dark)
export const SKIN_SPEC = 0.7;      // skin's own reflectance: IOR 1.4 gives F0 0.028 = 0.7 x the default 0.04
export const METAL_MIN = 0.5;      // metallic >= this: metal (glTF metalness is near 0 or 1 in practice)
export const METAL_MIN_LUM = 0.25; // and an albedo at least this bright (sRGB luminance): dark "metal" is leather (_project.py too)
// cloth is matte: its roughness never below CLOTH_MIN_ROUGH and a third of the dielectric specular (fibres scatter it;
// the sheen carries the grazing light). Pixal3D attempt 0 (11 Nov 2026): its shemagh map said roughness 0.66, and a full
// F0 0.04 lobe lifted the dark red check's sRGB luminance 0.06 -> 0.21 (a grey film); roughness 0.95 alone still +0.10
export const CLOTH_MIN_ROUGH = 0.85;
export const CLOTH_SPEC = 0.35;
export const CLOTH_ROUGH = 0.55;   // matte non-metal, non-skin: cloth (sheen)

export function hueSatLum([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: mx > 1e-6 ? d / mx : 0, l: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

export function isSkinColour(rgb) {
  const { h: h360, s, l } = hueSatLum(rgb), R = SKIN_RULE, h = h360 > 180 ? h360 - 360 : h360;   // signed: red is 0
  return h >= R.hueMin && h <= R.hueMax && s >= R.satMin && s <= R.satMax && l >= R.lumMin && l <= R.lumMax;
}

export function isHairColour(rgb) {
  const { s, l } = hueSatLum(rgb);
  return l < HAIR_RULE.lumMax && s <= HAIR_RULE.satMax;
}

export function classifyTexel(rgb, { metal = 0, rough = 0.8 } = {}) {
  if (metal >= METAL_MIN && hueSatLum(rgb).l >= METAL_MIN_LUM) return METAL;
  if (metal >= METAL_MIN) rough = Math.max(rough, 0.5);            // implausible metal: treated as a dielectric
  if (isHairColour(rgb)) return HAIR;
  if (isSkinColour(rgb)) return SKIN;
  if (rough >= CLOTH_ROUGH) return CLOTH;
  return OTHER;
}

/** Class shares of a material from its maps (RGBA bytes, e.g. a 64x64 canvas read-back). glTF packs roughness in G and
 *  metalness in B of the metallicRoughness map, multiplied by the factors (glTF default 1); without the map the factors
 *  alone count (default: a matte non-metal). Pass the material's own metalness and roughness as factors. */
export const SKIN_ROUGH = 0.45, DEFAULT_ROUGH = 0.8;  // per-class roughness when a roughness map is not trusted
// Per-class values used when the generator's roughness is not trusted (research PR #55 finding 2: skin about 0.4-0.5 with
// subsurface, cloth matte with sheen, leather / accessories with a low coat): roughness and clearcoat by texel class.
export const CLASS_ROUGH = { skin: SKIN_ROUGH, cloth: DEFAULT_ROUGH, hair: 0.9, other: 0.5, metal: 0.35 };
export const COAT = { skin: 0, cloth: 0, hair: 0, other: 0.25, metal: 0 };
export const COAT_ROUGH = 0.3;

/** Whether a metallicRoughness map carries information. Generated assets (TRELLIS.2, 11 Nov 2026) can come with a
 *  degenerate one: "metal" 0.6-0.87 on every texel of a person, roughness pinned at 1.0. A metal map that calls >= 90 %
 *  of the texels metal while the base colour holds skin-tone texels, or a roughness map that is flat at its maximum, is
 *  not trusted; colour classes and per-class defaults decide instead. Generic: it reads the maps, never the asset type. */
export function mapTrust(base, mr) {
  const out = { metal: true, rough: true, why: [] };
  if (!mr) return out;
  const n = Math.floor(base.length / 4); let metalN = 0, skinN = 0; const r = [];
  for (let i = 0; i < n; i++) {
    if (mr[4 * i + 2] / 255 >= METAL_MIN) metalN++;
    if (isSkinColour([base[4 * i] / 255, base[4 * i + 1] / 255, base[4 * i + 2] / 255])) skinN++;
    r.push(mr[4 * i + 1] / 255);
  }
  r.sort((x, y) => x - y);
  if (n && metalN / n >= 0.9 && skinN / n >= 0.03) { out.metal = false; out.why.push(`metal map calls ${Math.round(100 * metalN / n)} % metal on a material with ${Math.round(100 * skinN / n)} % skin-tone texels`); }
  const p5 = r[Math.floor(0.05 * (n - 1))], p95 = r[Math.floor(0.95 * (n - 1))];
  if (n && p5 >= 0.97) { out.rough = false; out.why.push('roughness map flat at its maximum'); }
  // matte everywhere with little spread (TRELLIS.2: 0.78-0.95): it says nothing about which parts shine
  else if (n && p5 >= 0.6 && p95 - p5 <= 0.25) { out.rough = false; out.why.push(`roughness map near-flat and matte (p5 ${p5.toFixed(2)}, p95 ${p95.toFixed(2)})`); }
  return out;
}

export function materialStats(base, mr, factors = mr ? { metal: 1, rough: 1 } : { metal: 0, rough: 0.8 }, trust = { metal: true, rough: true }) {
  const n = Math.floor(base.length / 4);
  const share = { [SKIN]: 0, [CLOTH]: 0, [METAL]: 0, [OTHER]: 0, [HAIR]: 0 };
  let rs = 0, ms = 0;
  for (let i = 0; i < n; i++) {
    const rgb = [base[4 * i] / 255, base[4 * i + 1] / 255, base[4 * i + 2] / 255];
    const metal = trust.metal ? (mr ? mr[4 * i + 2] / 255 : 1) * factors.metal : 0;
    const rough = trust.rough ? (mr ? mr[4 * i + 1] / 255 : 1) * factors.rough : (isSkinColour(rgb) ? SKIN_ROUGH : DEFAULT_ROUGH);
    share[classifyTexel(rgb, { metal, rough })] += 1; rs += rough; ms += metal;
  }
  for (const k in share) share[k] = n ? share[k] / n : 0;
  return { count: n, share, roughMean: n ? rs / n : factors.rough, metalMean: n ? ms / n : factors.metal };
}

/** The r187 recipe a material gets: SSS where it has skin texels, sheen where it has cloth, specular anti-aliasing where
 *  it has metal, a matte dark-fibre response where it has hair. The per-texel masks in auto-materials.js decide where
 *  each one acts inside the material. */
export function chooseRecipe(st, { body = null } = {}) {
  // quick-fix 12 Nov 2026 (3dplat-builder, not in the source at f38aa14a): skin-tone texels of an animal or an object are fur,
  // leather or wood, not skin, so the component's `body` (set at import) switches subsurface scattering off unless it is humanoid
  const sss = st.share[SKIN] >= 0.03 && (!body || body === 'humanoid'), cloth = st.share[CLOTH] >= 0.05, metal = st.share[METAL] >= 0.05, hair = (st.share[HAIR] || 0) >= 0.005;
  return {
    name: [sss && 'skin-sss', cloth && 'cloth-sheen', metal && 'metal', hair && 'hair', !(sss || cloth || metal || hair) && 'pbr'].filter(Boolean).join('+'),
    sss, sheen: cloth ? 0.35 : 0, sheenRoughness: 0.8, envIntensity: metal ? 1.0 : 0.8, metalSpecAA: metal, hair,
  };
}
