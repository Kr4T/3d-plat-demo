// kerbs.js: the kerbs area piece (a polyline). r187 example: webgpu_generator_city (SidewalkGenerator curbGeometry: a kerb
// profile as a Shape carried along an outline, shaded by its own TSL curb material). Boulevard City's kerbs
// (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/kerbs.js: KERB, kerbGeometry, kerbMaterial, buildKerbs):
// a precast concrete kerbstone 30 cm wide and 15 cm high with a rounded road-side arris (KERB.arris 0.035 m), in 1 m
// stones, its road face grimier. Boulevard instanced one extruded 1 m kerb per straight run; here the same profile is swept
// along the `path` param in one piece: mitred at each corner, u = metres along the path (the stone joints stay 1 m apart and
// never stretch), v = metres across the profile. The look is the `kerb-concrete` preset (slot `stone`).
// High: the full profile, every corner rounded (the arris as Boulevard; the back corner and the two ends rounded at 1 cm and
// 8 mm so the sculpt mesh is smooth, gate.config.json sculpt.maxFaceting). Phone: kerbGeometry('phone')'s cut, the
// battered road face from the foot to the arris end, then the top: two flat faces, no ends.
// The road face is on the path's right-hand side (an outline's outward side when it runs x toward z), the back (the paving)
// on its left; one socket `kerb-run` per segment, facing the paving.
// Contract: build(params, ctx) -> { object, collider, sockets } (lib/runtime/scene-view.mjs); sockets(params).
import { edgeSockets, rightNormal, checkPath } from './outline.js';

export const MODULE = 'builder/sculpt/kerbs.js';
/** kerbs.js KERB: reveal (height) 0.15, width 0.3, arris 0.035, stone 1.0 (metres). */
export const KERB = { reveal: 0.15, width: 0.3, arris: 0.035, stone: 1.0 };
const BACK = 0.012, END = 0.008, ARC = 6, BACK_ARC = 4, END_STEPS = 4; // rounding of the back corner and the ends (m), segments
export const ACCEPTS = ['paving-edge', 'lamp-base']; // components/sockets.json kerb-run

/** The kerb's sockets: one `kerb-run` per path segment, at its midpoint, facing the paving (the path's left). */
export function sockets(params) {
  return edgeSockets(checkPath(params.path, MODULE), { closed: false, face: 'left', type: 'kerb-run', accepts: ACCEPTS, snap: 0.5, y: 0, prefix: 'run' });
}

// a quadratic Bezier (as Shape.quadraticCurveTo) from p0 by the corner c to p1, k = 1..n: [s, y, ns, ny]
function arc(p0, c, p1, n, out) {
  for (let k = 1; k <= n; k++) {
    const t = k / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
    const tx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]), ty = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]), l = Math.hypot(tx, ty) || 1;
    out.push([a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1], ty / l, -tx / l]); // outward: the tangent turned clockwise
  }
}

/** The profile across the kerb as strips of [s, y, ns, ny]; s > 0 toward the road, y up. A strip shares its vertices. */
export function profile(preset, h) {
  const w = KERB.width / 2, r = KERB.arris;
  if (preset === 'phone') { // kerbs.js kerbGeometry('phone'): the road-face foot, the arris end, the back top; flat faces
    const foot = [w, 0], arrisEnd = [w - r, h], back = [-w, h];
    const face = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return [[...a, dy / l, -dx / l], [...b, dy / l, -dx / l]]; };
    return [face(foot, arrisEnd), face(arrisEnd, back)];
  }
  const s = [[w, 0, 1, 0], [w, h - r, 1, 0]];
  arc([w, h - r], [w, h], [w - r, h], ARC, s); // the rounded road-side arris (kerbs.js profile, quadraticCurveTo)
  s.push([-w + BACK, h, 0, 1]);
  arc([-w + BACK, h], [-w, h], [-w, h - BACK], BACK_ARC, s);
  s.push([-w, 0, -1, 0]);
  return [s];
}

/** The swept kerb geometry along a polyline (local metres), tagged userData.sculpt. */
export function kerbGeometry(THREE, path, { preset = 'high', height = KERB.reveal } = {}) {
  let pts = checkPath(path, MODULE);
  const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  if (closed) pts = pts.slice(0, -1);
  const n = pts.length, segs = closed ? n : n - 1;
  const strips = profile(preset, height), ends = preset !== 'phone' && !closed;
  // per path vertex: position, mitre direction m (unit), mitre scale k, metres along the path
  const frames = [];
  let along = 0;
  for (let i = 0; i <= segs; i++) {
    const p = pts[i % n];
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const np = hasPrev ? rightNormal(pts[(i - 1 + n) % n], p) : null, nn = hasNext ? rightNormal(p, pts[(i + 1) % n]) : null;
    let m = np && nn ? [np[0] + nn[0], np[1] + nn[1]] : (np || nn), k = 1;
    const l = Math.hypot(m[0], m[1]);
    if (l < 1e-6) m = np; else { m = [m[0] / l, m[1] / l]; if (np && nn) k = 1 / Math.max(0.25, m[0] * np[0] + m[1] * np[1]); }
    if (i > 0) { const q = pts[(i - 1) % n]; along += Math.hypot(p[0] - q[0], p[1] - q[1]); }
    frames.push({ x: p[0], z: p[1], m, k, u: along });
  }
  const P = [], N = [], U = [], I = [];
  const vert = (x, y, z, nx, ny, nz, u, v) => { const l = Math.hypot(nx, ny, nz) || 1; P.push(x, y, z); N.push(nx / l, ny / l, nz / l); U.push(u, v); return P.length / 3 - 1; };
  const vOf = (strip) => { const v = [0]; for (let j = 1; j < strip.length; j++) v.push(v[j - 1] + Math.hypot(strip[j][0] - strip[j - 1][0], strip[j][1] - strip[j - 1][1])); return v; };
  for (const strip of strips) {
    const v = vOf(strip), rings = [];
    // a ring of the strip: the profile set across the path at a frame, pushed `shift` metres along t, rounded by phi
    const ring = (f, t, shift, phi, uSign = 1) => {
      const c = Math.cos(phi), sn = Math.sin(phi), d = END * (1 - c), ids = [];
      for (let j = 0; j < strip.length; j++) {
        const [s, y, ns, ny] = strip[j], ss = s - ns * d, yy = y - ny * d;
        ids.push(vert(f.x + f.m[0] * ss * f.k + t[0] * shift, yy, f.z + f.m[1] * ss * f.k + t[1] * shift,
          f.m[0] * ns * c + t[0] * sn, ny * c, f.m[1] * ns * c + t[1] * sn, f.u + uSign * shift, v[j]));
      }
      return ids;
    };
    const tan = (i) => { const a = pts[i % n], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    if (ends) { const t = tan(0), back = [-t[0], -t[1]]; for (let s = END_STEPS; s >= 1; s--) { const phi = (s / END_STEPS) * Math.PI / 2; rings.push(ring(frames[0], back, END * Math.sin(phi), phi, -1)); } }
    for (const f of frames) rings.push(ring(f, [0, 0], 0, 0));
    if (ends) { const t = tan(n - 2); for (let s = 1; s <= END_STEPS; s++) { const phi = (s / END_STEPS) * Math.PI / 2; rings.push(ring(frames[frames.length - 1], t, END * Math.sin(phi), phi)); } }
    // the side faces: quads between consecutive rings, facing out of the profile (the profile runs road foot -> top -> back
    // foot, so its outward side is its direction turned clockwise in (s, y); (a, c, b) and (a, d, c) face that way)
    for (let r = 0; r + 1 < rings.length; r++) for (let j = 0; j + 1 < strip.length; j++) {
      const a = rings[r][j], b = rings[r + 1][j], c = rings[r + 1][j + 1], d = rings[r][j + 1];
      I.push(a, c, b, a, d, c);
    }
    // the two end faces: the last rounded ring (normal along the path) closed across its foot
    if (ends) {
      const shrunk = strip.map(([s, y, ns, ny]) => new THREE.Vector2(s - ns * END, y - ny * END));
      const tris = THREE.ShapeUtils.triangulateShape(shrunk, []), first = rings[0], last = rings[rings.length - 1];
      // a counter-clockwise (s, y) triangle faces +t (s runs along the mitre, y up): the end keeps it, the start turns it
      for (const [a, b, c] of tris) {
        if (THREE.ShapeUtils.area([shrunk[a], shrunk[b], shrunk[c]]) > 0) I.push(first[a], first[c], first[b], last[a], last[b], last[c]);
        else I.push(first[a], first[b], first[c], last[a], last[c], last[b]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  // Phone: one vertex per triangle corner, as kerbs.js builds its Phone cut (flat faces, 6 vertices a face), so the cut's
  // hard edges are the original's (the bench compares faceting with the reference on each preset)
  const out = preset === 'phone' ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  return tag(out, height);
}

function tag(g, height) {
  g.userData.sculpt = { module: MODULE, from: 'path' };
  g.userData.profile = 'kerbstone';
  g.userData.area = { module: MODULE, height: [0, height] }; // an area piece, but raised: not a flat surface
  return g;
}

/** One cuboid per segment (rotY about +Y, kept within +-45 degrees by swapping the half extents). */
function colliders(path, h) {
  const pts = checkPath(path, MODULE), out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], len = Math.hypot(bx - ax, bz - az);
    let rotY = -Math.atan2(bz - az, bx - ax), half = [len / 2, h / 2, KERB.width / 2];
    while (rotY > Math.PI / 4 + 1e-9) { rotY -= Math.PI / 2; half = [half[2], half[1], half[0]]; }
    while (rotY < -Math.PI / 4 - 1e-9) { rotY += Math.PI / 2; half = [half[2], half[1], half[0]]; }
    out.push({ type: 'cuboid', pos: [(ax + bx) / 2, h / 2, (az + bz) / 2], half, rotY: Math.abs(rotY) < 1e-12 ? 0 : rotY });
  }
  return out;
}

export async function build(params, ctx) {
  const { THREE } = ctx;
  const height = typeof params.height === 'number' ? params.height : KERB.reveal;
  const mesh = new THREE.Mesh(kerbGeometry(THREE, params.path, { preset: ctx.preset, height }), ctx.slot('stone'));
  mesh.name = 'kerbs'; mesh.receiveShadow = true;
  mesh.userData.sculpt = { module: MODULE, from: 'path' };
  return { object: mesh, collider: colliders(params.path, height), sockets: sockets(params) };
}
