// bench build module. r187 example: webgpu_generator_city (BenchGenerator, unchanged, called as Boulevard City's
// main.js calls it: new BenchGenerator(), the r187 defaults; `length` is the generator's own parameter). Its two
// material zones (partId WOOD 0, IRON 1) become the slots `wood` (bench-wood) and `iron` (bench-metal).
// No shadow from the bench, as main.js (benches.castShadow = false): data, in component.json `draw`.
// Contract: build(params, ctx) -> { object, collider } (lib/runtime/scene-view.mjs).
import { BenchGenerator } from 'three/addons/generators/city/BenchGenerator.js';
import { zoneOf } from '../../lib/generators/parts.mjs';

const WOOD = 0, IRON = 1; // BenchGenerator's material zones

export function build(params, ctx) {
  const { THREE } = ctx;
  const gen = new BenchGenerator({ length: params.length });
  gen.build([new THREE.Matrix4()]); // one bench at the origin: runs along X, seats toward +Z
  const object = new THREE.Group(); object.name = 'bench';
  for (const [zone, slot] of [[WOOD, 'wood'], [IRON, 'iron']]) {
    const mesh = new THREE.Mesh(zoneOf(THREE, gen.geometry, zone), ctx.slot(slot));
    mesh.name = `bench ${slot}`;
    object.add(mesh);
  }
  gen.dispose();
  const L = params.length, { depth, seatHeight, backHeight } = BenchGenerator.defaults;
  return {
    object,
    collider: [
      { type: 'cuboid', pos: [0, seatHeight / 2, 0], half: [L / 2 - 0.04, seatHeight / 2, depth / 2] },
      { type: 'cuboid', pos: [0, (seatHeight + backHeight) / 2, -depth / 2 + 0.05], half: [L / 2 - 0.04, (backHeight - seatHeight) / 2, 0.05] },
    ],
  };
}
