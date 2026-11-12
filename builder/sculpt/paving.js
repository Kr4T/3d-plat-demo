// paving.js: the wet-paving area piece. r187 examples: webgpu_generator_city (SidewalkGenerator: a block outline triangulated
// into a flat walking surface, shaded by a world-space TSL material) and webgpu_postprocessing_ssr (a wet, reflective floor
// that the stage's SSR pass reads). The surface is Boulevard City's ground where its class is paving or plaza
// (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/main.js: `ground` at y = 0, `groundMaterial`): here the
// ground is the `outline` param instead of the whole map, and its look is the `wet-paving` material preset (slot
// `surface`). Rebuilt from the outline at each change (spec §14 item 6): flat, uv = (x, z) in metres, one socket
// `paving-edge` per outline edge, pointing out.
// Contract: build(params, ctx) -> { object, collider, sockets } (lib/runtime/scene-view.mjs); sockets(params).
import { edgeSockets, flatArea, boundsCollider, checkOutline } from './outline.js';

export const MODULE = 'builder/sculpt/paving.js';
/** components/sockets.json: what a paving edge accepts (tests/components-core2.test.mjs checks they agree). */
export const ACCEPTS = ['kerb-run', 'water-edge', 'lamp-base', 'seat-faces-edge', 'palm-pit'];

/** The paving's sockets (refused, as build() refuses, for a bad outline): one `paving-edge` per outline edge, at its midpoint, facing out of the paving. */
export function sockets(params) {
  return edgeSockets(checkOutline(params.outline, MODULE), { closed: true, type: 'paving-edge', accepts: ACCEPTS, snap: 0.5, y: 0, prefix: 'edge' });
}

export async function build(params, ctx) {
  const { THREE } = ctx;
  const material = ctx.slot('surface');
  // the preset's image files load before the piece is shown (Boulevard waits for its surfaces before the first frame)
  if (material.userData?.ready && typeof window !== 'undefined') await material.userData.ready;
  const mesh = new THREE.Mesh(flatArea(THREE, params.outline, 0, MODULE), material);
  mesh.name = 'wet-paving'; mesh.receiveShadow = true;
  mesh.userData.sculpt = { module: MODULE, from: 'outline' };
  return { object: mesh, collider: [boundsCollider(params.outline, -0.1, 0, { surface: 'paving' })], sockets: sockets(params) };
}
