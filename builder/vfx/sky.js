// Clouds, night gradient and stars over the sky (Kereem: "the clouds were amazing").
// Copied from Kr4T/3DPLAT round2/boulevard 3352816 apps/boulevard-city-3d/vfx/sky-dome.js (PROVENANCE.md); built over
// the r187 webgpu_sky SkyMesh cube. Changed for the builder: the cloud cover is a uniform (ctx.uClouds, from
// Environment.clouds) instead of the page's ?cloud flag, and the result carries the vfx tag in userData form.
// These nodes are composed into scene.backgroundNode by builder/environment.js, over the atmosphere sky, with ctx.dir the
// view direction (positionWorldDirection on the background): one draw, no dome mesh.
// Effect module (builder/vfx/): sky and light effects may build their own shapes; props may not.
import * as THREE from 'three/webgpu';
import { vec2, vec3, float, mix, smoothstep, step, floor, hash, sin, time, mx_fractal_noise_float } from 'three/tsl';

export function makeSkyDome(ctx) {
  const { uSunDir, uGold, uDay, uClouds, preset } = ctx, uCloudLight = ctx.uCloudLight ?? float(1);
  const d = ctx.dir.normalize(), up = d.y.max(0.0);
  const flat = d.xz.div(up.mul(0.75).add(0.06)); // project onto a cloud deck; low sky stretches out toward the horizon
  const wind = time.mul(0.006);
  const oct = preset === 'phone' ? 3 : 5;
  const n = mx_fractal_noise_float(vec3(flat.mul(0.9).add(vec2(wind, wind.mul(0.4))), time.mul(0.004)), oct, 2.1, 0.5).mul(0.5).add(0.5);
  const big = mx_fractal_noise_float(vec3(flat.mul(0.22), 3.1), 2, 2.0, 0.5).mul(0.5).add(0.5); // banks and gaps
  const cover = uClouds.add(big.sub(0.5).mul(0.7));
  const dens = smoothstep(cover.oneMinus(), cover.oneMinus().add(0.22), n).mul(step(0.001, uClouds)); // clouds 0: a clear sky
  const horizon = smoothstep(0.0, 0.08, d.y);
  const cA = dens.mul(horizon).mul(0.92);
  // light: sun colour on the sunward side, the sky's blue in the shade; gold and pink at dusk; moonlight at night
  const toward = d.dot(uSunDir).mul(0.5).add(0.5), silver = toward.pow(10).mul(dens.mul(dens.oneMinus()).mul(4));
  const shade = mix(float(0.55), float(1.0), n.sub(cover.oneMinus()).mul(3).clamp(0, 1).oneMinus());
  const dayCol = mix(vec3(0.62, 0.68, 0.78), vec3(1.0, 0.98, 0.95), shade.mul(toward.mul(0.6).add(0.4)));
  const duskCol = mix(vec3(0.42, 0.32, 0.45), mix(vec3(1.0, 0.52, 0.48), vec3(1.0, 0.72, 0.42), toward), toward.mul(0.7).add(0.3));
  const nightCol = vec3(0.05, 0.06, 0.085).mul(shade);
  // uCloudLight (environment rig): the sunlit and dusk colours scale with the sky's own light (builder/environment.js
  // cloudLight, from the sky meter), so clouds do not glow white over a twilight sky the atmosphere has already dimmed
  const lit = mix(mix(nightCol, duskCol.mul(uCloudLight), smoothstep(0.0, 0.35, uDay)), dayCol.mul(uCloudLight), smoothstep(0.35, 1.0, uDay).mul(uGold.oneMinus()));
  const cloudCol = lit.add(silver.mul(vec3(1.0, 0.85, 0.6)).mul(uDay.mul(0.8)).mul(uCloudLight));
  // stars: a hashed point field on the direction, twinkling; builder/environment.js adds them to the atmosphere, gated by
  // the sky's own brightness (environment rig, 11 Nov: the night gradient that was mixed over the sky here by the night
  // term is now the atmosphere's night floor, builder/atmosphere.js nightFloor)
  const cell = floor(d.mul(420)), star = step(0.9965, hash(cell.x.add(cell.y.mul(733)).add(cell.z.mul(1597))));
  const twinkle = sin(time.mul(2.0).add(hash(cell.x.mul(3).add(cell.z)).mul(40))).mul(0.3).add(0.7);
  const stars = vec3(0.9, 0.93, 1.0).mul(star.mul(twinkle).mul(1.6));
  return { colorNode: cloudCol, opacityNode: cA, starsNode: stars, userData: { vfx: { module: 'sky-clouds-stars' } } };
}

/** The sky as a box for the PMREM bake (builder/environment.js: the environment light is the same sky without its sun
 * disc): a back-faced unit box, 50 m, inside the bake's 0.1-100 m range; not part of the stage's scene. */
export function makeSkyBox(colorNode) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false }); mat.colorNode = colorNode;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); box.scale.setScalar(50); box.userData.vfx = { module: 'sky-box' };
  box.userData.dispose = () => { box.geometry.dispose(); mat.dispose(); };
  return box;
}
