// outline.js: shared maths for the area pieces (builder/sculpt/paving.js, kerbs.js, water.js). r187 example:
// webgpu_generator_city (SidewalkGenerator: a block outline turned into a flat slab with ShapeUtils triangulation, and the
// kerb that rims it). An outline is [[x, z], ...] in metres, local to the instance; a polyline is the same, open.
// Area geometry is flat, with world-space UVs (uv = x, -z in metres, spec §14 item 6), so a texture never stretches when the
// outline is dragged: the material reads positionWorld, and the UV set says the same in the file.

/** The signed area of a closed outline in the x-z plane (positive when it runs x toward z). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x, z] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x * z2 - x2 * z; }
  return a / 2;
}

/** Unit normal of the segment a -> b on its right-hand side (dz, -dx): an outline's outward side when signedArea > 0. */
export function rightNormal(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
}

/**
 * One socket per edge, at the edge's midpoint, level, `dir` across the edge: outward for a closed outline (whichever way
 * it winds), or for an open polyline toward its left-hand side (`face: 'left'`). Ids are `<prefix>-<edge index>`.
 */
export function edgeSockets(pts, { closed = true, type, accepts, snap = 0.5, y = 0, prefix = 'edge', face = 'out' }) {
  const out = [], n = closed ? pts.length : pts.length - 1, sign = closed ? (signedArea(pts) >= 0 ? 1 : -1) : face === 'left' ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], [nx, nz] = rightNormal(a, b);
    out.push({ id: `${prefix}-${i}`, type, pos: [(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2], dir: [nx * sign + 0, 0, nz * sign + 0], accepts: [...accepts], snap });
  }
  return out;
}

/** The outline without repeated points (and without a closing point equal to the first). Throws on a point that is not
 * two finite numbers (NaN, Infinity, strings): a bad outline is refused, never drawn with holes or NaN. */
export function cleanOutline(pts, closed = true, what = closed ? 'outline' : 'path') {
  if (!Array.isArray(pts)) throw new Error(`the ${what} is not a list of [x, z] points`);
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`the ${what} has a point that is not two finite numbers: [${Array.isArray(p) ? p.map(String).join(", ") : String(p)}]`);
    const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  if (closed && out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop();
  return out;
}

// whether segments ab and cd cross or touch (orientation tests, collinear overlap included)
function segmentsMeet(a, b, c, d) {
  const o = (p, q, r) => { const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); return Math.abs(v) < 1e-9 ? 0 : Math.sign(v); };
  const on = (p, q, r) => Math.min(p[0], r[0]) - 1e-9 <= q[0] && q[0] <= Math.max(p[0], r[0]) + 1e-9 && Math.min(p[1], r[1]) - 1e-9 <= q[1] && q[1] <= Math.max(p[1], r[1]) + 1e-9;
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, c, b)) || (o2 === 0 && on(a, d, b)) || (o3 === 0 && on(c, a, d)) || (o4 === 0 && on(c, b, d));
}

/** A closed area outline the area pieces accept: finite points, at least 3 distinct, an area, no edge crossing or touching
 * another (spec Review Focus 3: the piece refuses with a reason). Returns the cleaned points; throws otherwise. */
export function checkOutline(outline, module) {
  const pts = cleanOutline(outline, true, 'outline');
  if (pts.length < 3) throw new Error(`${module}: the outline needs at least 3 distinct points (it has ${pts.length})`);
  if (Math.abs(signedArea(pts)) < 1e-6) throw new Error(`${module}: the outline has no area`);
  const n = pts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a point
    if (segmentsMeet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) throw new Error(`${module}: the outline crosses itself (edges ${i} and ${j})`);
  }
  return pts;
}

/** An open path (kerbs): finite points, at least 2 distinct. Returns the cleaned points; throws otherwise. */
export function checkPath(path, module) {
  const pts = cleanOutline(path, false, 'path');
  if (pts.length < 2) throw new Error(`${module}: the path needs at least 2 distinct points (it has ${pts.length})`);
  return pts;
}

/**
 * A flat surface over a closed outline at height y: triangulated with ShapeUtils (earcut, as ShapeGeometry), normals up,
 * uv = (x, -z) in metres: world space, and the UVs Boulevard's ShapeGeometry of (x, -z) and its rotated ground plane carry.
 * The materials sample their maps at positionWorld.xz, but three.js builds the normal map's tangent frame from the
 * geometry's uv, so the sign of v sets which way the ripples and pavers' relief lean (Task 8 review: uv = (x, z) mirrored
 * them against Boulevard's, which the bench's glint light showed). Returns a BufferGeometry, tagged userData.sculpt.
 */
export function flatArea(THREE, outline, y, module) {
  const pts = checkOutline(outline, module);
  const v2 = pts.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(v2, []);
  const n = pts.length, P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { P[i * 3] = pts[i][0]; P[i * 3 + 1] = y; P[i * 3 + 2] = pts[i][1]; N[i * 3 + 1] = 1; U[i * 2] = pts[i][0]; U[i * 2 + 1] = -pts[i][1]; }
  // faces up (+Y): the triangle (a, b, c) in x-z must turn clockwise seen from above, i.e. negative signed area in (x, z)
  const index = [];
  for (const [a, b, c] of tris) {
    const s = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]);
    if (s > 0) index.push(a, c, b); else index.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setIndex(index);
  g.userData.sculpt = { module, from: 'outline' };
  g.userData.area = { module, height: [y, y] }; // a flat area surface (the page gate's sculpt triangle floor exempts it)
  return g;
}

/** A slab collider under (or around) an outline: the cuboid of its bounds, from y0 to y1 (metres). */
export function boundsCollider(outline, y0, y1, extra = {}) {
  outline = cleanOutline(outline, true);
  const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  return { type: 'cuboid', pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], half: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], ...extra };
}
