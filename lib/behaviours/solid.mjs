// solid.mjs: the `solid` behaviour (behaviours/solid/behaviour.json; targets piece, character, animal). Every piece is solid
// without it (lib/walk/level.mjs makes its collider from its own data); carrying it with `enabled: false` opts the piece
// out, and `shape: footprint` uses its footprint hull in place of its collider. The level reads these from the document
// (pure, so Node checks the walk); at runtime a change asks the walk to rebuild its level (ctx.physics.rebuild).
export function attach(ctx, item, params = {}) {
  return {
    uid: item.uid, params: { ...params },
    onParams(p) { this.params = { ...p }; ctx?.physics?.rebuild?.(); },
    dispose() { ctx?.physics?.rebuild?.(); },
  };
}
