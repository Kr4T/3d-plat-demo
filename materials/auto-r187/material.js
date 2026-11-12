// auto-r187: the material of an imported model's slot (tools/import-model.mjs). It runs the characters worker's automatic
// r187 recipe (shared/auto-materials/auto-materials.js autoMaterial, copied unchanged from Kr4T/3DPLAT
// claude/music-video-characters f38aa14a) on the glTF material the file carries, handed over by the runtime as ctx.source
// (lib/runtime/materials.mjs). The recipe reads the material's own maps, never what the asset is: subsurface scattering on
// skin texels (r187 webgpu_materials_sss), sheen on matte cloth (webgpu_loader_gltf_sheen), specular anti-aliasing on metal,
// a dark-fibre response on hair, with the cloth roughness floor and specular cut. `tint` multiplies the colour; it arrives
// as '#rrggbb' or, when instances differ, as a per-instance vec3 attribute node. `glow` adds a soft emissive rim (below).
import { autoMaterial } from '../../shared/auto-materials/auto-materials.js';

export function create(params, { THREE, TSL, preset, source, body }) {
  const src = source && source.isMaterial ? source : new THREE.MeshStandardMaterial({ name: 'auto', roughness: 0.8, metalness: 0 });
  const { material: m, recipe, stats } = autoMaterial(src, { quality: preset === 'phone' ? 'phone' : 'high', body });
  const tint = typeof params.tint === 'string' ? TSL.color(params.tint) : params.tint;
  if (tint) m.colorNode = m.colorNode.mul(tint);
  // glow (0..1; a number, or a per-instance float node when instances differ): the surface gives off some of its own colour,
  // more where it turns away from the eye (a soft rim; the fresnel term of r187 webgpu_materials' rim examples). 0 adds nothing.
  const glow = typeof params.glow === 'number' ? (params.glow > 0 ? TSL.float(params.glow) : null) : params.glow || null;
  if (glow) {
    const rim = TSL.float(1).sub(TSL.normalView.dot(TSL.positionViewDirection).saturate()).pow(2.5);
    const own = TSL.vec3(m.colorNode).mul(glow).mul(TSL.float(0.3).add(rim.mul(1.1)));
    m.emissiveNode = m.emissiveNode ? TSL.vec3(m.emissiveNode).add(own) : own;
    m.userData.glow = true;
  }
  m.userData.recipe = recipe; m.userData.share = stats.share;
  m.name = src.name || 'auto-r187';
  return m;
}
