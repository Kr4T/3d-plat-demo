// parts.mjs: one material zone of an r187 city generator's geometry, as its own geometry. r187 example:
// webgpu_generator_city (the city generators bake a `partId` per vertex, CityGeneratorUtils.part, and dress the merged
// geometry with one material that branches on it). A component gives each zone its own material slot (spec §5.2), so
// the geometry is partitioned by that same partId: the triangles of one zone, their vertices compacted, every attribute
// copied unchanged. No vertex is moved and none is made.

/** The triangles of `geometry` (indexed, with a `partId` attribute) whose vertices carry partId === id. */
export function zoneOf(THREE, geometry, id) {
  const index = geometry.index, part = geometry.getAttribute('partId');
  if (!index || !part) throw new Error('zoneOf: the geometry needs an index and a partId attribute');
  const remap = new Map(), keep = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (part.getX(a) !== id) continue;
    for (const v of [a, b, c]) { if (!remap.has(v)) remap.set(v, remap.size); keep.push(remap.get(v)); }
  }
  const out = new THREE.BufferGeometry(), order = [...remap.keys()];
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const n = attr.itemSize, data = new attr.array.constructor(order.length * n);
    order.forEach((v, i) => { for (let k = 0; k < n; k++) data[i * n + k] = attr.array[v * n + k]; });
    out.setAttribute(name, new THREE.BufferAttribute(data, n, attr.normalized));
  }
  out.setIndex(keep);
  return out;
}
