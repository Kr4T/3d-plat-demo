// palm-frond: the date palm's fronds (slot `frond`) and its far impostor card (slot `card`, part: card) of date-palm.
// r187 example: webgpu_loader_gltf (node materials on a glTF model). The look is Boulevard City's palm.js (the leaf branch
// of `full`, and `card`), kept in components/date-palm/look.js (palmLook).
import { palmLook } from '../../components/date-palm/look.js';

export function create(params, ctx) {
  return palmLook({ part: params.part === 'card' ? 'card' : 'frond', preset: ctx.preset, lod: ctx.lod ?? 'lod0', lean: params.lean, wind: params.wind, frondTint: params.frondTint, environment: ctx.environment, temporalAA: ctx.preset === 'high' && !!ctx.isWebGPU });
}
