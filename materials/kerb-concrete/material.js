// kerb-concrete: the precast concrete kerbstone (slot `stone` of kerbs). r187 example: webgpu_generator_city
// (SidewalkGenerator createCurbMaterial: segment joints along the kerb as an antialiased grid line, a fine grain as
// bumpNormal relief, the road face grimier than the top). Boulevard City's kerbMaterial (Kr4T/3DPLAT round2/boulevard
// 3352816, apps/boulevard-city-3d/kerbs.js), unchanged but for two inputs: the metres along the kerb come from the swept
// geometry's u (builder/sculpt/kerbs.js: uv.x is metres along the path) instead of positionLocal.x x the instanced run
// length aRun, and the stone colours from `colour` (default 0xb9b4a8, Boulevard's light tone; the dark tone keeps
// Boulevard's ratio 0x9c978b / 0xb9b4a8, channel by channel in linear light). Joints every KERB.stone = 1 m.
import { bumpNormal } from 'three/addons/generators/city/CityGeneratorUtils.js';

const LIGHT = 0xb9b4a8, DARK = 0x9c978b, STONE = 1.0; // kerbs.js kerbMaterial, KERB.stone

export function create(params, { THREE, TSL }) {
  const { uv, color, float, mix, smoothstep, fract, fwidth, mx_noise_float, positionWorld, normalWorldGeometry, cameraPosition, vec3 } = TSL;
  // an antialiased line repeated every `period` (the r187 SidewalkGenerator gridLine, as kerbs.js)
  const gridLine = (coord, period, halfWidth) => {
    const g = coord.div(period), d = float(0.5).sub(fract(g).sub(0.5).abs()), aa = fwidth(g).max(0.0001), hw = halfWidth / period;
    return smoothstep(float(hw).add(aa), float(hw).sub(aa), d);
  };
  const l = new THREE.Color(LIGHT), d = new THREE.Color(DARK), ratio = vec3(d.r / l.r, d.g / l.g, d.b / l.b);
  const light = params.colour?.isNode ? params.colour : color(params.colour);
  const p = positionWorld, detail = smoothstep(200, 18, p.distance(cameraPosition));
  const along = uv().x; // metres along the kerb
  const tone = mx_noise_float(p.mul(0.6)).mul(0.5).add(0.5);
  const stone = mix(light.mul(ratio), light, tone).add(mx_noise_float(p.mul(16)).mul(0.04).mul(detail));
  const joints = gridLine(along, STONE, 0.006).mul(detail);
  const top = smoothstep(0.5, 0.85, normalWorldGeometry.y); // 1 on the top, 0 on the road face
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'kerb-concrete';
  m.colorNode = mix(stone.mul(0.72), stone, top).mul(joints.mul(0.45).oneMinus()); // tyre grime on the road face
  m.roughnessNode = float(0.82).add(tone.mul(0.08));
  m.normalNode = bumpNormal(mx_noise_float(p.mul(5)).mul(0.0015).mul(detail).sub(joints.mul(0.004)));
  return m;
}
