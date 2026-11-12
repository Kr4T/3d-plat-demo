// grip.mjs: where a held item is gripped, measured from its own mesh (never tuned by hand per pose). The item lies along its
// longest axis (tools/import-model.mjs lays props flat); that axis is cut into slices and each slice's cross-section measured:
//   guard  the widest slice, at least 1.5x the median width and not at an end (a bar with no guard is refused)
//   hilt   the slices on the guard's short side; the grip is the narrow run of them (the pommel at the end is left out)
//   blade  the long side: its direction, its thin axis (the flat's normal), the tip at its end, the reach from the grip
// positions: Float32Array (x, y, z) in the component's space, metres. -> { center, blade, flat, edge, tip, length, reach }
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function measureGrip(positions, { slices = 40 } = {}) {
  const n = positions.length / 3, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = positions[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const ext = [0, 1, 2].map((k) => mx[k] - mn[k]);
  const a = ext.indexOf(Math.max(...ext)), [b, c] = [0, 1, 2].filter((k) => k !== a);
  const S = Array.from({ length: slices }, () => ({ n: 0, mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] }));
  for (let i = 0; i < n; i++) {
    const s = S[Math.min(slices - 1, Math.floor(((positions[i * 3 + a] - mn[a]) / ext[a]) * slices))];
    s.n++; for (let k = 0; k < 3; k++) { const v = positions[i * 3 + k]; if (v < s.mn[k]) s.mn[k] = v; if (v > s.mx[k]) s.mx[k] = v; }
  }
  const width = S.map((s) => (s.n ? Math.max(s.mx[b] - s.mn[b], s.mx[c] - s.mn[c]) : 0));
  const sorted = width.filter((w) => w > 0).sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)];
  const guard = width.indexOf(Math.max(...width));
  if (!(width[guard] >= 1.5 * median) || guard < 2 || guard > slices - 3) throw new Error('grip: no guard (a widest slice well above the rest, away from the ends)');
  const hiltLow = guard < slices - 1 - guard; // the hilt is on the short side
  const hilt = hiltLow ? S.slice(0, guard) : S.slice(guard + 1).reverse(); // from the end towards the guard
  const hw = hilt.map((s) => (s.n ? Math.max(s.mx[b] - s.mn[b], s.mx[c] - s.mn[c]) : Infinity)), narrow = Math.min(...hw);
  const grip = hilt.filter((s, i) => s.n && hw[i] <= narrow * 1.3);
  const mid = (list, k) => (Math.min(...list.map((s) => s.mn[k])) + Math.max(...list.map((s) => s.mx[k]))) / 2;
  const center = [0, 0, 0]; center[a] = grip.reduce((t, s) => t + (s.mn[a] + s.mx[a]) / 2, 0) / grip.length; center[b] = mid(grip, b); center[c] = mid(grip, c);
  const sign = hiltLow ? 1 : -1, blade = AX[a].map((v) => v * sign);
  const bladeSlices = (hiltLow ? S.slice(guard + 2) : S.slice(0, guard - 1)).filter((s) => s.n);
  const thinB = bladeSlices.filter((s) => s.mx[b] - s.mn[b] < s.mx[c] - s.mn[c]).length;
  const flatAxis = thinB >= bladeSlices.length / 2 ? b : c, edgeAxis = flatAxis === b ? c : b;
  const end = hiltLow ? S[slices - 1] : S[0], tip = [0, 0, 0];
  tip[a] = hiltLow ? mx[a] : mn[a]; tip[b] = (end.mn[b] + end.mx[b]) / 2; tip[c] = (end.mn[c] + end.mx[c]) / 2;
  const r = (v) => +v.toFixed(4);
  return { center: center.map(r), blade, flat: AX[flatAxis], edge: AX[edgeAxis], tip: tip.map(r), length: r(ext[a]), reach: r(Math.abs(tip[a] - center[a])), axis: a };
}
