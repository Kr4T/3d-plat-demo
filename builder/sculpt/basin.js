// basin.js: the fountain's stone basin (sculpt module). r187 example: webgpu_generator_city (SidewalkGenerator
// curbGeometry: a kerb profile carried round an outline). Boulevard City has no basin (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/main.js: the spray stands on the plaza paving), so this one is ours, built only from Boulevard's
// own pieces: its kerbstone profile (kerbs.js, through ./kerbs.js kerbGeometry: 30 cm wide, the rounded arris outward, 1 m
// stones) swept round a circle as the basin wall, and its water (buildWater's flat surface, through ./outline.js flatArea:
// uv = x, -z in metres, the `water` preset) inside. The circle is wide enough for the widest set piece of the show (the
// wide fans land about 8.6 m out) and the fire ring (6.5 m). Phone: the kerb module's Phone cut (two flat faces).
// The jet lights stand at the ring of jets (main.js spray: 2.6 m out), just above the water.
// Used by builder/vfx/fountain.js (the fountain component) and by its reference adapter (the basin is ours in both).
import { kerbGeometry } from './kerbs.js';
import { flatArea } from './outline.js';

export const MODULE = 'builder/sculpt/basin.js';
/** Metres: outer radius of the wall's centre line, wall height and width (kerbs.js KERB.width), water line, circle points. */
export const BASIN = Object.freeze({ radius: 9.5, wall: 0.45, width: 0.3, water: 0.3, points: 64 });
/** The jet lights (webgpu_lights_physical units): at the ring of jets, just above the water. Their baked range on ?webgl
 * (lib/runtime/lights.mjs rangeOf: 120 lm -> 9.5 cd -> 6.2 m) stays inside the water. */
export const JET_LIGHTS = Object.freeze({ count: 8, ring: 2.6, y: BASIN.water + 0.2, lumens: 120, kelvin: 6500, range: 4 });

/** A circle [[x, z], ...] running x toward z (positive signed area), closed (first point repeated) when `closed`. */
export function circle(r, n = BASIN.points, closed = false) {
  const pts = Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [+(Math.cos(a) * r).toFixed(5), +(Math.sin(a) * r).toFixed(5)]; });
  return closed ? [...pts, pts[0]] : pts;
}

/** The basin wall: Boulevard's kerbstone profile swept round the circle (its rounded face outward), tagged userData.sculpt. */
export function wallGeometry(THREE, preset = 'high') {
  const g = kerbGeometry(THREE, circle(BASIN.radius, BASIN.points, true), { preset, height: BASIN.wall });
  g.userData.sculpt = { module: MODULE, from: 'builder/sculpt/kerbs.js kerbGeometry' };
  delete g.userData.area; // a prop's wall, not an area surface
  return g;
}

/** The water inside the wall (up to its inner face), flat at the water line, tagged userData.sculpt. */
export function waterGeometry(THREE) {
  const g = flatArea(THREE, circle(BASIN.radius - BASIN.width / 2), BASIN.water, MODULE);
  delete g.userData.area;
  return g;
}

/** The jet lights, in the piece's frame. */
export function jetLights() {
  const L = JET_LIGHTS;
  return Array.from({ length: L.count }, (_, i) => {
    const a = (i / L.count) * Math.PI * 2;
    return { id: `jet-${i}`, type: 'point', pos: [+(Math.cos(a) * L.ring).toFixed(4), L.y, +(Math.sin(a) * L.ring).toFixed(4)], kelvin: L.kelvin, lumens: L.lumens, range: L.range, shadow: 'off', rays: false };
  });
}

/** The basin as one group: the wall (slot `stone`) and the water (slot `water`). */
export function basin(THREE, { preset = 'high', stone, water }) {
  const group = new THREE.Group(); group.name = 'fountain basin';
  const wall = new THREE.Mesh(wallGeometry(THREE, preset), stone); wall.name = 'basin wall'; wall.receiveShadow = true;
  const pool = new THREE.Mesh(waterGeometry(THREE), water); pool.name = 'basin water'; pool.receiveShadow = true;
  for (const m of [wall, pool]) m.userData.sculpt = { module: MODULE };
  group.add(wall, pool);
  return group;
}

/** The basin's collider: a drum as wide and high as the wall (people walk round it, not through it). */
export const collider = () => [{ type: 'cylinder', pos: [0, BASIN.wall / 2, 0], radius: BASIN.radius + BASIN.width / 2, halfHeight: BASIN.wall / 2 }];
