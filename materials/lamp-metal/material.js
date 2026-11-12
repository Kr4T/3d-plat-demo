// lamp-metal: the street lamp's mast, arm and luminaire housing (slot `metal` of street-lamp). r187 example:
// webgpu_generator_city (StreetlightGenerator's createStreetlightMaterial, METAL branch: dark olive-grey metal), with its
// colour, roughness and metalness as parameters. The generator's lens branch is the bulb-glass preset.
export function create(params, { THREE, TSL }) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.colorNode = TSL.color(params.colour);
  m.roughnessNode = TSL.float(params.roughness);
  m.metalnessNode = TSL.float(params.metalness);
  m.emissiveNode = TSL.color(0x000000);
  m.name = 'lamp-metal';
  return m;
}
