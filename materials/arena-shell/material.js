// arena-shell: Boulevard City's Kingdom Arena look (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/arena.js
// arenaMaterials), as ONE material. r187 examples: webgpu_loader_gltf (a glTF's material replaced by a node material) and
// webgpu_clearcoat (the glazing's clearcoat, High only). The model (components/kingdom-arena/arena.glb, joined by
// tools/glb-join.mjs) bakes COLOR_0 = (AO, height / 47 m, panel random, part): part 0 cladding, 1/3 glazing, 2/3 roof,
// 1 raised roof. arena.js made one material per part (4 draws); here each term is picked per vertex by `part`, as
// Boulevard's palm.js branches on its baked kind, so the piece is one draw (the component gate's Phone budget is 2).
// The terms themselves are arena.js's, unchanged, but for: `cladding` (the panels' mean colour, arena.js's beige by
// default), `glow` (x the night emission), and the raised roof's sheen, which is left out. Night comes from the stage's
// environment uniform (none: day, as arena.js's default).
export function create(params, { THREE, TSL, preset, environment = null }) {
  const { attribute, float, vec3, mix, smoothstep, fract, uv, positionWorld, exp, max, abs, color } = TSL;
  const night = (environment?.night ?? float(0)).mul(params.glow);
  const c = attribute('color', 'vec4'), ao = c.x, h = c.y, rnd = c.z, part = c.w, q = uv(), y = positionWorld.y;
  const is = (k) => smoothstep(0.12, 0.08, abs(part.sub(k / 3))); // 1 on that part's vertices
  const isGlazing = is(1), isRoof = is(2), isRaised = is(3);
  const pick = (cl, gl, ro, ra) => mix(mix(mix(cl, gl, isGlazing), ro, isRoof), ra, isRaised);
  const line = (coord, period, half) => { const d = abs(fract(coord.div(period)).sub(0.5)).mul(-1).add(0.5); return smoothstep(half / period, 0, d); };

  const m = preset === 'high' ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  // cladding: beige Najdi-toned panels, each a slightly different tone, 1.5 m horizontal joints
  const joint = line(y, 1.5, 0.03), base = typeof params.cladding === 'string' ? color(params.cladding) : params.cladding;
  const beige = mix(base.mul(0.918), base.mul(1.082), rnd).mul(joint.mul(-0.3).add(1));
  // glazing: dark glass with mullions
  const mull = max(line(q.x.mul(4), 1.5, 0.05), line(q.y.mul(4), 2.75, 0.06));
  const glass = mix(vec3(0.018, 0.026, 0.032), vec3(0.08, 0.08, 0.08), mull);
  // roof: light standing-seam metal; raised roof: a white membrane in panels
  const seam = line(q.x.mul(20), 0.8, 0.04), panel = line(q.x.mul(16), 1, 0.02);
  m.colorNode = pick(beige, glass, vec3(0.52, 0.52, 0.5).mul(seam.mul(-0.25).add(1)), vec3(0.80, 0.80, 0.78).mul(panel.mul(-0.2).add(1)));
  m.roughnessNode = pick(float(0.72).add(joint.mul(0.15)), mix(float(0.05), float(0.4), mull), float(0.5), float(0.6));
  m.metalnessNode = pick(float(0), float(0.15), float(0.35), float(0));
  m.aoNode = ao;
  m.emissiveNode = pick(
    vec3(1.0, 0.72, 0.45).mul(night).mul(exp(y.mul(-1 / 9))).mul(0.10), // base wash at night
    vec3(1.0, 0.78, 0.5).mul(night).mul(mull.oneMinus()).mul(mix(float(0.35), float(0.22), smoothstep(0.2, 0.5, h))), // lit from inside
    vec3(0),
    vec3(1.0, 0.92, 0.8).mul(night).mul(0.05));
  if (m.isMeshPhysicalNodeMaterial) { m.clearcoatNode = isGlazing; m.clearcoatRoughnessNode = float(0.04); }
  m.name = 'arena-shell';
  return m;
}
