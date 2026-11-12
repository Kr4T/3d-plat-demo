// near.mjs: which figures the walk's camera is on top of. Pure. A character or an animal whose bounds come within NEAR of
// the camera's near plane is not drawn while it is there (the scene view's veil), so an enemy walking through the camera
// never fills the view with the inside of its clothes. The player himself is the camera's own business
// (lib/walk/controller.mjs followCamera `close`).
//   figure: { uid, p: [x, y, z] (feet), height, radius }: its bounds are the upright capsule of that height and radius
//   nearFigures(cameraPos, figures, { near, margin, was }) -> [uid]
// The distance is from the camera's position to the capsule's surface, less the near plane's distance: under `margin`
// (0.6 m) it is veiled. `was` (the uids veiled on the last frame) get HOLD more before they come back, so a figure at the
// edge does not flicker.
export const NEAR = 0.6, HOLD = 0.25; // metres

/** The distance from a point to an upright capsule's surface (negative inside it). */
export function capsuleDistance(c, f) {
  const r = Math.max(0, +f.radius || 0), h = Math.max(2 * r, +f.height || 0);
  const y = Math.min(f.p[1] + h - r, Math.max(f.p[1] + r, c[1])); // the nearest point of the capsule's axis
  return Math.hypot(c[0] - f.p[0], c[1] - y, c[2] - f.p[2]) - r;
}

export function nearFigures(cameraPos, figures = [], { near = 0.5, margin = NEAR, was = null } = {}) {
  const held = was instanceof Set ? was : new Set(was || []);
  const out = [];
  for (const f of figures) {
    if (!f || !Array.isArray(f.p) || !f.p.every(Number.isFinite)) continue;
    if (capsuleDistance(cameraPos, f) - near < margin + (held.has(f.uid) ? HOLD : 0)) out.push(f.uid);
  }
  return out;
}
