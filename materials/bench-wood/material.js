// bench-wood: the bench's timber slats (slot `wood` of bench). r187 example: webgpu_generator_city (BenchGenerator's
// createBenchMaterial, WOOD branch, unchanged in its nodes: grain stretched along the slats, a tone per board, greyed by
// weathering). `woodTone` multiplies the timber colour (white: the generator's own); it arrives as '#rrggbb' or as a
// per-instance vec3 attribute node when benches differ (lib/runtime/materials.mjs).
export function create(params, { THREE, TSL }) {
  const { color, floor, fract, mix, mx_fractal_noise_float, positionGeometry, sin, vec3 } = TSL;
  const p = positionGeometry;
  const grain = mx_fractal_noise_float(p.mul(vec3(3, 60, 60)), 2).mul(0.5).add(0.5);
  const board = fract(sin(floor(p.z.mul(10.5)).add(floor(p.y.mul(8.0)).mul(7.3)).mul(17.53)).mul(43758.5453));
  const weather = mx_fractal_noise_float(p.mul(1.6), 2).mul(0.5).add(0.5);
  const stained = mix(color(0x5e412a), color(0x8a6242), grain.mul(0.7).add(board.mul(0.3)));
  const wood = mix(stained, color(0x7c7468), weather.mul(0.45)); // sun-bleached grey where the stain has worn
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = wood.mul(color(params.woodTone));
  m.roughnessNode = grain.mul(0.25).add(0.65);
  m.metalnessNode = TSL.float(0);
  m.name = 'bench-wood';
  return m;
}
