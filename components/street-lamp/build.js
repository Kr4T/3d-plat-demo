// street-lamp build module. r187 examples: webgpu_generator_city (StreetlightGenerator, unchanged, called as Boulevard
// City's main.js calls it: new StreetlightGenerator({ height: SL_H, reach: SL_REACH, radius: 0.08 })) and
// webgpu_lights_physical (one PointLight in physical units: lumens, decay 2). Its two material zones (partId METAL 0,
// LENS 1) become the slots `metal` (lamp-metal) and `bulb` (bulb-glass); the light names `bulb`, so its glow follows the
// lumens. The light stands where main.js puts it: SL_H - 0.1 up, SL_REACH out along the arm (+Z).
// The light ends at Boulevard's 24 m (main.js PointLight distance). Shadows are data: component.json `draw`.
// Contract: build(params, ctx) -> { object, lights, collider } (lib/runtime/scene-view.mjs).
import { StreetlightGenerator } from 'three/addons/generators/city/StreetlightGenerator.js';
import { zoneOf } from '../../lib/generators/parts.mjs';

const METAL = 0, LENS = 1; // StreetlightGenerator's material zones
const RANGE = 24; // metres: Boulevard's lamp PointLight distance (main.js 1052)

export function build(params, ctx) {
  const { THREE } = ctx;
  const gen = new StreetlightGenerator({ height: params.height, reach: params.reach, radius: params.radius });
  gen.build([new THREE.Matrix4()]); // one lamp at the origin: stands on y = 0, the arm reaches toward +Z
  const object = new THREE.Group(); object.name = 'street-lamp';
  for (const [zone, slot] of [[METAL, 'metal'], [LENS, 'bulb']]) {
    const mesh = new THREE.Mesh(zoneOf(THREE, gen.geometry, zone), ctx.slot(slot));
    mesh.name = `street-lamp ${slot}`;
    object.add(mesh);
  }
  gen.dispose();
  const h = params.height, reach = params.reach;
  return {
    object,
    lights: [{ id: 'head', type: 'point', pos: [0, +(h - 0.1).toFixed(4), reach], kelvin: params.kelvin, lumens: params.lumens, range: RANGE, shadow: 'off', rays: !!params.rays, bulb: 'bulb' }],
    collider: [{ type: 'cylinder', pos: [0, h / 2, 0], radius: 0.22, halfHeight: h / 2 }],
  };
}
