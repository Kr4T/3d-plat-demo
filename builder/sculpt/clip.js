// clip.js: exact polygon operations for the sculpt modules that cut or offset an outline (builder/sculpt/lake-basin.js:
// the coping's inner edge and the basin's walls and banks; builder/sculpt/desert-terrain.js: the ground opened where a
// basin stands). r187 example: webgpu_generator_city (SidewalkGenerator: a block outline inset into a kerb and a slab);
// recipe threejs-procedural-geometry (exact polygon cuts, inset without self-intersection). The boolean work is
// polyclip-ts inside Turf 7.4.0 (MIT, the solver's library: lib/solver/geometry.mjs), run on plain metres (Turf's
// difference and union are planar: nothing here is geographic). Turf is found as the solver finds it: globalThis.turf
// (the builder page loads vendor/turf-7.4.0/turf.min.js with a classic script), else the same file is loaded by a script
// tag (the gate's bench page), else `@turf/turf` from node_modules (Node: tests and the gate's file checks).
//
//   erode(ring, d, { mitreLimit }) -> [ring, ...]   the outline moved d metres inward, mitred at every corner (convex
//       corners meet by themselves, concave ones are mitred, a mitre longer than mitreLimit x d is cut there), as the set of
//       simple counter-clockwise rings polyclip returns (a narrow neck splits the outline in two; too thin a shape is []).
//   offsetSmall(ring, d, { mitreLimit }) -> ring | null   every vertex moved d metres along its mitre (inward for d > 0):
//       the same vertex count, so a profile swept round the ring can join its stations by quads. Only for small d (arrises
//       and fillets, a few centimetres); null when an edge would turn over.
//   subtract(poly, holes) -> [[outer, ...holes]]     the polygon minus the holes (each a ring), as polygons with holes.
//   clean(ring, minEdge) / densify(ring, step) / ccw(ring) / signedArea(ring) / insideRing(ring, x, z)
let turf = globalThis.turf || null;
if (!turf) {
  if (!(typeof process !== 'undefined' && process.versions?.node) && typeof document?.createElement === 'function') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/turf-7.4.0/turf.min.js', import.meta.url).href;
      s.onload = resolve; s.onerror = () => reject(new Error('clip.js: vendor/turf-7.4.0/turf.min.js did not load'));
      document.head.appendChild(s);
    });
    turf = globalThis.turf;
  } else turf = await import('@turf/turf');
}

export const signedArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x, z] = r[i], [x2, z2] = r[(i + 1) % r.length]; a += x * z2 - x2 * z; } return a / 2; };
/** The ring running x toward z (positive signed area). */
export const ccw = (r) => (signedArea(r) < 0 ? [...r].reverse() : r.slice());

/** Whether (x, z) is inside the ring (even-odd). */
export function insideRing(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Without points closer than minEdge to the previous kept one, and without points on a straight line through their
 * neighbours (within 0.1 mm), closing point dropped. */
export function clean(ring, minEdge = 1e-3) {
  let pts = [];
  for (const p of ring) { const q = pts[pts.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minEdge) pts.push([p[0], p[1]]); }
  while (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < minEdge) pts.pop();
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1, h = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / l;
      const along = ((b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1])) / (l * l);
      if (h < 1e-4 && along > 0 && along < 1) { pts.splice(i, 1); changed = true; i--; }
    }
  }
  return pts;
}

/** Points added on every edge longer than `step`, evenly (the corners kept). */
export function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step - 1e-9));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

const closed = (r) => [...r.map((p) => [p[0], p[1]]), [r[0][0], r[0][1]]];
const polysOf = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const unit = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
/** Inward unit normal of edge a -> b of a counter-clockwise ring (its left-hand side). */
const inwardN = (a, b) => unit(-(b[1] - a[1]), b[0] - a[0]);

/** The mitre of vertex i of a counter-clockwise ring: { m (inward unit bisector), k (mitre length per metre of offset),
 * reflex (the inside angle is over 180 degrees) }. */
export function mitreAt(ring, i) {
  const n = ring.length, a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
  const n1 = inwardN(a, b), n2 = inwardN(b, c);
  let m = [n1[0] + n2[0], n1[1] + n2[1]];
  const l = Math.hypot(m[0], m[1]);
  m = l < 1e-9 ? n1 : [m[0] / l, m[1] / l];
  const cosHalf = m[0] * n1[0] + m[1] * n1[1];
  const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); // < 0: turning right on a ccw ring = reflex
  return { m, k: 1 / Math.max(1e-6, cosHalf), n1, n2, reflex: turn < -1e-12 };
}

/** The ring (counter-clockwise) moved d metres inward, mitred; see the header. */
export function erode(ring, d, { mitreLimit = 3 } = {}) {
  const R = ccw(clean(ring, 1e-6));
  if (!(d > 0)) return [R];
  const clips = [];
  for (let i = 0; i < R.length; i++) {
    const a = R[i], b = R[(i + 1) % R.length], n = inwardN(a, b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
    // the band either side of the edge (never collinear with the outline itself: polyclip's weak case)
    clips.push([[a[0] - n[0] * d, a[1] - n[1] * d], [b[0] - n[0] * d, b[1] - n[1] * d], [b[0] + n[0] * d, b[1] + n[1] * d], [a[0] + n[0] * d, a[1] + n[1] * d]]);
  }
  for (let i = 0; i < R.length; i++) {
    const { m, k, n1, n2, reflex } = mitreAt(R, i);
    if (!reflex) continue; // a convex corner: the two bands meet in the mitre already
    const v = R[i], kk = Math.min(k, mitreLimit);
    // the mitre's kite, from behind the corner (outside the outline) to the mitre point
    clips.push([[v[0] - m[0] * d, v[1] - m[1] * d], [v[0] + n2[0] * d, v[1] + n2[1] * d], [v[0] + m[0] * d * kk, v[1] + m[1] * d * kk], [v[0] + n1[0] * d, v[1] + n1[1] * d]].reverse());
  }
  const g = differenceOf(R, clips.map(ccw));
  const out = [];
  for (const poly of polysOf(g.geometry)) {
    const r = ccw(clean(poly[0].slice(0, -1).map(([x, z]) => [x - g.shift[0], z - g.shift[1]]), 1e-3));
    if (r.length >= 3 && Math.abs(signedArea(r)) > 1e-4) out.push(r);
  }
  // a stable order: by the lowest x then z of each ring (polyclip's own order is stable too, but say so here)
  return out.sort((p, q) => minKey(p) - minKey(q));
}
/** polyclip's difference of the subject ring minus the clip rings. polyclip-ts can stop with "Unable to complete output ring"
 * on near-coincident edges; then it is asked again with the clips merged first, then with everything moved by a fixed
 * sub-millimetre offset (and moved back), the same attempts in the same order each time (deterministic). */
function differenceOf(subject, clipRings) {
  const tries = [[0, 0, false], [0, 0, true], [3.1e-4, 1.7e-4, false], [3.1e-4, 1.7e-4, true], [-2.3e-4, 4.1e-4, true]];
  let last = null;
  for (const [dx, dz, merged] of tries) {
    const mv = (r) => closed(r.map(([x, z]) => [x + dx, z + dz]));
    try {
      let clips = clipRings.map((c) => turf.polygon([mv(c)]));
      if (merged && clips.length > 1) { const u = turf.union(turf.featureCollection(clips)); clips = u ? [u] : []; }
      const geometry = clips.length ? turf.difference(turf.featureCollection([turf.polygon([mv(subject)]), ...clips]))?.geometry : turf.polygon([mv(subject)]).geometry;
      return { geometry, shift: [dx, dz] };
    } catch (e) { last = e; }
  }
  throw new Error(`clip.js: polyclip failed (${last?.message})`);
}
const minKey = (r) => { let b = Infinity; for (const [x, z] of r) b = Math.min(b, x * 1e6 + z); return b; };

/** Every vertex moved d metres along its mitre (see the header); null when any edge would turn over or shrink below 20 %. */
export function offsetSmall(ring, d, { mitreLimit = 4 } = {}) {
  if (d === 0) return ring.map((p) => [p[0], p[1]]);
  const out = ring.map((p, i) => { const { m, k } = mitreAt(ring, i), s = d * Math.min(k, mitreLimit); return [p[0] + m[0] * s, p[1] + m[1] * s]; });
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], p = out[i], q = out[(i + 1) % ring.length];
    const dot = (b[0] - a[0]) * (q[0] - p[0]) + (b[1] - a[1]) * (q[1] - p[1]), l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    if (!(dot > 0.2 * l2)) return null;
  }
  return out;
}

/** The polygon (outer ring) minus the hole rings: [[outer, ...holes], ...] (rings open, counter-clockwise outers). */
export function subtract(outer, holes) {
  const g = differenceOf(outer, holes);
  return polysOf(g.geometry).map((poly) => poly.map((r) => r.slice(0, -1).map(([x, z]) => [x - g.shift[0], z - g.shift[1]])));
}

/**
 * Earcut (three.js ShapeUtils.triangulateShape) over an outer ring and its holes, keeping every point: earcut drops points
 * that lie on a straight run (a densified edge), which would leave them as T-junctions against the strips that share the
 * ring; each triangle edge along such a run takes the dropped points back and the triangle is fanned from its corner.
 * -> [[a, b, c], ...] indices into [...outer, ...holes.flat()].
 */
export function triangulate(THREE, outer, holes = []) {
  const rings = [outer, ...holes], start = []; let n = 0;
  for (const r of rings) { start.push(n); n += r.length; }
  const pts = rings.flat(), ringOf = new Int32Array(n);
  rings.forEach((r, k) => { for (let i = 0; i < r.length; i++) ringOf[start[k] + i] = k; });
  const tris = THREE.ShapeUtils.triangulateShape(outer.map(([x, z]) => new THREE.Vector2(x, z)), holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z))));
  const onSeg = (p, a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz; if (!l2) return false;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2;
    return t > 1e-9 && t < 1 - 1e-9 && Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / Math.sqrt(l2) < 1e-6;
  };
  // the ring points strictly between i and j along the ring (either way round) when all of them lie on segment i-j
  const between = (i, j) => {
    if (ringOf[i] !== ringOf[j]) return [];
    const k = ringOf[i], s = start[k], len = rings[k].length, a = pts[i], b = pts[j];
    for (const step of [1, -1]) {
      const out = []; let p = s + ((i - s + step + len) % len), ok = true;
      while (p !== j) { if (!onSeg(pts[p], a, b)) { ok = false; break; } out.push(p); p = s + ((p - s + step + len) % len); }
      if (ok && out.length) return out;
    }
    return [];
  };
  const out = [];
  // a triangle with dropped points on an edge is fanned from the opposite corner; the two outer pieces still hold the other
  // two edges, which are split the same way in turn
  const split = (a, b, c, depth) => {
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const mid = depth < 64 ? between(p, q) : [];
      if (!mid.length) continue;
      const chain = [p, ...mid, q];
      for (let e = 0; e + 1 < chain.length; e++) split(r, chain[e], chain[e + 1], depth + 1);
      return;
    }
    out.push([a, b, c]);
  };
  for (const [a, b, c] of tris) split(a, b, c, 0);
  return out;
}

/** Whether the rings are all simple and apart: no two edges cross or touch (a ring's neighbouring edges share their point
 * and nothing more), no point within `eps` of an edge it is not on. Edges are bucketed on a grid. */
export function ringsClear(rings, eps = 1e-6) {
  const E = [];
  rings.forEach((r, k) => { for (let i = 0; i < r.length; i++) E.push({ k, i, n: r.length, a: r[i], b: r[(i + 1) % r.length] }); });
  if (!E.length) return true;
  let span = 0; for (const e of E) span = Math.max(span, Math.abs(e.b[0] - e.a[0]), Math.abs(e.b[1] - e.a[1]));
  const C = Math.max(0.05, span), cells = new Map();
  E.forEach((e, idx) => {
    for (let x = Math.floor((Math.min(e.a[0], e.b[0]) - eps) / C); x <= Math.floor((Math.max(e.a[0], e.b[0]) + eps) / C); x++)
      for (let z = Math.floor((Math.min(e.a[1], e.b[1]) - eps) / C); z <= Math.floor((Math.max(e.a[1], e.b[1]) + eps) / C); z++) {
        const key = `${x},${z}`; let l = cells.get(key); if (!l) cells.set(key, (l = [])); l.push(idx);
      }
  });
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const pd = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };
  for (const list of cells.values()) for (let u = 0; u < list.length; u++) for (let v = u + 1; v < list.length; v++) {
    const e = E[list[u]], f = E[list[v]];
    if (e.k === f.k && (Math.abs(e.i - f.i) === 1 || Math.abs(e.i - f.i) === e.n - 1)) continue; // neighbours share a point
    if (o(e.a, e.b, f.a) * o(e.a, e.b, f.b) < 0 && o(f.a, f.b, e.a) * o(f.a, f.b, e.b) < 0) return false;
    if (pd(f.a, e.a, e.b) < eps || pd(f.b, e.a, e.b) < eps || pd(e.a, f.a, f.b) < eps || pd(e.b, f.a, f.b) < eps) return false;
  }
  return true;
}
