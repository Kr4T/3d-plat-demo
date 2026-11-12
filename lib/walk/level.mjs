// level.mjs: the walk's level, made for any scene from the registry and the scene view (web-game-kit ref/city-to-level.md:
// static colliders from the level; r187 physics_rapier_basic for fixed colliders from the scene, physics_rapier_terrain for
// the ground as one collider from the terrain's own heights). Pure: no three.js, no Rapier, no DOM. No component is named
// here; each rule reads what every component already carries:
//  - ground: a collider with `surface: 'ground'` (any ground generator: desert-sand@2.0.0's bounds slab) is replaced by the
//    piece's drawn surface (scene view `surface(uid)`, its first LOD on this preset) as a trimesh, so the player stands on
//    the dunes he sees. Kept apart (`ground`) so a terrain rebuild swaps only it (lib/walk/session.mjs).
//  - water: every water area in the scene layout (category `water`, lib/scene/layout.mjs) is a blocking volume over its
//    outline (its triangles as convex hulls, from 10 m down to `reach` over the highest point of the level, at least 3 m
//    up), so the player stops at the water's edge and cannot jump in or onto it: `reach` is the highest jump apex the
//    player params allow plus the body (lib/walk/session.mjs; review of PR #28, M1). The blockers have kind 'water', which
//    the ground probe and the camera look through (lib/walk/controller.mjs). The basin's coping and walls stay solid.
//  - pieces: each piece's world colliders (scene view `colliders()`: the component's `collider` or build()'s, with the
//    instance transform, size params and yaw applied); sensors are skipped.
//  - imported models (`import` in component.json): their bounds box (lib/import/import.mjs), turned with the instance.
//  - a placed piece with no collider at all: a hull over its footprint outline and height.
//  - the `solid` behaviour (behaviours/solid): pieces are solid by default; an item carrying it with `enabled: false` gets
//    no collider (kind 'off'); with `shape: 'footprint'` its footprint hull replaces its collider.
//
//   walkLevel({ colliders, layout, surface, defOf, exclude }) -> { ground: [shape], solid: [shape], water: [{ uid, ring }],
//                                                                   kinds: { uid: ['ground' | 'water' | 'piece' | 'model' | 'footprint' | 'sensor'] } }
//   levelFor(view, registry, doc, { exclude }) -> the same, from a scene view, the registry and the document

import { sceneLayout } from '../scene/layout.mjs';
import { behaviourParams } from '../behaviours/def.mjs';

export const WATER_DEPTH = 10, WATER_TOP = 3; // metres below and above y = 0 that the water blocker spans

const area2 = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x, z] = r[i], [x2, z2] = r[(i + 1) % r.length]; a += x * z2 - x2 * z; } return a / 2; };
/** Ear clipping of a simple ring ([[x, z], ...]): triangles as index triples. */
export function triangulateRing(ring) {
  const n = ring.length; if (n < 3) return [];
  const idx = [...Array(n).keys()]; if (area2(ring) < 0) idx.reverse();
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  const out = []; let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inTri(ring[j], a, b, c))) continue;
      out.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

const prism = (pts, y0, y1) => pts.flatMap(([x, z]) => [x, y0, z, x, y1, z]);

/** The highest y of a list of level shapes (ground and solid), or 0. */
export function highestPoint(shapes) {
  let top = -Infinity;
  for (const c of shapes) {
    if (c.type === 'trimesh' || c.type === 'hull') { const v = c.vertices || c.points; for (let i = 1; i < v.length; i += 3) if (v[i] > top) top = v[i]; }
    else if (Array.isArray(c.pos)) top = Math.max(top, c.pos[1] + (Array.isArray(c.half) ? c.half[1] : (c.halfHeight || 0) + (c.type === 'capsule' ? c.radius : 0)) + (c.type === 'ball' ? c.radius : 0));
  }
  return Number.isFinite(top) ? top : 0;
}

export function walkLevel({ colliders = [], layout = [], surface = () => null, defOf = () => null, exclude = [], solidOf = () => null, reach = WATER_TOP } = {}) {
  const skip = new Set(exclude), ground = [], solid = [], water = [], kinds = {};
  const mark = (uid, k) => { if (!uid) return; (kinds[uid] ||= []); if (!kinds[uid].includes(k)) kinds[uid].push(k); };
  const forced = new Set(); // shape: footprint
  for (const sh of layout) { const b = solidOf(sh.uid); if (!b) continue; if (b.enabled === false) { skip.add(sh.uid); mark(sh.uid, 'off'); } else if (b.shape === 'footprint') forced.add(sh.uid); }
  const grounded = new Set();
  for (const c of colliders) {
    const uid = c.uid || null;
    if (uid && skip.has(uid)) continue;
    if (c.surface === 'ground') {
      if (grounded.has(uid)) continue; grounded.add(uid);
      const s = uid ? surface(uid) : null;
      if (s && s.indices?.length) ground.push({ type: 'trimesh', uid, kind: 'ground', vertices: s.vertices, indices: s.indices });
      else { // no drawn surface: the bottom half metre of the slab, so its top is not a 4 m wall
        const y0 = c.pos[1] - c.half[1];
        ground.push({ ...c, kind: 'ground', pos: [c.pos[0], y0 + 0.25, c.pos[2]], half: [c.half[0], 0.25, c.half[2]] });
      }
      mark(uid, 'ground'); continue;
    }
    if (c.sensor) { mark(uid, c.surface === 'water' ? 'water' : 'sensor'); continue; }
    if (uid && forced.has(uid)) continue;
    const def = uid ? defOf(uid) : null;
    const kind = def?.import ? 'model' : 'piece';
    // a character or an animal standing as a piece is solid to walk into, but never holds the camera's arm (`actor`)
    solid.push({ ...c, kind, ...(def && (def.category === 'character' || def.category === 'animal') ? { actor: true } : {}) }); mark(uid, kind);
  }
  const waterShapes = [];
  for (const sh of layout) {
    if (skip.has(sh.uid)) continue;
    if (sh.water && sh.shape === 'polygon') { water.push({ uid: sh.uid, ring: sh.points.map((q) => [q[0], q[1]]) }); waterShapes.push(sh); mark(sh.uid, 'water'); continue; }
    if ((kinds[sh.uid]?.length && !forced.has(sh.uid)) || sh.shape !== 'polygon') continue;
    const def = defOf(sh.uid);
    if (!def?.footprint) continue;
    const h = def.footprint.height || [0, 1];
    solid.push({ type: 'hull', uid: sh.uid, kind: 'footprint', points: prism(sh.points, h[0], Math.max(h[1], h[0] + 0.05)), ...(def.category === 'character' || def.category === 'animal' ? { actor: true } : {}) });
    mark(sh.uid, 'footprint');
  }
  // the water blockers last: over the highest point of everything else by the player's reach
  const highest = highestPoint([...ground, ...solid]);
  const top = Math.max(WATER_TOP, highest + reach);
  for (const sh of waterShapes) for (const [a, b, c] of triangulateRing(sh.points)) solid.push({ type: 'hull', uid: sh.uid, kind: 'water', points: prism([sh.points[a], sh.points[b], sh.points[c]], -WATER_DEPTH, top) });
  return { ground, solid, water, kinds, highest, waterTop: top };
}

/** The level of a scene view's current scene. The uids in `exclude` (the player's own figure) are left out. */
export function levelFor(view, registry, doc, { exclude = [], reach = WATER_TOP } = {}) {
  const items = new Map([...(doc?.areas || []), ...(doc?.instances || [])].map((x) => [x.uid, x]));
  return walkLevel({
    colliders: view.colliders(), layout: sceneLayout(doc, registry), surface: (uid) => view.surface(uid),
    defOf: (uid) => (items.has(uid) ? registry.get(items.get(uid).component) : null), exclude, reach,
    solidOf: (uid) => { const b = (items.get(uid)?.behaviours || []).find((x) => x.type === 'solid'); const d = registry.behaviour?.('solid'); return b ? (d ? behaviourParams(d, b.params) : { ...(b.params || {}) }) : null; },
  });
}

const insideRing = (r, x, z) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const ringDist = (r, x, z) => { let d = Infinity; for (let i = 0; i < r.length; i++) { const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length], dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)); d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz)); } return d; };
/** True when (x, z) is inside a water area of the level by more than `margin` metres. */
export function insideWater(level, x, z, margin = 0) {
  return (level.water || []).some((w) => insideRing(w.ring, x, z) && ringDist(w.ring, x, z) > margin);
}

/** The nearest place to (x, z) that is not in the water by `margin` metres: (x, z) itself when it is dry, else the first
 * dry point on rings of growing radius (16 directions, 0.5 m steps). A respawn never lands in the water or on its blocker. */
export function dryPoint(level, x, z, margin = 0.5) {
  const dry = (px, pz) => !(level.water || []).some((w) => insideRing(w.ring, px, pz) || ringDist(w.ring, px, pz) < margin);
  if (dry(x, z)) return [x, z];
  for (let r = 0.5; r < 2000; r += 0.5) for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8, px = x + r * Math.cos(a), pz = z + r * Math.sin(a); if (dry(px, pz)) return [px, pz]; }
  return [x, z];
}
