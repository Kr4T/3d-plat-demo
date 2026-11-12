// input.mjs: the walk's input layer (web-game-kit step 3: one layer maps every device to the same actions). Pure: the page
// (builder/walk.js) feeds it the keys held, the touch stick and the camera's yaw. Keys as r187 misc_controls_pointerlock
// (WASD and the arrows by e.code, so any keyboard layout works); he runs by default and Shift sprints; Space jumps; Q (or the left Alt) dodges; E acts on a zone; Escape leaves.

const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
/** What a key does in the walk: 'exit' | 'move' | 'jump' | 'dodge' | 'act' | null (not the walk's). */
export function keyAction(e) {
  if (e.key === 'Escape' || e.code === 'Escape') return 'exit';
  if (MOVE.has(e.code)) return 'move';
  if (e.code === 'Space') return 'jump';
  if (e.code === 'KeyQ' || e.code === 'AltLeft') return 'dodge';
  if (e.code === 'KeyE') return 'act';
  return null;
}

export const STICK_SPRINT = 0.92; // a stick pushed this far sprints (less than that runs, slower the less it is pushed)
export const STICK_RUN = STICK_SPRINT; // the old name

/**
 * The wish, camera-relative on the ground: { mx, mz (length <= 1), sprint }. keys: a Set of e.code held; stick: { x (right),
 * y (forward) } in -1..1; camYaw: the follow camera's yaw (the camera sits at +(sin, cos) * dist from the player, so it
 * looks along -(sin yaw, cos yaw)).
 */
export function wishFrom({ keys = new Set(), stick = null, camYaw = 0, pad = null } = {}) {
  let f = 0, r = 0, sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  if (stick) { f += stick.y || 0; r += stick.x || 0; if (Math.hypot(stick.x || 0, stick.y || 0) >= STICK_SPRINT) sprint = true; }
  if (pad) { f += pad.y || 0; r += pad.x || 0; if (pad.sprint || pad.run) sprint = true; }
  const l = Math.hypot(f, r); if (l > 1) { f /= l; r /= l; }
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  return { mx: f * fx + r * rx, mz: f * fz + r * rz, sprint };
}
