// rng.mjs: the director's seeded random numbers. mulberry32 is Tommy Ettinger's public-domain 32-bit generator (the
// same one builder/hud-logic.js uses for Shuffle); lib/ does not import from builder/, so it is written out here.
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
/** An integer in lo..hi, both included. */
export const int = (rng, lo, hi) => lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1)));
export const chance = (rng, p) => rng() < p;
