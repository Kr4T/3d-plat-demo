// desert-sand: the sand surface (slot `surface` of desert-sand). r187 examples: webgpu_tsl_procedural_terrain,
// webgpu_parallax_uv and webgpu_generator_city, through shared/materials/boulevard-ground.js (createGroundMaterial), which
// holds the whole look so other pages that draw the Boulevard world share it. This file only maps the builder's ctx onto that
// API: the preset (phone or high), the stage's environment uniforms, the WebGL lamp map, the wet band from the piece's
// `shoreDist` attribute (builder/sculpt/sand.js writes it), and the SSR weight on High WebGPU (where the scene pass has
// the metal/rough MRT, builder/stage.js).
import { createGroundMaterial } from '../../shared/materials/boulevard-ground.js';

export function create(params, ctx) {
  return createGroundMaterial({
    quality: ctx.preset === 'phone' ? 'phone' : 'high', environment: ctx.environment, lampMap: ctx.lampMap,
    wetEdge: { attribute: 'shoreDist', width: params.wetWidth ?? 3 }, tint: params.tint, windAngle: params.windAngle,
    ripples: params.ripples, sparkle: params.sparkle, ssrMRT: ctx.preset !== 'phone' && !!ctx.isWebGPU,
  });
}
