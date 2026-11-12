// desert-terrain.js: desert-sand@2.0.0, the builder's generic desert terrain. r187 examples: webgpu_tsl_procedural_terrain
// (a noise terrain whose normals come from neighbouring heights) and webgl_geometry_terrain (one indexed grid written from a
// height field); webgpu_generator_city for the outline laid as a world-space surface. Recipes: threejs-procedural-fields
// (one field drives geometry and normals; frequencies the mesh can carry) and threejs-geometry (one indexed BufferGeometry,
// one draw). The look is the frozen `desert-sand` preset (shared/materials/boulevard-ground.js, slot `surface`), unchanged:
// this module only gives it a landscape and feeds it the same wind as the dunes.
//
// For any scene, with no per-scene values:
//  - Dunes from builder/sculpt/dunes.js (type, height, spacing, wind, irregularity, seed, slope cap).
//  - A flat clear zone round every placed piece: the runtime hands build() the scene layout (lib/scene/layout.mjs, through
//    ctx.layout; `usesLayout` below); ground within `clearMargin` of any area, path or footprint is flat at SAND_Y. Beyond
//    it the dunes are cut by a ramp that eases in over `clearBlend` metres and then rises at half the slope cap (a smooth
//    minimum of dune and ramp), so the dunes come up out of the flat sand without any face steeper than the cap: the
//    minimum of two surfaces each under the cap is under the cap, where a height multiplied by a mask is not. This
//    replaces 1.0.0's fixed flatRadius round the origin.
//  - The wet band along every water area (the `shoreDist` attribute the material reads), from the same layout.
//  - Mesh density (reviews 22b, 22c): a quadtree over the outline's box (8 to 64 tiles a side, about the far-cell size).
//    Cells are `near` wide (Phone 2 m, High 1 m; at most 3 m / 1.5 m) in a window round each piece (its footprint box grown
//    by its clear margin), grow linearly with the distance to the nearest window (grading k), and are never wider than a
//    share of the dune spacing (Phone spacing / 6, High spacing / 10), so the dunes away from the pieces keep their relief
//    however the pieces are scattered (tests/dunes-review2.test.mjs). Cells of any level meet without T-junctions: a cell
//    takes every corner of its finer neighbours on its edges into its outline and is fanned (from a clean corner, else
//    from its centre). One draw. Budget (Phone 28k, High 78k triangles): a fixed ladder of coarser steps (planCells) that
//    always ends; far cells give way first, then near cells down to the flatness limit (margin / sqrt 2 where a cell
//    touches a footprint), then the room left goes back to the far cells; if nothing fits, an even mesh that must fit is
//    used and `over_budget` (and `flatness`) recorded. What was given up is in userData.ground.traded. Many pieces (60,
//    150, 400) fit in about 0.3-3 s per build (tests/dunes-review3.test.mjs). The 1.0.0 and S3 meshes were tensor grids,
//    whose fine rows and columns ran the whole outline.
//  - The layout comes in the piece's own frame (lib/runtime/scene-view.mjs undoes the sand area's transform), so a moved,
//    turned or scaled sand area keeps its clear zones under the pieces (review 22, should 4).
//  - The work is a generator (terrainSteps) that yields between rows; build() runs it in slices of a few milliseconds
//    between frames (terrainGeometryAsync), so a rebuild after a piece moved never stalls a frame (review 22, must-fix 1).
//  - A face limiter: no triangle steeper than maxSlope (heights only ever lowered towards a face's lowest corner), so the
//    blend into the clear zones and the swell never break the cap.
//  - Normals from the gradient of the final heights, fitted by least squares over each vertex's edge neighbours (on a
//    regular patch, the central differences); on a clipped (non-rectangular) outline the triangles are cut exactly to the
//    outline (convex pieces, shared cut points: watertight), and the corners on it and their neighbours take their faces'
//    normal.
//    1.0.0 used computeVertexNormals: face-area averages on a coarse grid with all diagonals one way, whose kinks along the
//    grid lines showed as straight bands in the low sun (the mid-distance banding the judges saw).
// Contract: build(params, ctx) -> { object, collider, sockets } (lib/runtime/scene-view.mjs); sockets(params).
import { boundsCollider, checkOutline } from './outline.js';
import { subtract, triangulate, ccw as ccwRing } from './clip.js';
import { duneField } from './dunes.js';

export const MODULE = 'builder/sculpt/desert-terrain.js';
export const SAND_Y = -0.02; // under the paving (y = 0) and the lake (0.06): the plaza sits on the sand
/** The runtime passes the scene layout (ctx.layout) and rebuilds this piece when the other pieces move. */
export const usesLayout = true;
/** Per preset: the triangle budget, the cell size round the pieces (`near`, at most `nearMax` when the budget is short),
 * and the largest cell as a share of the dune spacing (Phone spacing / 6, High spacing / 9: what keeps the dunes away from
 * the pieces within 10 % / 5 % of their relief, tests/dunes-review2.test.mjs). */
export const GRID = Object.freeze({ phone: { tris: 28000, near: 2, nearMax: 3, capPerSpacing: 1 / 6, k: 0.15 }, high: { tris: 78000, near: 1, nearMax: 1.5, capPerSpacing: 1 / 10, k: 0.12 } });

export function sockets(params) { checkOutline(params.outline, MODULE); return []; }

// ---------- distances to the layout ----------
function prepShapes(layout) {
  return (Array.isArray(layout) ? layout : []).filter((s) => Array.isArray(s?.points) && s.points.length >= (s.shape === 'path' ? 2 : 3)).map((s) => {
    return { closed: s.shape !== 'path', pts: s.points, water: !!s.water, cut: !!s.cut, box: boxOf(s.points) };
  });
}
/** [minX, minZ, maxX, maxZ] of [x, z] points, by a loop (never a spread: a layout can hold thousands of points). */
function boxOf(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
function inside(pts, x, z) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function edgeDist(s, x, z) {
  let d = Infinity; const n = s.pts.length, m = s.closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const [ax, az] = s.pts[i], [bx, bz] = s.pts[(i + 1) % n], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    d = Math.min(d, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return d;
}
/** Metres from (x, z) to the nearest shape within `reach` (0 inside a polygon), else Infinity. */
function distance(shapes, x, z, reach) {
  let d = Infinity;
  for (const s of shapes) {
    const [x0, z0, x1, z1] = s.box;
    if (x < x0 - reach || x > x1 + reach || z < z0 - reach || z > z1 + reach) continue;
    if (s.closed && inside(s.pts, x, z)) return 0;
    d = Math.min(d, edgeDist(s, x, z));
  }
  return d;
}
/** Polynomial smooth minimum (its gradient is a blend of the two gradients, so it never steepens either). */
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// ---------- the mesh: a quadtree, fine round the pieces ----------
/** Metres between two rectangles [x0, z0, x1, z1]: -1 when they overlap (share area), 0 when they only touch. */
const rectDist = (a, b) => {
  const dx = Math.max(a[0] - b[2], b[0] - a[2]), dz = Math.max(a[1] - b[3], b[1] - a[3]);
  return dx < 0 && dz < 0 ? -1 : Math.hypot(Math.max(0, dx), Math.max(0, dz));
};

/** Windows bucketed on a 32 m grid; dist(rect, maxD) is the distance to the nearest one, or maxD if none is nearer. */
function windowIndex(windows) {
  const B = 32, map = new Map();
  let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
  for (const w of windows) for (let bx = Math.floor(w[0] / B); bx <= Math.floor(w[2] / B); bx++) for (let bz = Math.floor(w[1] / B); bz <= Math.floor(w[3] / B); bz++) {
    const k = bx * 1048576 + bz; let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(w);
    gx0 = Math.min(gx0, bx); gz0 = Math.min(gz0, bz); gx1 = Math.max(gx1, bx); gz1 = Math.max(gz1, bz);
  }
  return {
    dist(r, maxD) {
      if (!map.size) return maxD;
      const bx0 = Math.floor(r[0] / B), bz0 = Math.floor(r[1] / B), bx1 = Math.floor(r[2] / B), bz1 = Math.floor(r[3] / B);
      let best = maxD;
      for (let ring = 0; ; ring++) {
        if ((ring - 1) * B > best) break; // every bucket in this ring is farther than the best found
        if (bx0 - ring < gx0 && bx1 + ring > gx1 && bz0 - ring < gz0 && bz1 + ring > gz1 && ring > 0) break; // past every window
        for (let bx = bx0 - ring; bx <= bx1 + ring; bx++) for (let bz = bz0 - ring; bz <= bz1 + ring; bz++) {
          if (ring && bx > bx0 - ring && bx < bx1 + ring && bz > bz0 - ring && bz < bz1 + ring) continue; // the ring's border only
          const a = map.get(bx * 1048576 + bz); if (!a) continue;
          for (const w of a) { const d = rectDist(r, w); if (d < best) best = d; }
        }
        if (best < 0) break;
      }
      return best;
    },
  };
}

/**
 * The cells of the terrain: a quadtree over the outline's bounding box (8 to 64 square-ish tiles a side, each split in four
 * while a cell is wider than it should be). A cell should be
 * at most `near` wide where it touches a window (a piece's footprint box grown by its clear margin) and at most
 * near + k x (its distance to the nearest window, at least half its own width) elsewhere, never wider than `cap`.
 * -> { leaves: [[L, i, j]], cover, inRange, ... }.
 */
export function quadCells(X0, Z0, X1, Z1, windows, opts) {
  const it = quadCellsSteps(X0, Z0, X1, Z1, windows, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
function* quadCellsSteps(X0, Z0, X1, Z1, windows, { near, cap, k }) {
  const W = X1 - X0, H = Z1 - Z0;
  let Lf = 0, nTx, nTz;
  // top tiles about the far-cell size (8 to 64 a side): the fewer levels between a tile and a fine cell, the fewer cells
  // the path down to each piece costs (each level leaves three siblings)
  const maxT = Math.min(64, Math.max(8, Math.ceil(Math.max(W, H) / cap)));
  for (;;) { nTx = Math.max(1, Math.ceil(W / (near * 2 ** Lf))); nTz = Math.max(1, Math.ceil(H / (near * 2 ** Lf))); if (Math.max(nTx, nTz) <= maxT) break; Lf++; }
  const Tx = W / nTx, Tz = H / nTz;
  const key = (L, i, j) => L * 2 ** 42 + i * 2 ** 21 + j;
  const leaves = new Map();
  const rect = (L, i, j) => { const sx = Tx / 2 ** L, sz = Tz / 2 ** L; return [X0 + i * sx, Z0 + j * sz, X0 + (i + 1) * sx, Z0 + (j + 1) * sz]; };
  const index = windowIndex(windows), reachOut = Math.max(0, (cap - near) / Math.max(k, 1e-9)); // beyond reachOut a cell is cap wide anyway
  // a cell over a window is `near` wide; one outside it (touching or not) may grow with its distance, counted as at least
  // half its own width, so a window does not force a ring of fine cells round it
  const want = (r, size) => { const d = index.dist(r, reachOut); return d < 0 ? near : Math.min(cap, near + k * Math.max(d, size / 2)); };
  const stack = [];
  for (let i = 0; i < nTx; i++) for (let j = 0; j < nTz; j++) stack.push([0, i, j]);
  let steps = 0;
  while (stack.length) {
    if ((++steps & 255) === 0) yield;
    const [L, i, j] = stack.pop();
    const size = Math.max(Tx, Tz) / 2 ** L;
    if (L < Lf && size > want(rect(L, i, j), size)) stack.push([L + 1, 2 * i, 2 * j], [L + 1, 2 * i + 1, 2 * j], [L + 1, 2 * i, 2 * j + 1], [L + 1, 2 * i + 1, 2 * j + 1]);
    else leaves.set(key(L, i, j), [L, i, j]);
  }
  const inRange = (L, i, j) => i >= 0 && j >= 0 && i < nTx * 2 ** L && j < nTz * 2 ** L;
  /** The level of the leaf covering cell (L, i, j), or -1 when that cell is split finer. */
  const cover = (L, i, j) => { for (let l = L; l >= 0; l--) { const sh = 2 ** (L - l); if (leaves.has(key(l, Math.floor(i / sh), Math.floor(j / sh)))) return l; } return -1; };
  return { leaves: [...leaves.values()], cover, inRange, Tx, Tz, nTx, nTz, Lf };
}

/** Vertices (x, z, the narrowest cell touching each) and triangles of the quadtree: a cell with no finer neighbour is two
 * triangles (diagonals alternating); one with finer neighbours takes all their corners on its edges and is fanned, so no
 * vertex sits on another triangle's edge, whatever the level gap (watertight). Triangles face +y. */
function* quadMesh(X0, Z0, Q) {
  const { leaves, cover, inRange, Tx, Tz } = Q;
  let R = 0; for (const l of leaves) if (l[0] > R) R = l[0];
  R += 1; const unit = 2 ** R; // one level below the finest leaf: cell centres are vertices too
  const ids = new Map(), X = [], Z = [], Wd = [], tris = [];
  const vid = (gx, gz, size) => {
    const k = gx * 2 ** 24 + gz;
    let id = ids.get(k);
    if (id === undefined) { id = X.length; ids.set(k, id); X.push(X0 + (gx * Tx) / unit); Z.push(Z0 + (gz * Tz) / unit); Wd.push(size); }
    else if (size < Wd[id]) Wd[id] = size;
    return id;
  };
  const tri = (a, b, c) => {
    const s = (X[b] - X[a]) * (Z[c] - Z[a]) - (X[c] - X[a]) * (Z[b] - Z[a]);
    if (s > 0) tris.push(a, c, b); else tris.push(a, b, c);
  };
  // the corners of the finer cells along one edge of a subdivided neighbour (l, a, b), in unit coordinates; `side` is the
  // neighbour's edge that faces the leaf being triangulated
  const along = (l, a, b, side, out) => {
    const sh = 2 ** (R - l - 1), kids = side === 'top' ? [[2 * a, 2 * b + 1], [2 * a + 1, 2 * b + 1]] : side === 'bottom' ? [[2 * a, 2 * b], [2 * a + 1, 2 * b]]
      : side === 'right' ? [[2 * a + 1, 2 * b], [2 * a + 1, 2 * b + 1]] : [[2 * a, 2 * b], [2 * a, 2 * b + 1]];
    out.push(side === 'top' ? [(2 * a + 1) * sh, (2 * b + 2) * sh] : side === 'bottom' ? [(2 * a + 1) * sh, 2 * b * sh]
      : side === 'right' ? [(2 * a + 2) * sh, (2 * b + 1) * sh] : [2 * a * sh, (2 * b + 1) * sh]);
    for (const [ci, cj] of kids) if (cover(l + 1, ci, cj) < 0) along(l + 1, ci, cj, side, out);
  };
  let steps = 0;
  for (const [L, i, j] of leaves) {
    if ((++steps & 255) === 0) yield;
    const s = 2 ** (R - L), a0 = i * s, b0 = a0 + s, c0 = j * s, d0 = c0 + s, size = Math.max(Tx, Tz) / 2 ** L;
    // every vertex of a finer neighbour that lies on this cell's edges joins its outline (no T-junction, any level gap)
    const extra = [];
    for (const [ni, nj, side] of [[i, j - 1, 'top'], [i + 1, j, 'left'], [i, j + 1, 'bottom'], [i - 1, j, 'right']]) if (inRange(L, ni, nj) && cover(L, ni, nj) < 0) along(L, ni, nj, side, extra);
    const p00 = vid(a0, c0, size), p10 = vid(b0, c0, size), p11 = vid(b0, d0, size), p01 = vid(a0, d0, size);
    if (!extra.length) {
      if ((i + j) & 1) { tri(p00, p10, p11); tri(p00, p11, p01); } else { tri(p00, p10, p01); tri(p10, p11, p01); }
      continue;
    }
    const cx = a0 + s / 2, cz = c0 + s / 2;
    const ring = [[a0, c0, 1], [b0, c0, 1], [b0, d0, 1], [a0, d0, 1], ...extra].map(([gx, gz, corner]) => ({ gx, gz, corner: !!corner, ang: Math.atan2(gz - cz, gx - cx) })).sort((p, q) => p.ang - q.ang);
    const ids2 = ring.map((p) => vid(p.gx, p.gz, size)), nR = ring.length;
    // a fan from a corner whose two sides carry no extra point (n - 2 triangles), else from the centre (n triangles)
    const from = ring.findIndex((p, e) => p.corner && ring[(e + 1) % nR].corner && ring[(e + nR - 1) % nR].corner);
    if (from >= 0) for (let e = 1; e < nR - 1; e++) tri(ids2[from], ids2[(from + e) % nR], ids2[(from + e + 1) % nR]);
    else { const c = vid(cx, cz, size); for (let e = 0; e < nR; e++) tri(c, ids2[e], ids2[(e + 1) % nR]); }
  }
  return { X: Float64Array.from(X), Z: Float64Array.from(Z), W: Float64Array.from(Wd), index: Uint32Array.from(tris) };
}

/**
 * The quadtree for a layout within the preset's triangle budget: fine cells (`near`) in a window round every piece (its
 * footprint box grown by its clear margin and a cell), cells growing with distance (grading rate k: metres of cell per metre
 * away) up to `cap`. A fixed ladder of steps, each coarser than the last, so it ends in a bounded number of tries (review
 * 22c): grade faster (k up to 1), then coarser far cells (cap up to 8x, the dunes away from the pieces go first), then
 * coarser near cells (up to `nearMax`, then up to the flatness limit: cells no wider than margin / sqrt 2 where they touch a
 * footprint, so every corner of a cell over a piece is within its clear margin and the ground there stays flat, then past
 * it up to RAMP_NEAR, recorded as `flatness`: a piece may then sit up to about 0.1 m in the clear zone's ramp). A step
 * whose estimated count is clearly over is skipped without building. If none fits, a uniform mesh that always fits is used
 * and `over_budget` is recorded (with `flatness` when its cells are wider than the flatness limit). What was given up is in
 * userData.ground.traded.
 */
const RAMP_NEAR = 8; // m: the widest near cell the ladder tries before the even mesh (see planCells)
function* planCells(X0, Z0, X1, Z1, boxes, margin, G, cap0) {
  const area = (X1 - X0) * (Z1 - Z0), flatMax = Math.max(margin / Math.SQRT2, G.near);
  const steps = [];
  for (const k of [G.k, 0.3, 0.6, 1]) steps.push({ near: G.near, cap: cap0, k, traded: k === G.k ? [] : ['grading'] });
  for (const c of [1.5, 2.25, 3.4, 5, 8]) steps.push({ near: G.near, cap: cap0 * c, k: 1, traded: ['grading', 'cap'] });
  const ladder = (from, to, f) => { const out = []; for (let v = from * f; v < to; v *= f) out.push(v); if (to > from) out.push(to); return out; };
  for (const near of ladder(G.near, G.nearMax, 1.25)) steps.push({ near, cap: cap0 * 8, k: 1, traded: ['grading', 'cap', 'near'] });
  // past the promise: the window shrinks to the footprint itself (flatness needs narrow cells only where they touch a
  // footprint; the rest of the clear zone is flat whatever its cells), and the cells grow twice as fast
  // With many pieces the cells on the way down to each window cost more than the far field, so smaller caps are tried
  // too (fewer levels between a window and the far cells).
  // Last before the even mesh (review 4): near cells past the flatness limit, up to RAMP_NEAR. A corner of such a cell
  // can sit past a piece's clear margin, on the clear zone's ramp, which rises about 0.1 m in its first 8 m, so the piece
  // sits at most that far in the sand; the even mesh it replaces sank pieces up to 1.32 m. Recorded as `flatness`.
  const tightNear = [G.nearMax, ...ladder(G.nearMax, flatMax, 1.4)];
  for (const v of ladder(Math.max(G.nearMax, flatMax), RAMP_NEAR, 1.4)) if (v > tightNear.at(-1) * 1.01) tightNear.push(v);
  for (const near of tightNear) for (const k of [2, 8]) for (const c of [cap0 * 8, near * 16, near * 8, near * 4]) steps.push({ near, cap: Math.max(c, near * 2), k, tight: true, traded: near > flatMax * 1.0001 ? ['grading', 'cap', 'near', 'flatness'] : ['grading', 'cap', 'near'] });
  const windowsFor = (near, tight) => { const p = tight ? 0 : margin + near; return boxes.map((b) => [b[0] - p, b[1] - p, b[2] + p, b[3] + p]); };
  for (const st of steps) {
    const windows = windowsFor(st.near, st.tight);
    // estimate: the far field, the windows (overlaps counted twice), and about 12 cells a level in the rings round each
    let est = area / (st.cap * st.cap) + windows.length * 12 * Math.max(0, Math.log2(st.cap / st.near));
    for (const w of windows) est += ((w[2] - w[0]) * (w[3] - w[1])) / (st.near * st.near);
    if (2 * est > 4 * G.tris && st !== steps.at(-1)) continue; // clearly over: do not even build it
    const rough = yield* quadCellsSteps(X0, Z0, X1, Z1, windows, { near: st.near, cap: st.cap, k: st.k });
    if (2.2 * rough.leaves.length > G.tris) continue;
    const Q = yield* quadCellsSteps(X0, Z0, X1, Z1, windows, { near: st.near, cap: st.cap, k: st.k });
    const M = yield* quadMesh(X0, Z0, Q);
    if (M.index.length / 3 > G.tris) continue;
    // it fits: give the room left back to the far cells (the smallest cap that still fits, from the preset's own up)
    let best = { Q, M, near: st.near, cap: st.cap, k: st.k, traded: st.traded };
    for (let c = cap0; c < st.cap * 0.99; c *= 1.5) {
      const r2 = yield* quadCellsSteps(X0, Z0, X1, Z1, windows, { near: st.near, cap: c, k: st.k });
      if (2.2 * r2.leaves.length > G.tris) continue;
      const M2 = yield* quadMesh(X0, Z0, r2);
      if (M2.index.length / 3 <= G.tris) { best = { Q: r2, M: M2, near: st.near, cap: c, k: st.k, traded: c > cap0 ? st.traded : st.traded.filter((x) => x !== 'cap') }; break; }
    }
    return best;
  }
  // nothing fits: one even mesh that must (cells in (s/2, s], two triangles each, at most 8 area / s^2 <= budget)
  const s = Math.sqrt((8 * area) / G.tris) * 1.02;
  const Q = yield* quadCellsSteps(X0, Z0, X1, Z1, [], { near: s, cap: s, k: 0 });
  const traded = ['grading', 'cap', 'near', 'over_budget'];
  if (s > flatMax) traded.push('flatness');
  return { Q, M: yield* quadMesh(X0, Z0, Q), near: s, cap: s, k: 0, traded };
}

/**
 * Lowers heights until no triangle is steeper than tanCap; returns how many heights moved. h: Float64Array by vertex.
 * A steep face lowers only its highest corner, by the least that brings the face to the cap (the face's gradient is linear
 * in that corner's height: |g0 + x D| = tan, the root just under the current height), so a crest that one face finds too
 * steep loses centimetres, not its whole height. When the other two corners alone are too steep, the face's heights are
 * scaled towards its lowest corner instead.
 */
export function limitSlopes(X, Z, h, index, tanCap, maxPasses = 600) {
  const it = limitSlopesSteps(X, Z, h, index, tanCap, maxPasses);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
function* limitSlopesSteps(X, Z, h, index, tanCap, maxPasses = 600) {
  const t = tanCap * 0.9995, moved = new Uint8Array(h.length);
  const grad = (a, b, c, ha, hb, hc) => { // the face's height gradient (dh/dx, dh/dz)
    const ux = X[b] - X[a], uz = Z[b] - Z[a], vx = X[c] - X[a], vz = Z[c] - Z[a], det = ux * vz - uz * vx;
    if (Math.abs(det) < 1e-12) return null;
    const du = hb - ha, dv = hc - ha;
    return [(du * vz - dv * uz) / det, (dv * ux - du * vx) / det];
  };
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (let f = 0; f < index.length; f += 3) {
      if (f % 6000 === 0) yield;
      let a = index[f], b = index[f + 1], c = index[f + 2];
      const g1 = grad(a, b, c, h[a], h[b], h[c]);
      if (!g1 || Math.hypot(g1[0], g1[1]) <= t) continue;
      // the highest corner first
      if (h[b] > h[a] && h[b] >= h[c]) [a, b] = [b, a]; else if (h[c] > h[a] && h[c] > h[b]) [a, c] = [c, a];
      const gm = grad(a, b, c, h[a] - 1, h[b], h[c]), D = [g1[0] - gm[0], g1[1] - gm[1]], g0 = [g1[0] - h[a] * D[0], g1[1] - h[a] * D[1]];
      const qa = D[0] * D[0] + D[1] * D[1], qb = 2 * (g0[0] * D[0] + g0[1] * D[1]), qc = g0[0] * g0[0] + g0[1] * g0[1] - t * t, disc = qb * qb - 4 * qa * qc;
      let next = -Infinity;
      if (qa > 1e-12 && disc >= 0) for (const r of [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)]) if (r < h[a] && r > next) next = r;
      const lo = Math.min(h[b], h[c]);
      if (next >= lo) { h[a] = next - 1e-6; moved[a] = 1; }
      else { // lowering the top corner cannot do it: scale the face towards its lowest corner
        const k = (t / Math.hypot(g1[0], g1[1])) * 0.999, base = Math.min(h[a], lo);
        for (const v of [a, b, c]) if (h[v] > base) { h[v] = base + (h[v] - base) * k; moved[v] = 1; }
      }
      changed = true;
    }
    if (!changed) break;
  }
  let n = 0; for (const v of moved) n += v; return n;
}

function* maxFaceSlopeSteps(P, index) {
  let worst = 0;
  for (let f = 0; f < index.length; f += 3) {
    if (f % 15000 === 0) yield;
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    worst = Math.max(worst, Math.acos(Math.min(1, Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1))));
  }
  return (worst * 180) / Math.PI;
}

/**
 * The terrain geometry: an indexed BufferGeometry (position, normal, uv = (x, -z) metres, shoreDist), facing up.
 * opts: quality ('phone' | 'high'), y, field (duneField), layout (lib/scene/layout.mjs, in this piece's frame), margin,
 * blend, maxSlope. userData.ground = { tris, heightRange, maxSlopeDeg, cells: { near, far }, focus, limited,
 * effectiveHeight, grid? } (grid = { nx, nz } when the outline is its own bounding rectangle: the vertices are then the full
 * grid, row-major). terrainGeometry runs it at once; terrainGeometryAsync in slices between frames.
 */
export function terrainGeometry(T, outline, opts = {}) {
  const it = terrainSteps(T, outline, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
/** As terrainGeometry, yielding to the event loop whenever a slice has run `sliceMs` (the frame keeps drawing). */
export async function terrainGeometryAsync(T, outline, opts = {}, { sliceMs = 3 } = {}) {
  const it = terrainSteps(T, outline, opts), now = () => (globalThis.performance?.now ? performance.now() : Date.now());
  let t = now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (now() - t > sliceMs) { await new Promise((res) => setTimeout(res, 0)); t = now(); }
  }
}

export function* terrainSteps(T, outline, { quality = 'high', y = SAND_Y, field, layout = [], margin = 8, blend = 40, maxSlope = 15 } = {}) {
  const G = GRID[quality === 'phone' ? 'phone' : 'high'];
  const [X0, Z0, X1, Z1] = boxOf(outline);
  const shapes = prepShapes(layout), water = shapes.filter((s) => s.water);
  // the centre of the pieces (or of the outline); windows: each piece's box grown by its clear margin and a cell
  let focus = [(X0 + X1) / 2, (Z0 + Z1) / 2];
  if (shapes.length) {
    let b0 = Infinity, b1 = Infinity, b2 = -Infinity, b3 = -Infinity;
    for (const { box } of shapes) { b0 = Math.min(b0, box[0]); b1 = Math.min(b1, box[1]); b2 = Math.max(b2, box[2]); b3 = Math.max(b3, box[3]); }
    focus = [Math.min(X1, Math.max(X0, (b0 + b2) / 2)), Math.min(Z1, Math.max(Z0, (b1 + b3) / 2))];
  }
  const boxes = shapes.length ? shapes.map((s) => s.box) : [[focus[0], focus[1], focus[0], focus[1]]];
  const spacing = field.opts?.spacing ?? 140;
  const plan = yield* planCells(X0, Z0, X1, Z1, boxes, shapes.length ? margin : 0, G, Math.max(2 * G.near, spacing * G.capPerSpacing));
  yield;
  const { X: X1v, Z: Z1v, W: Wcell } = plan.M;
  let full = plan.M.index;
  const n = X1v.length;
  // heights: the dune field (crests rounded over the vertex's cell), cut down to the clear-zone ramp near the pieces
  const hv = new Float64Array(n);
  const tanCap = Math.tan((maxSlope * Math.PI) / 180), rise = 0.5 * tanCap, B = Math.max(blend, 1e-6);
  const top = Math.max(field.maxHeight ?? field.effectiveHeight ?? 0, 0.01), soft = Math.min(2, 0.3 * top);
  const reach = margin + B / 2 + top / rise + soft + 1;
  const ramp = (d) => { const t = d - margin; return t <= 0 ? 0 : t < B ? (rise * t * t) / (2 * B) : rise * (t - B / 2); };
  const BK = 64, buckets = new Map(); // the shapes each 64 m bucket can reach
  shapes.forEach((s, si) => {
    for (let bx = Math.floor((s.box[0] - reach) / BK); bx <= Math.floor((s.box[2] + reach) / BK); bx++) for (let bz = Math.floor((s.box[1] - reach) / BK); bz <= Math.floor((s.box[3] + reach) / BK); bz++) {
      const k = `${bx},${bz}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(s);
    }
  });
  const heightAt = (x, z, w) => {
    const near = buckets.get(`${Math.floor(x / BK)},${Math.floor(z / BK)}`);
    const d = near ? distance(near, x, z, reach) : Infinity;
    if (d <= margin) return 0;
    const hf = field.height(x, z, w);
    return d >= reach ? hf : Math.max(0, smin(hf, ramp(d), soft));
  };
  for (let v = 0; v < n; v++) { hv[v] = heightAt(X1v[v], Z1v[v], 0.5 * Wcell[v]); if ((v & 255) === 255) yield; }
  yield;
  let limited = yield* limitSlopesSteps(X1v, Z1v, hv, full, tanCap);
  // clip to the outline when it is not its own bounding rectangle (review 22c): the outline is cut into convex pieces (itself
  // when convex, else its triangulation); every triangle that is not wholly inside, or that a piece edge crosses, is clipped
  // against each piece (Sutherland-Hodgman) and the result fanned. Cut points are computed from the shared edge in one
  // order and merged by position, so neighbours share them: no hole, no T-junction, nothing turned over.
  const rect = outline.length === 4 && outline.every(([x, z]) => (Math.abs(x - X0) < 1e-9 || Math.abs(x - X1) < 1e-9) && (Math.abs(z - Z0) < 1e-9 || Math.abs(z - Z1) < 1e-9));
  let keep = null, X = X1v, Z = Z1v, h = hv, nAll = n, Wv = Wcell;
  if (!rect) {
    const pieces = convexPieces(T, outline), segs = [];
    for (const pc of pieces) for (let e = 0; e < pc.length; e++) segs.push([pc[e], pc[(e + 1) % pc.length]]);
    const Xa = Array.from(X), Za = Array.from(Z), Ha = Array.from(h), Wa = Array.from(Wcell);
    // a corner within 3 cm of the outline moves onto it, unless one of its triangles would turn over or lose half its area:
    // the part of a triangle inside the outline is then never a sliver a few millimetres thin (review 22d)
    {
      const incident = new Map(), taken = new Set();
      for (let f = 0; f < full.length; f += 3) for (let e = 0; e < 3; e++) { const v = full[f + e]; let a = incident.get(v); if (!a) incident.set(v, (a = [])); a.push(f); }
      const area2 = (f) => (Xa[full[f + 1]] - Xa[full[f]]) * (Za[full[f + 2]] - Za[full[f]]) - (Xa[full[f + 2]] - Xa[full[f]]) * (Za[full[f + 1]] - Za[full[f]]);
      for (let v = 0; v < n; v++) {
        const near = nearestOnOutline(outline, Xa[v], Za[v]);
        if (!(near.d > 0 && near.d < 0.03)) continue;
        const k = `${Math.round(near.x * 1000)},${Math.round(near.z * 1000)}`; if (taken.has(k)) continue;
        const fs = incident.get(v) || [], before = fs.map(area2), ox = Xa[v], oz = Za[v];
        Xa[v] = near.x; Za[v] = near.z;
        if (fs.every((f, q) => { const ar = area2(f); return ar * before[q] > 0 && Math.abs(ar) >= 0.5 * Math.abs(before[q]); })) { taken.add(k); Ha[v] = heightAt(near.x, near.z, 0.5 * Wa[v]); }
        else { Xa[v] = ox; Za[v] = oz; }
      }
    }
    // cut points: one per exact place (a cut is computed from its edge in one order, so neighbours get the same place, and a
    // cut exactly on a corner is that corner); then cut points within 1 cm of each other are one point (merged as clusters,
    // after every triangle is cut, so both sides of an edge agree: review 22d)
    const exactKey = (x, z) => `${Math.round(x * 1e5)},${Math.round(z * 1e5)}`, at = new Map();
    for (let v = 0; v < n; v++) at.set(exactKey(Xa[v], Za[v]), v);
    const cutW = [];
    const idAt = (x, z, w) => {
      const k = exactKey(x, z); let id = at.get(k);
      if (id === undefined) { id = Xa.length; at.set(k, id); Xa.push(x); Za.push(z); Ha.push(0); Wa.push(w); cutW.push(id); }
      return id;
    };
    const inOut = new Uint8Array(n); for (let v = 0; v < n; v++) inOut[v] = inside(outline, Xa[v], Za[v]) ? 1 : 0;
    const out = [], polys = [];
    for (let f = 0; f < full.length; f += 3) {
      if (f % 3000 === 0) yield;
      const t3 = [full[f], full[f + 1], full[f + 2]];
      const tri = t3.map((v) => ({ x: Xa[v], z: Za[v], id: v }));
      if (inOut[t3[0]] && inOut[t3[1]] && inOut[t3[2]] && !segs.some(([p, q]) => segHitsTri(p, q, tri))) { out.push(...t3); continue; }
      const w = Math.min(Wa[t3[0]], Wa[t3[1]], Wa[t3[2]]);
      for (const pc of pieces) {
        const poly = clipConvex(tri, pc);
        if (poly.length >= 3) polys.push(poly.map((p) => (p.id !== undefined ? p.id : idAt(p.x, p.z, w))));
      }
    }
    // clusters of cut points closer than 1 cm (union-find on a 1 cm grid); the smallest id stands for its cluster
    const parent = new Map(), find = (a) => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); return r; };
    const grid = new Map(), cell = (id) => [Math.floor(Xa[id] * 100), Math.floor(Za[id] * 100)];
    for (const id of cutW) { const [i, j] = cell(id); const k = i * 1e8 + j; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(id); parent.set(id, id); }
    for (const id of cutW) {
      const [i, j] = cell(id);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const o of grid.get((i + di) * 1e8 + (j + dj)) || []) {
        if (o === id || Math.hypot(Xa[o] - Xa[id], Za[o] - Za[id]) >= 0.01) continue;
        const ra = find(id), rb = find(o); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
      }
    }
    // a cut point joined by an edge shorter than 1 cm to a corner is that corner (merged once for the whole mesh, so every
    // triangle that held either gets the same one)
    const isCut = new Set(cutW);
    for (const raw of polys) for (let e = 0; e < raw.length; e++) {
      const a = raw[e], b = raw[(e + 1) % raw.length];
      if ((!isCut.has(a) && !isCut.has(b)) || Math.hypot(Xa[a] - Xa[b], Za[a] - Za[b]) >= 0.01) continue;
      for (const v of [a, b]) if (!parent.has(v)) parent.set(v, v);
      const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
    }
    for (const id of cutW) if (find(id) === id) Ha[id] = heightAt(Xa[id], Za[id], 0.5 * Wa[id]);
    const onLine = (id) => outlineDist(outline, Xa[id], Za[id]) < 1e-6;
    for (const raw of polys) {
      const ids0 = raw.map((id) => (parent.has(id) ? find(id) : id)).filter((id, e, arr) => id !== arr[(e + arr.length - 1) % arr.length]);
      if (ids0.length < 3) continue;
      // fan from a corner off the outline (the cut points on it are in a row: a fan from one of them would be flat)
      const apex = Math.max(0, ids0.findIndex((id) => !onLine(id)));
      const ids = [...ids0.slice(apex), ...ids0.slice(0, apex)];
      for (let e = 1; e < ids.length - 1; e++) {
        const a = ids[0], b = ids[e], c = ids[e + 1];
        if (a === b || b === c || a === c) continue;
        if (Math.abs((Xa[b] - Xa[a]) * (Za[c] - Za[a]) - (Xa[c] - Xa[a]) * (Za[b] - Za[a])) < 1e-9) continue; // no area
        out.push(a, b, c);
      }
    }
    X = Float64Array.from(Xa); Z = Float64Array.from(Za); h = Float64Array.from(Ha); nAll = Xa.length;
    full = Uint32Array.from(out);
    keep = new Uint8Array(nAll); for (const v of full) keep[v] = 1;
    Wv = Float64Array.from(Wa);
    limited += yield* limitSlopesSteps(X, Z, h, full, tanCap); // a cut corner can steepen a face: keep the cap
  }
  // the ground opened where a basin stands (layout shapes marked `cut`: lake-water@2.0.0), cut exactly to its outline
  const cuts = shapes.filter((s) => s.cut && s.closed);
  let cutInfo = null;
  if (cuts.length) {
    const r = yield* cutHolesSteps(T, X, Z, h, Wv, full, cuts, heightAt);
    X = r.X; Z = r.Z; h = r.h; nAll = X.length; full = r.full; cutInfo = r.info;
    keep = new Uint8Array(nAll); for (const v of full) keep[v] = 1;
    limited += yield* limitSlopesSteps(X, Z, h, full, tanCap);
  }
  // normals: the gradient of the final heights, by least squares over each vertex's neighbours (on a regular grid, the
  // central differences); corners pulled onto a clipped outline, and their neighbours, take their faces' normal
  const nrm = yield* gradientNormals(X, Z, h, full, nAll);
  // compact and write the attributes
  const remap = new Int32Array(nAll).fill(-1); let m = 0;
  for (let v = 0; v < nAll; v++) if (!keep || keep[v]) remap[v] = m++;
  const P = new Float32Array(m * 3), Nn = new Float32Array(m * 3), U = new Float32Array(m * 2), S = new Float32Array(m);
  let hMin = Infinity, hMax = -Infinity;
  for (let v = 0; v < nAll; v++) {
    const r = remap[v]; if (r < 0) continue;
    const x = X[v], z = Z[v], hy = y + h[v];
    P[r * 3] = x; P[r * 3 + 1] = hy; P[r * 3 + 2] = z;
    Nn[r * 3] = nrm[v * 3]; Nn[r * 3 + 1] = nrm[v * 3 + 1]; Nn[r * 3 + 2] = nrm[v * 3 + 2];
    U[r * 2] = x; U[r * 2 + 1] = -z;
    let sd = 1e4;
    for (const w of water) { const e = edgeDist(w, x, z); sd = Math.min(sd, inside(w.pts, x, z) ? -e : e); }
    S[r] = sd;
    hMin = Math.min(hMin, hy); hMax = Math.max(hMax, hy);
    if ((v & 1023) === 1023) yield;
  }
  const index = m > 65535 ? new Uint32Array(full.length) : new Uint16Array(full.length);
  for (let f = 0; f < full.length; f++) index[f] = remap[full[f]];
  yield;
  if (keep) faceNormalsAt(P, index, Nn, (() => { // the corners on a clipped outline and their neighbours
    const pulled = new Uint8Array(m);
    for (let v = 0; v < nAll; v++) if (remap[v] >= 0 && outlineDist(outline, X[v], Z[v]) < 0.01) pulled[remap[v]] = 1;
    const ring = Uint8Array.from(pulled);
    for (let f = 0; f < index.length; f += 3) if (pulled[index[f]] || pulled[index[f + 1]] || pulled[index[f + 2]]) ring[index[f]] = ring[index[f + 1]] = ring[index[f + 2]] = 1;
    return ring;
  })());
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(P, 3));
  g.setAttribute('normal', new T.BufferAttribute(Nn, 3));
  g.setAttribute('uv', new T.BufferAttribute(U, 2));
  g.setAttribute('shoreDist', new T.BufferAttribute(S, 1));
  g.setIndex(new T.BufferAttribute(index, 1));
  yield;
  g.computeBoundingBox(); g.computeBoundingSphere();
  yield;
  let near = Infinity, far = 0;
  for (const [L] of plan.Q.leaves) { const s = Math.max(plan.Q.Tx, plan.Q.Tz) / 2 ** L; near = Math.min(near, s); far = Math.max(far, s); }
  yield;
  g.userData.ground = {
    tris: index.length / 3, heightRange: [hMin, hMax], maxSlopeDeg: yield* maxFaceSlopeSteps(P, index), cells: { near, far, cap: plan.cap, grading: plan.k },
    traded: [...plan.traded], focus, limited, effectiveHeight: field.effectiveHeight, cut: cutInfo,
  };
  return g;
}

/** Vertex normals from the least-squares gradient of the heights over each vertex's neighbours (weights 1 / d^2). */
function* gradientNormals(X, Z, h, index, n) {
  const sxx = new Float64Array(n), sxz = new Float64Array(n), szz = new Float64Array(n), sxh = new Float64Array(n), szh = new Float64Array(n);
  const add = (a, b) => {
    const dx = X[b] - X[a], dz = Z[b] - Z[a], dh = h[b] - h[a], w = 1 / (dx * dx + dz * dz || 1);
    sxx[a] += w * dx * dx; sxz[a] += w * dx * dz; szz[a] += w * dz * dz; sxh[a] += w * dx * dh; szh[a] += w * dz * dh;
  };
  const seen = new Set();
  for (let f = 0; f < index.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = index[f + e], b = index[f + (e + 1) % 3], k = a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a;
      if (seen.has(k)) continue; seen.add(k); add(a, b); add(b, a);
    }
    if (f % 6000 === 0) yield;
  }
  const out = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    const det = sxx[v] * szz[v] - sxz[v] * sxz[v];
    let gx = 0, gz = 0;
    if (det > 1e-12) { gx = (szz[v] * sxh[v] - sxz[v] * szh[v]) / det; gz = (sxx[v] * szh[v] - sxz[v] * sxh[v]) / det; }
    const l = Math.hypot(gx, 1, gz);
    out[v * 3] = -gx / l; out[v * 3 + 1] = 1 / l; out[v * 3 + 2] = -gz / l;
  }
  return out;
}

/** The normal of `which` vertices from their faces (area-weighted, facing up). */
function faceNormalsAt(P, index, Nn, which) {
  const acc = new Float64Array(Nn.length);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f], b = index[f + 1], c = index[f + 2];
    if (!which[a] && !which[b] && !which[c]) continue;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx; if (fy < 0) { fx = -fx; fy = -fy; fz = -fz; }
    for (const v of [a, b, c]) if (which[v]) { acc[v * 3] += fx; acc[v * 3 + 1] += fy; acc[v * 3 + 2] += fz; }
  }
  for (let v = 0; v < which.length; v++) if (which[v]) { const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]); if (l > 0) for (let c = 0; c < 3; c++) Nn[v * 3 + c] = acc[v * 3 + c] / l; }
}


/**
 * The terrain with every `cut` shape taken out exactly (review: lake basins sit below the ground, which must open for them).
 * A corner within 3 cm of a cut's edge moves onto it first (unless one of its triangles would turn over or lose half its
 * area), so no sliver is left along it. Triangles wholly outside every cut are kept, wholly inside are dropped, and the ones a
 * cut's edge crosses are cut by polyclip (builder/sculpt/clip.js subtract) and re-triangulated (clip.js triangulate, every
 * point kept); new points are merged within 1 micrometre, so the two triangles either side of an edge share their cut
 * points: no hole and no T-junction. -> { X, Z, h, full, info: { holes, cutTris, kept, dropped } }.
 */
function* cutHolesSteps(T, X0, Z0, h0, W0, index, cuts, heightAt) {
  const X = Array.from(X0), Z = Array.from(Z0), h = Array.from(h0), Wd = Array.from(W0), n = X.length;
  const holes = cuts.map((c) => { const r = ccwRing(c.pts); return { r, box: boxOf(r) }; });
  const near = (x, z) => { let best = { d: Infinity }; for (const H of holes) { const [x0, z0, x1, z1] = H.box; if (x < x0 - 0.05 || x > x1 + 0.05 || z < z0 - 0.05 || z > z1 + 0.05) continue; const q = nearestOnOutline(H.r, x, z); if (q.d < best.d) best = q; } return best; };
  // corners within 3 cm of a cut's edge move onto it
  {
    const incident = new Map();
    for (let f = 0; f < index.length; f += 3) for (let e = 0; e < 3; e++) { const v = index[f + e]; let a = incident.get(v); if (!a) incident.set(v, (a = [])); a.push(f); }
    const area2 = (f) => (X[index[f + 1]] - X[index[f]]) * (Z[index[f + 2]] - Z[index[f]]) - (X[index[f + 2]] - X[index[f]]) * (Z[index[f + 1]] - Z[index[f]]);
    for (let v = 0; v < n; v++) {
      const q = near(X[v], Z[v]); if (!(q.d > 0 && q.d < 0.03)) continue;
      const fs = incident.get(v) || [], before = fs.map(area2), ox = X[v], oz = Z[v];
      X[v] = q.x; Z[v] = q.z;
      if (fs.every((f, k) => { const a = area2(f); return a * before[k] > 0 && Math.abs(a) >= 0.5 * Math.abs(before[k]); })) h[v] = heightAt(q.x, q.z, 0.5 * Wd[v]);
      else { X[v] = ox; Z[v] = oz; }
      if ((v & 1023) === 1023) yield;
    }
  }
  const inHole = (x, z, H) => insideRingOn(H.r, x, z);
  const grid = new Map(), Q = 1e6;
  const idAt = (x, z, w) => {
    const i = Math.round(x * Q), j = Math.round(z * Q);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const id = grid.get(`${i + di},${j + dj}`); if (id !== undefined) return id; }
    const id = X.length; X.push(x); Z.push(z); h.push(heightAt(x, z, 0.5 * w)); Wd.push(w); grid.set(`${i},${j}`, id); return id;
  };
  const out = [], info = { holes: holes.length, cutTris: 0, kept: 0, dropped: 0 };
  const face = (a, b, c) => { const s = (X[b] - X[a]) * (Z[c] - Z[a]) - (X[c] - X[a]) * (Z[b] - Z[a]); if (Math.abs(s) < 1e-12) return; if (s > 0) out.push(a, c, b); else out.push(a, b, c); };
  for (let f = 0; f < index.length; f += 3) {
    if (f % 3000 === 0) yield;
    const t3 = [index[f], index[f + 1], index[f + 2]], tx = t3.map((v) => X[v]), tz = t3.map((v) => Z[v]);
    const tb = [Math.min(...tx), Math.min(...tz), Math.max(...tx), Math.max(...tz)];
    const cand = holes.filter((H) => H.box[0] <= tb[2] && H.box[2] >= tb[0] && H.box[1] <= tb[3] && H.box[3] >= tb[1]);
    let crossing = false, inside = false;
    const tri = t3.map((v) => ({ x: X[v], z: Z[v] }));
    for (const H of cand) {
      const r = H.r; let hit = false;
      for (let e = 0; e < r.length && !hit; e++) {
        const p = r[e], q = r[(e + 1) % r.length];
        if (Math.max(p[0], q[0]) < tb[0] || Math.min(p[0], q[0]) > tb[2] || Math.max(p[1], q[1]) < tb[1] || Math.min(p[1], q[1]) > tb[3]) continue;
        if (segHitsTri(p, q, tri)) hit = true;
      }
      if (hit) { crossing = true; break; }
      const cx = (tx[0] + tx[1] + tx[2]) / 3, cz = (tz[0] + tz[1] + tz[2]) / 3;
      if (inHole(cx, cz, H)) { inside = true; break; }
    }
    if (!crossing) { if (inside) info.dropped++; else { out.push(...t3); info.kept++; } continue; }
    info.cutTris++;
    const w = Math.min(Wd[t3[0]], Wd[t3[1]], Wd[t3[2]]);
    const ring = ccwRing(t3.map((v) => [X[v], Z[v]]));
    for (const poly of subtract(ring, cand.map((H) => H.r))) {
      const [outer, ...hs] = poly;
      const pts = [outer, ...hs].flat();
      const ids = pts.map(([x, z]) => { for (const v of t3) if (Math.abs(X[v] - x) < 1e-7 && Math.abs(Z[v] - z) < 1e-7) return v; return idAt(x, z, w); });
      for (const [a, b, c] of triangulate(T, outer, hs)) if (ids[a] !== ids[b] && ids[b] !== ids[c] && ids[a] !== ids[c]) face(ids[a], ids[b], ids[c]);
    }
  }
  // a cut point that one triangle made on an edge its neighbour kept whole (a cut's corner touching that edge, which
  // polyclip leaves out of the untouched side) is taken into the neighbour too: the triangle is fanned from the opposite corner
  const pts = new Map(), C = 1;
  for (let v = n; v < X.length; v++) { const k = `${Math.floor(X[v] / C)},${Math.floor(Z[v] / C)}`; let a = pts.get(k); if (!a) pts.set(k, (a = [])); a.push(v); }
  const onEdge = (a, b) => {
    const x0 = Math.min(X[a], X[b]), x1 = Math.max(X[a], X[b]), z0 = Math.min(Z[a], Z[b]), z1 = Math.max(Z[a], Z[b]);
    if (!holes.some((H) => H.box[0] <= x1 + 1e-6 && H.box[2] >= x0 - 1e-6 && H.box[1] <= z1 + 1e-6 && H.box[3] >= z0 - 1e-6)) return [];
    const dx = X[b] - X[a], dz = Z[b] - Z[a], l2 = dx * dx + dz * dz, found = [];
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) for (const v of pts.get(`${i},${j}`) || []) {
      if (v === a || v === b) continue;
      const t = ((X[v] - X[a]) * dx + (Z[v] - Z[a]) * dz) / l2;
      if (t > 1e-9 && t < 1 - 1e-9 && Math.abs((X[v] - X[a]) * dz - (Z[v] - Z[a]) * dx) / Math.sqrt(l2) < 1e-7) found.push([t, v]);
    }
    return found.sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  };
  const fixed = [];
  const split = (a, b, c, depth) => {
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const mid = depth < 32 ? onEdge(p, q) : [];
      if (!mid.length) continue;
      const chain = [p, ...mid, q];
      for (let e = 0; e + 1 < chain.length; e++) split(r, chain[e], chain[e + 1], depth + 1);
      return;
    }
    const s2 = (X[b] - X[a]) * (Z[c] - Z[a]) - (X[c] - X[a]) * (Z[b] - Z[a]);
    if (Math.abs(s2) < 1e-12) return;
    if (s2 > 0) fixed.push(a, c, b); else fixed.push(a, b, c);
  };
  for (let f = 0; f < out.length; f += 3) { split(out[f], out[f + 1], out[f + 2], 0); if (f % 30000 === 0) yield; }
  info.tJunctions = (fixed.length - out.length) / 3;
  return { X: Float64Array.from(X), Z: Float64Array.from(Z), h: Float64Array.from(h), full: Uint32Array.from(fixed), info };
}
/** Inside the ring (even-odd) or within 1 nm of its boundary. */
function insideRingOn(r, x, z) { return inside(r, x, z) || nearestOnOutline(r, x, z).d < 1e-9; }

/** The outline as convex pieces: itself when convex, else its triangles (three.js ShapeUtils). */
function convexPieces(T, outline) {
  let sign = 0, convex = true;
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length], [cx, cz] = outline[(i + 2) % outline.length];
    const c = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (Math.abs(c) < 1e-12) continue;
    if (!sign) sign = Math.sign(c); else if (Math.sign(c) !== sign) { convex = false; break; }
  }
  if (convex) return [outline];
  return T.ShapeUtils.triangulateShape(outline.map(([x, z]) => new T.Vector2(x, z)), []).map((t) => t.map((i) => outline[i]));
}
/** Whether segment p-q meets triangle tri ([{x, z}] x 3), touching included. */
function segHitsTri(p, q, tri) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const T3 = tri.map((t) => [t.x, t.z]), e = 1e-9;
  const inT = (pt) => { const d1 = o(T3[0], T3[1], pt), d2 = o(T3[1], T3[2], pt), d3 = o(T3[2], T3[0], pt); return !((d1 < -e || d2 < -e || d3 < -e) && (d1 > e || d2 > e || d3 > e)); };
  if (inT(p) || inT(q)) return true;
  for (let i = 0; i < 3; i++) {
    const a = T3[i], b = T3[(i + 1) % 3];
    const d1 = o(p, q, a), d2 = o(p, q, b), d3 = o(a, b, p), d4 = o(a, b, q);
    if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e))) return true;
  }
  return false;
}
/** Sutherland-Hodgman: polygon poly ([{x, z, id?}]) clipped by convex polygon pc ([[x, z]]). A cut point is computed from
 * its edge's two ends in a fixed (sorted) order, so the two triangles sharing that edge get the very same point. */
function clipConvex(poly, pc) {
  let A = 0; for (let i = 0; i < pc.length; i++) { const [ax, az] = pc[i], [bx, bz] = pc[(i + 1) % pc.length]; A += ax * bz - bx * az; }
  const sgn = Math.sign(A);
  let out = poly;
  for (let i = 0; i < pc.length && out.length; i++) {
    const [ax, az] = pc[i], [bx, bz] = pc[(i + 1) % pc.length];
    const side = (p) => sgn * ((bx - ax) * (p.z - az) - (bz - az) * (p.x - ax));
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const P = out[k], Q = out[(k + 1) % out.length], sp = side(P), sq = side(Q);
      if (sp >= 0) next.push(P);
      if ((sp >= 0) !== (sq >= 0)) {
        const [U, V, su, sv] = P.x < Q.x || (P.x === Q.x && P.z < Q.z) ? [P, Q, sp, sq] : [Q, P, sq, sp];
        const t = su / (su - sv);
        next.push({ x: U.x + t * (V.x - U.x), z: U.z + t * (V.z - U.z) });
      }
    }
    out = next;
  }
  return out;
}

/** The nearest point of the outline's boundary to (x, z). */
function nearestOnOutline(outline, x, z) {
  let best = { d: Infinity, x, z };
  for (let e = 0; e < outline.length; e++) {
    const [px, pz] = outline[e], [qx, qz] = outline[(e + 1) % outline.length], dx = qx - px, dz = qz - pz, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - px) * dx + (z - pz) * dz) / l2)), cx = px + t * dx, cz = pz + t * dz, d = Math.hypot(x - cx, z - cz);
    if (d < best.d) best = { d, x: cx, z: cz };
  }
  return best;
}

/** Metres from (x, z) to the outline's boundary. */
function outlineDist(outline, x, z) {
  let d = Infinity;
  for (let e = 0; e < outline.length; e++) {
    const [px, pz] = outline[e], [qx, qz] = outline[(e + 1) % outline.length], dx = qx - px, dz = qz - pz, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - px) * dx + (z - pz) * dz) / l2));
    d = Math.min(d, Math.hypot(x - px - t * dx, z - pz - t * dz));
  }
  return d;
}

export async function build(params, ctx) {
  const { THREE } = ctx;
  const outline = checkOutline(params.outline, MODULE);
  // the frozen sand look, with the dunes' wind for its ripples
  const material = ctx.slot('surface', { windAngle: params.windAngle });
  if (material.userData?.ready && typeof window !== 'undefined') await material.userData.ready;
  const field = duneField({ type: params.duneType, height: params.duneHeight, spacing: params.duneSpacing, windAngle: params.windAngle, irregularity: params.irregularity, seed: params.seed, maxSlope: params.maxSlope });
  const geometry = await terrainGeometryAsync(THREE, outline, { quality: ctx.preset, y: SAND_Y, field, layout: ctx.layout || [], margin: params.clearMargin, blend: params.clearBlend, maxSlope: params.maxSlope });
  geometry.userData.sculpt = { module: MODULE, from: 'outline' };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'desert-sand'; mesh.receiveShadow = true;
  mesh.userData.sculpt = { module: MODULE, from: 'outline' };
  const [, top] = geometry.userData.ground.heightRange;
  // what the ground gave up to stay in budget reaches the page (builder/hud-logic.js groundDetailWarning, review 4)
  return { object: mesh, collider: [boundsCollider(params.outline, SAND_Y - 0.5, Math.max(SAND_Y, top), { surface: 'ground' })], sockets: [], features: { traded: [...geometry.userData.ground.traded] } };
}
