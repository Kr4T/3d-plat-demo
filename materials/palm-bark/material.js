// palm-bark: the date palm's trunk (slot `trunk` of date-palm). r187 example: webgpu_loader_gltf (node materials on a
// glTF model). The look is Boulevard City's palm.js bark branch, kept in components/date-palm/look.js (palmLook).
import { palmLook } from '../../components/date-palm/look.js';

export function create(params, ctx) {
  return palmLook({ part: 'trunk', preset: ctx.preset, lod: ctx.lod ?? 'lod0', lean: params.lean, wind: params.wind, environment: ctx.environment, temporalAA: ctx.preset === 'high' && !!ctx.isWebGPU });
}
