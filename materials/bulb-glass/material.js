// bulb-glass: the street lamp's lens (slot `bulb` of street-lamp, the light's `bulb`). r187 examples:
// webgpu_generator_city (StreetlightGenerator's createStreetlightMaterial, LENS branch: a warm lens glowing at 0xffe2a6 x 60)
// and webgpu_lights_physical (the bulb glows with the light's luminous power: the bulb mesh's emissive follows the
// light). The glow scales with `lumens`: at `refLumens` (Boulevard's lamp, 60 cd = 754 lm) it is the generator's x 60, at
// twice the lumens twice that. `lumens` is a number, or a per-instance float attribute node when lamps differ
// (lib/runtime/scene-view.mjs splitParams: lamps at different lumens share one draw). Boulevard City (main.js lampHead)
// dims the lens by day: x (night x 0.97 + 0.03), read here from the stage's environment uniform `night` (none: night, as
// on the component bench).
export function create(params, { THREE, TSL, environment = null }) {
  const { color, float } = TSL;
  const m = new THREE.MeshStandardNodeMaterial();
  const perLumen = params.glowStrength / params.refLumens;
  const lumens = typeof params.lumens === 'number' ? float(Math.max(0, params.lumens)) : params.lumens.max(0);
  const night = environment?.night ?? float(1);
  m.colorNode = color(params.lens);
  m.roughnessNode = float(0.3);
  m.metalnessNode = float(0);
  // the glow follows the lumens up to 4 x the generator's own (x 240): past that a lens is white to the eye and to the tone
  // mapping alike, and an unbounded value only feeds the bloom (12 Nov 2026: 16,000 lm lamps gave x 1,273)
  m.emissiveNode = color(params.glow).mul(lumens.mul(perLumen).min(params.glowStrength * 4)).mul(night.mul(0.97).add(0.03));
  // the glow's scale (x the glow colour), for tests and the inspector: a number, or null when it varies per instance
  m.userData.bulbIntensity = typeof params.lumens === 'number' ? Math.min(params.glowStrength * 4, perLumen * Math.max(0, params.lumens)) : null;
  m.name = 'bulb-glass';
  return m;
}
