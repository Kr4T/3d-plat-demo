// ssr-weight.js: one helper shared by the Boulevard world's materials (re-exported by water-ssr.js; kept apart so a
// material that does not move does not import the TSL clock). r187 examples: webgpu_postprocessing_ssr (SSRNode reads the
// scene pass's `metalrough` MRT: its first-generation trace weights each pixel's reflection by that metalness value) and
// webgpu_postprocessing_bloom_selective (a per-material `mrtNode` overriding one MRT output).
// ssrWeight(material, weightNode, roughnessNode): the material writes metalrough = (weight, roughness), so SSR reflects it
// by `weight` while its own shading keeps its real metalness. Only for a scene pass with a `metalrough` MRT output (High
// WebGPU): with no MRT on the pass, three.js would write only this output and the beauty would be lost.
import { mrt, vec2 } from 'three/tsl';

export function ssrWeight(material, weightNode, roughnessNode) {
  material.mrtNode = mrt({ metalrough: vec2(weightNode, roughnessNode) });
  return material;
}
