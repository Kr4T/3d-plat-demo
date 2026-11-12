// talk-node.mjs: the shader path of the Talk behaviour (12 Nov 2026): a talking piece with no rig (the HY 3D imports are
// static meshes) nods its head and sways its upper body in the vertex stage, driven by the line's amplitude and masked by
// height, on the GPU (Kereem: "use GPU"), so no rig is needed and no draw is added.
// r187 examples: webgpu_instance_uniform and webgl_instancing_scatter (a per-instance value beside the instance matrix, here
// the InstancedBufferAttribute `inst_talk`), webgpu_skinning / the threejs-animation skill's "WebGPU and TSL" section
// (displacement built on positionLocal, so instancing, morphs and skinning are applied before it), and the TSL `time` node.
// inst_talk = (amplitude 0..1, cos yaw, sin yaw, scale) per instance; zero for every piece that is not talking, so the
// offset is zero there. The rotation is worked out in the model's own frame (positionGeometry: base at y = minY, height H,
// facing +z, as tools/import-model.mjs leaves it), then turned and scaled into the instance frame with the instance's yaw and
// scale and added to positionLocal (which already carries the instance matrix: NodeMaterial.setupPosition).
// Normals are left as they are: the angles are a few degrees. Raycasting sees the rest pose (threejs-interaction: picking
// never sees positionNode displacement), which is what a tap should hit.

export const TALK_ATTRIBUTE = 'inst_talk';
/** At amplitude 1: the head's nod (radians, about the neck) and the upper body's sway (about the waist). Subtle. */
export const NOD = 0.12, SWAY = 0.035;

/** The position node of a talk-capable material: positionLocal (or `base`) plus the talk offset. */
export function talkPositionNode(TSL, { minY = 0, height = 1, base = null } = {}) {
  const { attribute, positionGeometry, positionLocal, vec3, float, smoothstep, sin, cos, time } = TSL;
  const inst = attribute(TALK_ATTRIBUTE, 'vec4');
  const amp = inst.x, cy = inst.y, sy = inst.z, sc = inst.w;
  const H = float(Math.max(height, 1e-3)), y0 = float(minY);
  const p = positionGeometry, h = p.y.sub(y0).div(H); // 0 at the feet, 1 at the top of the head
  // the head nods about the neck (0.82 H), a quick speaking bob on top of a steady lean with the voice
  const nod = amp.mul(NOD).mul(sin(time.mul(7.0)).mul(0.35).add(0.65));
  const neckY = y0.add(H.mul(0.82)), oy = p.y.sub(neckY), oz = p.z;
  const cn = cos(nod), sn = sin(nod);
  const dNod = vec3(0, oy.mul(cn).sub(oz.mul(sn)).sub(oy), oy.mul(sn).add(oz.mul(cn)).sub(oz)).mul(smoothstep(0.74, 0.9, h));
  // the upper body sways side to side about the waist (0.5 H), slowly
  const sway = amp.mul(SWAY).mul(sin(time.mul(2.3)));
  const waistY = y0.add(H.mul(0.5)), wy = p.y.sub(waistY), wx = p.x;
  const cs = cos(sway), ss = sin(sway);
  const dSway = vec3(wx.mul(cs).sub(wy.mul(ss)).sub(wx), wx.mul(ss).add(wy.mul(cs)).sub(wy), 0).mul(smoothstep(0.5, 0.85, h));
  const d = dNod.add(dSway);
  // model frame -> instance frame: Ry(yaw) (x' = c x + s z, z' = -s x + c z), then the instance's scale
  const dInst = vec3(cy.mul(d.x).add(sy.mul(d.z)), d.y, sy.negate().mul(d.x).add(cy.mul(d.z))).mul(sc);
  return (base || positionLocal).add(dInst);
}
