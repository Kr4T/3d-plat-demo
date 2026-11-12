// player.mjs: the `player` behaviour (behaviours/player/behaviour.json; targets character). The item that carries it is the
// one Walk mode drives (builder/walk.js through lib/walk/session.mjs playerItem: its component, where it stands, and these
// params: runSpeed, jump, cameraDistance). Outside Walk it does nothing; its handle holds the live params, so a change in
// the tuning card reaches a walk in progress (walk.js reads handle.params each frame).
export function attach(ctx, item, params = {}) {
  const handle = {
    uid: item.uid, params: { ...params },
    onParams(p) { handle.params = { ...p }; ctx?.walk?.retune?.(item.uid, handle.params); },
    dispose() { handle.params = null; },
  };
  return handle;
}
