// targets.mjs: which behaviours fit an item (the tuning card's "+ Add behaviour" list, check-patches' rule). A component's
// targets come from what it already says about itself: category `character` is a character, and an animal too when its
// tags say so (the camel, the horse); anything else placed is a piece. 'world' is the scene itself (no item).
export function targetsOf(def) {
  if (!def) return [];
  if (def.category === 'character') return (def.tags?.en || []).includes('animal') ? ['character', 'animal'] : ['character'];
  return ['piece'];
}
/** The registry's behaviours whose targets fit the component (or the world: { world: true }), in the registry's order. */
export function fittingBehaviours(registry, def, { world = false } = {}) {
  const t = world ? ['world'] : targetsOf(def);
  return (registry.behaviours?.() || []).filter((b) => b.targets.some((x) => t.includes(x)));
}
