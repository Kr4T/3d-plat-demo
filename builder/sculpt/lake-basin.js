// lake-basin.js: lake-water@2.0.0, the lake as a closed stone basin built from its own outline. r187 examples:
// webgpu_water (the water surface: normal-mapped ripples scrolled by the TSL clock, the `water` preset, unchanged) and
// webgpu_generator_city (SidewalkGenerator curbGeometry: a kerb profile carried round a block outline, the r187 example for
// an extruded profile along a path; webgl_geometry_extrude_shapes for a Shape swept along a closed path). Recipes:
// threejs-procedural-architecture (a coping is a profile with real dimensions: arrises, drip, overhang; compiled by
// material slot) and threejs-procedural-geometry (inset without self-intersection, exact polygon cuts, one writer).
//
// For any outline the user draws (convex, concave, many points, a few metres or a few hundred), with no per-scene values:
//  - The outline is the basin's OUTER edge: the coping's outer face, where the paving and the sand meet the basin and where
//    palms, lamps and benches snap (one `water-edge` socket per outline edge, as 1.0.0). The coping runs inward from it.
//  - The coping's inner edge is the outline eroded by the coping width (builder/sculpt/clip.js erode: polyclip, mitred at
//    every corner, so concave corners get a true mitre and tight curves never fold; a narrow neck splits the water in two).
//    The wall face is eroded by the width less the overhang (5 cm), so the coping overhangs the wall and throws a shadow
//    line. Every ring is densified (1 m on High, 2 m on Phone, at most 480 / 240 points) so the stones' joints and the
//    light follow the edge.
//  - Profile (y = 0 is the promenade): the outer face from 15 cm below ground (a buried skirt, so no gap shows against the
//    sand or paving) up to the coping top at `copingHeight`, the outer arris rounded (1.5 cm), the top flat across to the
//    inner arris, the inner face down the coping's 15 cm thickness to a rounded drip edge, the underside back to the wall
//    (a 1.5 cm fillet), then either a vertical wall or a sloped bank (`bankSlope`) down past the water line to the floor
//    `depth` below the water. The water lies `freeboard` below the coping top (so always at least 10 cm below the
//    promenade: copingHeight <= 0.25, freeboard >= 0.35), out to the wall or to where the bank meets the water line.
//  - Stations on one ring (the arrises, faces, fillet) are offsets of that ring by at most a few centimetres along its
//    mitres (clip.js offsetSmall: the same vertex count, joined by quads); flat or sloped spans between rings of different
//    erosions (the coping top, the underside, the bank, the floor) are triangulated between the two rings by earcut
//    (three.js ShapeUtils, the outer ring with the inner as holes), so a ring that split or lost points is still joined
//    exactly. Every span shares its ring's vertex positions: the basin is one closed sheet, open only along the buried
//    skirt, and the water's edge lies on the basin's own vertices at the water line (tests/lake-basin.test.mjs).
//  - One mesh for the basin (slot `coping`: kerb-concrete by default, or wet-paving; `uv.x` is metres along the outline,
//    the kerb material's 1 m stone joints) and one for the water (slot `surface`, uv = (x, -z) metres as 1.0.0): two draws.
//  - The sand opens where the basin stands (`cutsGround`: lib/scene/layout.mjs marks the area `cut`, desert-terrain.js cuts
//    the outline out of the ground exactly), its flat zone and wet band are measured from the outline (the outer edge).
// Contract: build(params, ctx) -> { object, collider, sockets } (lib/runtime/scene-view.mjs); sockets(params).
import { edgeSockets, checkOutline, boundsCollider } from './outline.js';
import { erode, offsetSmall, densify, ccw, signedArea, insideRing, mitreAt, triangulate, ringsClear } from './clip.js';

export const MODULE = 'builder/sculpt/lake-basin.js';
/** lib/scene/layout.mjs: the ground under this piece is cut away (the basin goes below the promenade). */
export const cutsGround = true;
/** components/sockets.json: what a water edge accepts. */
export const ACCEPTS = ['paving-edge', 'seat-faces-edge', 'palm-pit'];
/** Metres: the buried skirt below the promenade, the coping's thickness and overhang, the arris and fillet radii. */
export const BASIN = Object.freeze({ skirt: 0.15, thickness: 0.15, overhang: 0.05, arris: 0.015, fillet: 0.015 });
/** Per preset: points on each rounded corner, ring spacing (m), most points on a ring, bank station spacing (m). */
export const DETAIL = Object.freeze({ high: { arc: 4, step: 1, maxRing: 480, bankStep: 0.4 }, phone: { arc: 2, step: 2, maxRing: 240, bankStep: 0.8 } });
export const DEFAULTS = Object.freeze({ copingWidth: 0.5, copingHeight: 0.2, freeboard: 0.6, depth: 0.8, wallStyle: 'wall', bankSlope: 30, coping: 'kerb-concrete' });

/** The lake's sockets (refused, as build() refuses, for a bad outline): one `water-edge` per outline edge, at its midpoint at
 * promenade level, facing out of the lake: the coping's outer edge. */
export function sockets(params) {
  return edgeSockets(checkOutline(params.outline, MODULE), { closed: true, type: 'water-edge', accepts: ACCEPTS, snap: 0.5, y: 0, prefix: 'edge' });
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** The basin's levels from the params: { hc (coping top), yu (underside), yw (water), yf (floor), w, theta }. */
export function levels(params) {
  const P = { ...DEFAULTS, ...params };
  const hc = num(P.copingHeight, DEFAULTS.copingHeight), fb = num(P.freeboard, DEFAULTS.freeboard), depth = num(P.depth, DEFAULTS.depth);
  const yu = hc - BASIN.thickness, yw = hc - fb;
  return { hc, yu, yw, yf: yw - depth, w: num(P.copingWidth, DEFAULTS.copingWidth), bank: P.wallStyle === 'bank', theta: (num(P.bankSlope, DEFAULTS.bankSlope) * Math.PI) / 180 };
}

// ---------- the profile's rounded corners, in (s, y): s metres toward the water from the ring, y up ----------
/** A rounded corner between face A (normal nA) and face B (normal nB) meeting at C, radius rho, `segs` points: convex
 * (an arris: the centre in the stone) or concave (a fillet: the centre in the air). -> [[s, y, ns, ny], ...] from A to B. */
function corner(C, nA, nB, rho, segs, convex) {
  const c = nA[0] * nB[0] + nA[1] * nB[1], k = rho / (1 + c), sgn = convex ? -1 : 1;
  const ctr = [C[0] + sgn * k * (nA[0] + nB[0]), C[1] + sgn * k * (nA[1] + nB[1])];
  const a0 = Math.atan2(nA[1], nA[0]); let da = Math.atan2(nB[1], nB[0]) - a0;
  while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const out = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (da * i) / segs, n = [Math.cos(a), Math.sin(a)];
    out.push([ctr[0] - sgn * rho * n[0], ctr[1] - sgn * rho * n[1], n[0], n[1]]);
  }
  return out;
}

// ---------- the mesh writer: one indexed geometry, triangles turned to face their vertex normals ----------
function writer() {
  const P = [], N = [], U = [], I = [];
  const vert = (x, y, z, nx, ny, nz, u, v) => { const l = Math.hypot(nx, ny, nz) || 1; P.push(x, y, z); N.push(nx / l, ny / l, nz / l); U.push(u, v); return P.length / 3 - 1; };
  const tri = (a, b, c) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (Math.hypot(fx, fy, fz) < 1e-12) return; // no area (a station that did not move)
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz >= 0) I.push(a, b, c); else I.push(a, c, b);
  };
  return { P, N, U, I, vert, tri };
}

/** Arc length along the ring (closed) of the nearest point to (x, z): `index` is alongIndex(ring) (segments bucketed on a
 * grid, searched in growing squares, so a basin's thousands of vertices do not each scan the whole outline). */
function alongOf(ring, cum, x, z, index) {
  let best = Infinity, u = { i: Infinity, v: 0 };
  const test = (i) => {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < best - 1e-12 || (Math.abs(d - best) <= 1e-12 && i < u.i)) { best = d; u = { i, v: cum[i] + t * Math.sqrt(l2) }; }
  };
  if (!index) { for (let i = 0; i < ring.length; i++) test(i); return u.v; }
  const { C, cells } = index, ci = Math.floor(x / C), cj = Math.floor(z / C);
  for (let r = 0; ; r++) {
    const seen = new Set();
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (const k of cells.get(`${i},${j}`) || []) if (!seen.has(k)) { seen.add(k); test(k); }
    if (best <= r * C || r > index.span) break; // every segment nearer than the searched square has been seen
  }
  return u.v;
}
function alongIndex(ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const C = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 64), cells = new Map();
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    for (let a = Math.floor(Math.min(ax, bx) / C); a <= Math.floor(Math.max(ax, bx) / C); a++) for (let b = Math.floor(Math.min(az, bz) / C); b <= Math.floor(Math.max(az, bz) / C); b++) {
      const k = `${a},${b}`; let l = cells.get(k); if (!l) cells.set(k, (l = [])); l.push(i);
    }
  }
  return { C, cells, span: Math.ceil(Math.max(x1 - x0, z1 - z0) / C) + 2 };
}

/**
 * The basin and its water from an outline. opts: { preset: 'high' | 'phone', uv: 'along' | 'world', ...params }.
 * -> { basin, water, info } (BufferGeometries, tagged userData.sculpt; info: the levels, the rings and what was given up).
 */
export function basinGeometry(THREE, outline, opts = {}) {
  const D = DETAIL[opts.preset === 'phone' ? 'phone' : 'high'];
  const L = levels(opts);
  const O0 = ccw(checkOutline(outline, MODULE));
  const perimeter = O0.reduce((a, p, i) => a + Math.hypot(O0[(i + 1) % O0.length][0] - p[0], O0[(i + 1) % O0.length][1] - p[1]), 0);
  const step = Math.max(D.step, perimeter / D.maxRing);
  const info = { levels: L, given: [], step };
  // the coping's inner edge: the outline eroded by the width (narrower when the lake is too thin for the width asked)
  let w = L.w, inner = erode(O0, w);
  while (!inner.length && w > 0.1) { w /= 2; inner = erode(O0, w); }
  if (!inner.length) throw new Error(`${MODULE}: the lake is too narrow for a coping (no water left inside ${w.toFixed(2)} m)`);
  if (w !== L.w) info.given.push(`coping width ${L.w} m -> ${+w.toFixed(3)} m (the lake is too narrow)`);
  const o = Math.min(BASIN.overhang, w / 4);
  const dens = (r) => densify(r, step);
  const O = dens(O0), I = inner.map(dens);
  // the wall face: the coping's inner edge moved back by the overhang (one ring per inner ring, same points), so a finger of
  // the outline narrower than the coping, which the inner edge has lost, grows no wall of its own (review of PR #24: a wall
  // finger with no coping over it folded); the erosion of the outline is the fallback when that offset would fold
  let W = I.map((r) => offsetSmall(r, -o));
  if (W.some((r) => !r) || !ringsClear(W)) W = erode(O0, w - o).map(dens);
  info.outer = O; info.inner = I; info.wall = W; info.width = w;
  // the arris and fillet radii, smaller where a ring cannot carry them (an edge would turn over)
  const fit = (ring, d, sign) => { for (let r = d; r > 1e-4; r /= 2) { const q = offsetSmall(ring, sign * r); if (q) return { r, q }; } return { r: 0, q: ring.map((p) => [p[0], p[1]]) }; };
  let ra = Math.min(BASIN.arris, o / 3, BASIN.thickness / 3), rf = Math.min(BASIN.fillet, o / 3);
  const oFit = fit(O, ra, 1);
  const iFits = I.map((r) => fit(r, ra, -1));
  ra = Math.min(oFit.r, ...iFits.map((f) => f.r));
  if (ra < Math.min(BASIN.arris, o / 3, BASIN.thickness / 3) - 1e-9) info.given.push(`arris ${+ra.toFixed(4)} m on a tight ring`);
  const ring = (base, s) => (s === 0 ? base : offsetSmall(base, s) || base); // a station's ring (the radius already fits)
  const uvMode = opts.uv === 'world' ? 'world' : 'along';
  const cum = [0]; for (let i = 1; i <= O.length; i++) cum.push(cum[i - 1] + Math.hypot(O[i % O.length][0] - O[i - 1][0], O[i % O.length][1] - O[i - 1][1]));
  const B = writer();
  // metres along the outline, once per ring vertex (a row is an offset of its ring by a few centimetres: it takes the ring's)
  const uCache = new WeakMap(), aIdx = alongIndex(O);
  const uOfRing = (r) => { let a = uCache.get(r); if (!a) { a = r.map(([x, z]) => alongOf(O, cum, x, z, aIdx)); uCache.set(r, a); } return a; };
  /** One row of vertices: the ring offset by s, at y, normal (ns toward the water along each mitre, ny up). */
  const row = (base, s, y, ns, ny) => {
    const r = ring(base, s), ub = uvMode === 'world' ? null : uOfRing(base);
    return r.map(([x, z], i) => {
      const { m } = mitreAt(base, i);
      return B.vert(x, y, z, m[0] * ns, ny, m[1] * ns, ub ? ub[i] : x, ub ? y : -z);
    });
  };
  /** Quads between two rows of the same ring. */
  const strip = (ra2, rb2) => { const n = ra2.length; for (let j = 0; j < n; j++) { const a = ra2[j], b = ra2[(j + 1) % n], c = rb2[(j + 1) % n], d = rb2[j]; B.tri(a, b, c); B.tri(a, c, d); } };
  /** Rows along a profile on one ring: [[s, y, ns, ny], ...]; returns the rows. */
  const profileRows = (base, prof) => {
    const rows = [];
    for (const [s, y, ns, ny] of prof) rows.push(row(base, s, y, ns, ny));
    for (let k = 0; k + 1 < rows.length; k++) strip(rows[k], rows[k + 1]);
    return rows;
  };
  /** Earcut between rings: outers (each with the holes inside it), every vertex at its ring's height and normal. */
  const span = (outers, holes, yOuter, yHole, nOuter, nHole) => {
    for (let oi = 0; oi < outers.length; oi++) {
      const out = outers[oi], hs = holes.filter((h) => insideRing(out, h[0][0], h[0][1]));
      const pts = [...out, ...hs.flat()], ys = [...out.map(() => yOuter), ...hs.flatMap((h) => h.map(() => yHole))];
      const nrm = [...out.map((p, i) => nOuter(out, i)), ...hs.flatMap((h) => h.map((p, i) => nHole(h, i)))];
      const tris = triangulate(THREE, out, hs);
      const us = uvMode === 'world' ? null : [...uOfRing(out), ...hs.flatMap((h) => uOfRing(h))];
      const ids = pts.map(([x, z], i) => B.vert(x, ys[i], z, nrm[i][0], nrm[i][1], nrm[i][2], us ? us[i] : x, us ? ys[i] : -z));
      for (const [a, b, c] of tris) B.tri(ids[a], ids[b], ids[c]);
    }
  };
  const up = () => [0, 1, 0], down = () => [0, -1, 0];
  const { hc, yu, yw, yf } = L;
  const A = D.arc;
  // a spike narrower than the arrises, or a point a few centimetres from another edge, makes the arris rings cross: then the
  // coping keeps sharp edges there rather than fold (review of PR #24: open edges on the coping top)
  if (ra > 0 && !ringsClear([ring(O, ra), ...I.map((r) => ring(r, -ra))])) { ra = 0; info.given.push('arrises left sharp: the outline has a spike or edges a few centimetres apart'); }
  // 1. the outer face and the outer arris (ring O)
  const outerProf = [[0, -BASIN.skirt, -1, 0], ...(ra > 0 ? corner([0, hc], [-1, 0], [0, 1], ra, A, true) : [[0, hc, -1, 0]])];
  profileRows(O, outerProf);
  // 2. the coping top, between the arrises
  const Ot = ring(O, ra), It = I.map((r) => ring(r, -ra));
  span([Ot], It, hc, hc, up, up);
  info.top = { outer: [Ot], holes: It };
  // 3. the inner arris, the inner face and the drip edge (each inner ring)
  for (const r of I) {
    const prof = ra > 0 ? [...corner([0, hc], [0, 1], [1, 0], ra, A, true), ...corner([0, yu], [1, 0], [0, -1], ra, A, true)] : [[0, hc, 1, 0], [0, yu, 1, 0]];
    profileRows(r, prof); // (s, y) with s toward the water: the inner ring's own frame (its mitres point at the water)
  }
  // 4. the underside, from the drip edge back to the wall (or to the top of the bank's fillet)
  const rfFits = W.map((r) => fit(r, rf, 1)); rf = Math.min(rf, ...rfFits.map((f) => f.r));
  const th = L.theta, nB = [Math.sin(th), Math.cos(th)], dB = [Math.cos(th), -Math.sin(th)];
  // the bank's fillet between the underside and the slope, no longer than the underside leaves room for
  let rho = Math.min(rf, (o - ra) * 0.9 * Math.tan(th / 2)), Lt = rho > 1e-5 ? rho / Math.tan(th / 2) : 0;
  let Wu = W.map((r) => ring(r, L.bank ? Lt : rf));
  if ((rf > 0 || Lt > 0) && !ringsClear([...Wu, ...It])) { // the same under the coping: the fillet is left out there
    rf = 0; rho = 0; Lt = 0; Wu = W.map((r) => ring(r, 0));
    info.given.push('wall fillet left out: the outline has a spike or edges a few centimetres apart');
  }
  span(Wu, It, yu, yu, down, down);
  info.under = { outer: Wu, holes: It };
  // 5. the wall or the bank, down to the floor
  const blend = (h) => [h[0] * Math.SQRT1_2, Math.SQRT1_2, h[1] * Math.SQRT1_2];
  let waterRings = W;
  if (L.bank) {
    const sA = Lt * dB[0], yA = yu + Lt * dB[1];
    const fil = Lt > 0 ? corner([0, yu], [0, -1], nB, rho, A, false) : [[0, yu, 0, -1], [0, yu, nB[0], nB[1]]];
    for (const r of W) profileRows(r, fil);
    // bank stations by erosion from the outline: the water line exactly, then down to the floor
    const sW = sA + (yA - yw) / Math.tan(th), sF = sA + (yA - yf) / Math.tan(th);
    const st = []; for (let s = sA + D.bankStep; s < sW - 1e-6; s += D.bankStep) st.push(s);
    st.push(sW); for (let s = sW + D.bankStep; s < sF - 1e-6; s += D.bankStep) st.push(s); st.push(sF);
    let prev = W.map((r) => ring(r, sA)), prevY = yA, reachedWater = null;
    const bankN = (blendUp) => (r, i) => { const { m } = mitreAt(r, i); const n = [m[0] * nB[0], nB[1], m[1] * nB[0]]; if (!blendUp) return n; const l = Math.hypot(n[0], n[1] + 1, n[2]); return [n[0] / l, (n[1] + 1) / l, n[2] / l]; };
    let floorRings = null;
    for (const s of st) {
      const rings = erode(O0, w - o + s).map(dens), y = yA - (s - sA) * Math.tan(th);
      if (!rings.length) break;
      const isFloor = s === sF;
      span(prev, rings, prevY, y, bankN(false), bankN(isFloor));
      prev = rings; prevY = y;
      if (Math.abs(s - sW) < 1e-9) reachedWater = rings;
      if (isFloor) floorRings = rings;
    }
    if (!reachedWater) {
      const g = basinGeometry(THREE, outline, { ...opts, wallStyle: 'wall' });
      g.info.given.unshift('bank: the lake is too narrow for the slope to reach the water; built as a wall');
      return g;
    }
    waterRings = reachedWater;
    if (floorRings) span(floorRings, [], yf, yf, bankN(true), bankN(true));
    else {
      // the slope ran out of lake above the floor: the bank stops there and drops as a wall to the full depth
      info.given.push(`bank: the lake is too narrow for the slope to reach the floor; a wall from ${+prevY.toFixed(3)} m down`);
      for (const r of prev) { const a = row(r, 0, prevY, nB[0], nB[1]), b = row(r, 0, yf, 1, 1); strip(a, b); }
      span(prev, [], yf, yf, (r, i) => { const { m } = mitreAt(r, i); return blend(m); }, () => [0, 1, 0]);
    }
    info.floorY = yf;
  } else {
    for (const r of W) {
      const prof = [...(rf > 0 ? corner([0, yu], [0, -1], [1, 0], rf, A, false) : [[0, yu, 1, 0]]), [0, yw, 1, 0], [0, yf, 1, 1]];
      profileRows(r, prof);
    }
    span(W, [], yf, yf, (r, i) => { const { m } = mitreAt(r, i); return blend(m); }, () => [0, 1, 0]);
    info.floorY = yf;
  }
  info.waterRings = waterRings;
  const basin = new THREE.BufferGeometry();
  basin.setAttribute('position', new THREE.Float32BufferAttribute(B.P, 3));
  basin.setAttribute('normal', new THREE.Float32BufferAttribute(B.N, 3));
  basin.setAttribute('uv', new THREE.Float32BufferAttribute(B.U, 2));
  basin.setIndex(B.I);
  basin.userData.sculpt = { module: MODULE, from: 'outline' };
  basin.userData.area = { module: MODULE, height: [info.floorY, hc] }; // an area piece, raised and sunk: not a flat surface
  basin.userData.basin = info;
  // the water: flat over the water rings, uv = (x, -z) metres, normals up (builder/sculpt/outline.js flatArea, per ring)
  const Wr = writer();
  for (const r of waterRings) {
    const tris = triangulate(THREE, r);
    const ids = r.map(([x, z]) => Wr.vert(x, yw, z, 0, 1, 0, x, -z));
    for (const [a, b, c] of tris) Wr.tri(ids[a], ids[b], ids[c]);
  }
  const water = new THREE.BufferGeometry();
  water.setAttribute('position', new THREE.Float32BufferAttribute(Wr.P, 3));
  water.setAttribute('normal', new THREE.Float32BufferAttribute(Wr.N, 3));
  water.setAttribute('uv', new THREE.Float32BufferAttribute(Wr.U, 2));
  water.setIndex(Wr.I);
  water.userData.sculpt = { module: MODULE, from: 'outline' };
  water.userData.area = { module: MODULE, height: [yw, yw] };
  info.area = { outer: Math.abs(signedArea(O0)), water: waterRings.reduce((a, r) => a + Math.abs(signedArea(r)), 0) };
  return { basin, water, info };
}

/** One cuboid per outline edge over the coping (rotY kept within +-45 degrees, as kerbs.js), the water as a sensor, the floor. */
function colliders(outline, info) {
  const O = ccw(checkOutline(outline, MODULE)), { hc, yw } = info.levels, w = info.width, out = [];
  const top = Math.max(hc, 0.05);
  for (let i = 0; i < O.length; i++) {
    const [ax, az] = O[i], [bx, bz] = O[(i + 1) % O.length], len = Math.hypot(bx - ax, bz - az); if (len < 1e-6) continue;
    const nx = -(bz - az) / len, nz = (bx - ax) / len; // inward (ccw)
    let rotY = -Math.atan2(bz - az, bx - ax), half = [len / 2, (top + BASIN.skirt) / 2, w / 2];
    while (rotY > Math.PI / 4 + 1e-9) { rotY -= Math.PI / 2; half = [half[2], half[1], half[0]]; }
    while (rotY < -Math.PI / 4 - 1e-9) { rotY += Math.PI / 2; half = [half[2], half[1], half[0]]; }
    out.push({ type: 'cuboid', pos: [(ax + bx) / 2 + (nx * w) / 2, (top - BASIN.skirt) / 2, (az + bz) / 2 + (nz * w) / 2], half, rotY: Math.abs(rotY) < 1e-12 ? 0 : rotY });
  }
  out.push(boundsCollider(outline, info.floorY, yw, { sensor: true, surface: 'water' }));
  out.push(boundsCollider(outline, info.floorY - 0.2, info.floorY, { surface: 'stone' }));
  return out;
}

export async function build(params, ctx) {
  const { THREE } = ctx;
  const water = ctx.slot('surface');
  const copingPreset = params.coping || DEFAULTS.coping;
  const stone = copingPreset === DEFAULTS.coping ? ctx.slot('coping') : ctx.material(copingPreset);
  for (const m of [water, stone]) if (m.userData?.ready && typeof window !== 'undefined') await m.userData.ready;
  const g = basinGeometry(THREE, params.outline, { ...params, preset: ctx.preset, uv: copingPreset === 'wet-paving' ? 'world' : 'along' });
  const group = new THREE.Group(); group.name = 'lake-water';
  const basin = new THREE.Mesh(g.basin, stone); basin.name = 'lake basin'; basin.receiveShadow = true;
  const surface = new THREE.Mesh(g.water, water); surface.name = 'lake water'; surface.receiveShadow = true;
  for (const m of [basin, surface]) m.userData.sculpt = { module: MODULE, from: 'outline' };
  group.add(basin, surface);
  return { object: group, collider: colliders(params.outline, g.info), sockets: sockets(params), features: { basin: { given: [...g.info.given] } } };
}
