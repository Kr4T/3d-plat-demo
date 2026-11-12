// layout.mjs: where a scene's pieces stand on the ground, in world metres, for pieces that shape themselves round the rest
// of the scene (the desert terrain's flat clear zones and wet band, builder/sculpt/desert-terrain.js). Pure: no three.js,
// no DOM. The transform is the scene's (lib/solver/solve.mjs rot: about +Y as three.js, yaw mod 2 PI, uniform scale), and
// a size param (`affects: "scale"`) scales the footprint as the runtime scales the instance (lib/runtime/scene-view.mjs
// scaleOf).
//
//   sceneLayout(doc, registry, { except = [] }) -> [{ uid, ref, category, shape: 'polygon' | 'path', points: [[x, z], ...],
//                                                    water, cut? }]
//     areas: their outline (closed polygon) or path (open polyline); pieces: their component's footprint outline, or a
//     1 m square at the anchor when the component has none. Ground areas (category `ground`: the terrain itself, other
//     sands) and the uids in `except` are left out. `water` is true for category `water` areas (the wet band); `cut` is set
//     (true) on a closed area whose module exports `cutsGround = true` (lake-water@2.0.0's basin: the ground opens there).
//     Sorted by uid, coordinates rounded to the millimetre, so equal layouts give equal JSON (the runtime's rebuild key).
//   layoutKey(layout) -> string, stable for equal layouts.

const TAU = Math.PI * 2;
const isPts = (v, min) => Array.isArray(v) && v.length >= min && v.every((q) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]));
const UNIT = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
const mm = (v) => Math.round(v * 1000) / 1000;

function scaleOf(def, params) {
  let k = 1;
  for (const p of def.params || []) {
    const v = Object.hasOwn(params || {}, p.name) ? params[p.name] : p.default;
    if (p.affects === 'scale' && p.type === 'number' && typeof p.default === 'number' && p.default > 0 && typeof v === 'number' && v > 0) k *= v / p.default;
  }
  return k;
}
const paramOf = (def, params, name) => (Object.hasOwn(params || {}, name) ? params[name] : (def.params || []).find((p) => p.name === name)?.default);

export function sceneLayout(doc, registry, { except = [] } = {}) {
  const skip = new Set(except), out = [];
  const place = (t, s) => {
    const p = Array.isArray(t?.p) ? t.p : [0, 0, 0], yaw = (+t?.yaw || 0) - TAU * Math.round((+t?.yaw || 0) / TAU), sc = (+t?.s > 0 ? +t.s : 1) * s;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    return (q) => [mm(p[0] + c * q[0] * sc + sn * q[1] * sc), mm(p[2] - sn * q[0] * sc + c * q[1] * sc)];
  };
  for (const a of Array.isArray(doc?.areas) ? doc.areas : []) {
    if (!a || skip.has(a.uid)) continue;
    const def = registry.get(a.component);
    if (!def || def.category === 'ground') continue;
    const outline = paramOf(def, a.params, 'outline'), path = paramOf(def, a.params, 'path');
    const closed = Object.hasOwn(a.params || {}, 'outline') || (!Object.hasOwn(a.params || {}, 'path') && isPts(outline, 3));
    const pts = closed ? outline : path;
    if (!isPts(pts, closed ? 3 : 2)) continue;
    const e = { uid: a.uid, ref: a.component, category: def.category || null, shape: closed ? 'polygon' : 'path', points: pts.map(place(a.transform, 1)), water: def.category === 'water' };
    if (closed && def.module?.cutsGround === true) e.cut = true; // a basin: the ground opens under its outline (lake-water@2.0.0)
    out.push(e);
  }
  for (const i of Array.isArray(doc?.instances) ? doc.instances : []) {
    if (!i || skip.has(i.uid)) continue;
    const def = registry.get(i.component);
    if (!def || def.category === 'ground') continue;
    const ring = isPts(def.footprint?.outline, 3) ? def.footprint.outline : UNIT;
    out.push({ uid: i.uid, ref: i.component, category: def.category || null, shape: 'polygon', points: ring.map(place(i.transform, scaleOf(def, i.params))), water: false });
  }
  return out.sort((x, y) => (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
}

export const layoutKey = (layout) => JSON.stringify(layout || []);
