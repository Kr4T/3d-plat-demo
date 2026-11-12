// The moon: a glowing sprite in the night sky, with its light set by builder/environment.js.
// Copied from Kr4T/3DPLAT round2/boulevard 3352816 apps/boulevard-city-3d/vfx/moon.js (PROVENANCE.md). Changed for the
// builder: the sprite is named 'moon' (the e2e finds it), and sp.userData.dispose() frees its texture and material.
// Effect module (builder/vfx/): sky and light effects may build their own shapes and effect textures; props may not.
import * as THREE from 'three/webgpu';
import { vec4, sin, add, texture } from 'three/tsl';

export function makeMoon(ctx) {
  const { scene, moonLight } = ctx;
  const az = (115 * Math.PI) / 180, el = (38 * Math.PI) / 180, dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,252,240,1)'); g.addColorStop(0.22, 'rgba(250,246,230,1)'); g.addColorStop(0.26, 'rgba(210,220,255,.35)'); g.addColorStop(1, 'rgba(160,180,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const mm = new THREE.SpriteNodeMaterial({ map: t, transparent: true, depthWrite: false, fog: false }); mm.colorNode = texture(t).mul(vec4(1.6, 1.6, 1.7, 1));
  const sp = new THREE.Sprite(mm); sp.scale.setScalar(620); sp.renderOrder = 0; sp.userData.dir = dir; sp.name = 'moon'; sp.userData.vfx = { module: 'moon' }; sp.visible = false; scene.add(sp);
  sp.userData.dispose = () => { scene.remove(sp); t.dispose(); mm.dispose(); };
  moonLight.position.copy(dir).multiplyScalar(1000);
  return sp;
}
