// ground-height.mjs: the height of the ground under particles, for a GPU compute pass to collide with. r187 example:
// webgpu_compute_particles_snow (an OrthographicCamera above the scene renders the colliders, on their own layer, with an
// override material whose colour is positionWorld.y into a half-float target; the compute pass samples it at each
// particle's xz). Here the colliders are the scene's area pieces (desert sand, paving, lake, kerbs: their InstancedMeshes
// are put on GROUND_LAYER by lib/runtime/scene-view.mjs), so the height is the top surface of whatever the scene stands on,
// with nothing per scene: dunes, a raised paving, a sunken lake all come out of the same pass.
//  - The pass draws only when it is asked to (update()) and something changed: the scene was synced (markDirty) or the
//    window moved to a new place. Steady frames draw nothing; a burst fired on a still scene costs one pass of the ground
//    draws (1-6) on the frame it is fired.
//  - The window is square, `size` metres, centred on the latest point asked for (snapped to size / 8, so a stream of bursts
//    near each other does not redraw), `res` texels across: Phone 128 m at 256 (0.5 m a texel), High 192 m at 512 (0.375 m).
//  - Encoding: red = height (m), green = 1 where a surface was drawn. The target is cleared to 0, so a texel with green 0 is
//    "no ground here" and the compute pass falls back to the particle's own ground (the height it was born at). No negative
//    clear colour is needed (WebGL clamps some), and nothing is drawn by hand: the heights are the scene's own geometry.
//  - Orientation: the camera looks down with up = -Z, so screen right is +X and the top of the image is -Z. In TSL a render
//    target's uv (0, 0) is the TOP-left of the rendered image on both backends (WebGPU's convention; r187 flips the uv for
//    render targets on the WebGL backend), so u = (x - x0) / size, v = (z - z0) / size (heightUV below). Measured, not
//    assumed: the target read back on both backends against a raycast of the sand (WebGPU stores the top row first, WebGL
//    the bottom row; sampled through TSL both read the same), and the e2e checks grains landed on a dune slope.
import { uniform, vec2, vec4, positionWorld, float } from 'three/tsl';

/** Pure, the same mapping as heightUV: the uv of world [x, z] in a window [x0, z0, 1 / size]. */
export const uvOf = ([x, z], [x0, z0, inv]) => [(x - x0) * inv, (z - z0) * inv];

/** The layer the ground pass sees (SHADOW_LAYER is 1 in scene-view.mjs). */
export const GROUND_LAYER = 2;
export const WINDOW = Object.freeze({ phone: { size: 128, res: 256 }, high: { size: 192, res: 512 } });

/** Pure: the window for a point, snapped to size / 8 (x0, z0 its -x, -z corner). */
export function windowFor([x, z], size) {
  const step = size / 8, cx = Math.round(x / step) * step, cz = Math.round(z / step) * step;
  return { x0: cx - size / 2, z0: cz - size / 2, size, cx, cz };
}

export function createGroundHeight({ THREE, renderer, scene, preset = 'high' }) {
  const { size, res } = WINDOW[preset === 'phone' ? 'phone' : 'high'];
  const canRender = !!(renderer && typeof renderer.render === 'function' && typeof renderer.setRenderTarget === 'function');
  const target = new THREE.RenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: true });
  target.texture.minFilter = THREE.NearestFilter; target.texture.magFilter = THREE.NearestFilter; target.texture.generateMipmaps = false;
  target.texture.name = 'ground height';
  const camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0.1, 4000);
  camera.up.set(0, 0, -1); camera.layers.set(GROUND_LAYER); camera.name = 'ground height';
  const material = new THREE.MeshBasicNodeMaterial(); material.name = 'ground height';
  material.colorNode = vec4(positionWorld.y, float(1), float(0), float(1));
  material.blending = THREE.NoBlending; material.fog = false; material.toneMapped = false; material.side = THREE.DoubleSide;
  // x0, z0, 1 / size, valid (0 until the first pass, and always 0 where nothing can render)
  const bounds = uniform(new THREE.Vector4(0, 0, 1 / size, 0));
  let dirty = true, win = null, passes = 0;
  const clear = new THREE.Color();
  return {
    target, texture: target.texture, camera, bounds, size, res, layer: GROUND_LAYER,
    get passes() { return passes; },
    /** The scene changed (a sync, a rebuilt terrain): the next update() redraws. */
    markDirty() { dirty = true; },
    /** Make sure the window holds [x, z]; draws the pass when it is stale. Returns true when it drew. */
    update([x, z]) {
      if (!canRender || !scene) return false;
      const w = windowFor([x, z], size);
      if (!dirty && win && w.cx === win.cx && w.cz === win.cz) return false;
      win = w; dirty = false;
      camera.position.set(w.cx, 2000, w.cz); camera.lookAt(w.cx, 0, w.cz); camera.updateMatrixWorld();
      const keep = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, background: scene.background, backgroundNode: scene.backgroundNode,
        environment: scene.environment, environmentNode: scene.environmentNode, fog: scene.fog, fogNode: scene.fogNode, alpha: renderer.getClearAlpha?.() ?? 1 };
      renderer.getClearColor?.(clear);
      scene.overrideMaterial = material; scene.background = null; scene.backgroundNode = null; scene.environment = null; scene.environmentNode = null; scene.fog = null; scene.fogNode = null;
      try {
        renderer.setRenderTarget(target);
        renderer.setClearColor?.(0x000000, 0); renderer.clear?.();
        renderer.render(scene, camera);
        passes++;
      } finally {
        Object.assign(scene, { overrideMaterial: keep.override, background: keep.background, backgroundNode: keep.backgroundNode, environment: keep.environment, environmentNode: keep.environmentNode, fog: keep.fog, fogNode: keep.fogNode });
        renderer.setRenderTarget(keep.target);
        renderer.setClearColor?.(clear, keep.alpha);
      }
      bounds.value.set(w.x0, w.z0, 1 / size, 1);
      return true;
    },
    /** TSL: the uv of a world xz in the target (see Orientation above). */
    heightUV(xz) { const b = bounds; return vec2(xz.x.sub(b.x).mul(b.z), xz.y.sub(b.y).mul(b.z)); },
    dispose() { target.dispose(); material.dispose(); },
  };
}
