// bench-metal: the bench's cast-iron end frames and armrests (slot `iron` of bench). r187 example:
// webgpu_generator_city (BenchGenerator's createBenchMaterial, IRON branch: dark cast iron), its values as parameters.
export function create(params, { THREE, TSL }) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = TSL.color(params.colour);
  m.roughnessNode = TSL.float(params.roughness);
  m.metalnessNode = TSL.float(params.metalness);
  m.name = 'bench-metal';
  return m;
}
