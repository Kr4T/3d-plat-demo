// default-scene.mjs: which scene the builder opens (Kereem, 12 Nov 2026, on the live page: "the world we built currently
// isn;t there - it's just basic empty"). `/builder/` with no ?scene opens the Encore demo world; `?scene=empty` (the
// "New empty scene" button) opens an empty one; `?scene=<path from the repo root>` any other; a replay opens the scene it
// was recorded on. Pure: used by builder/main.js and by tests/encore.test.mjs.
export const DEFAULT_SCENE = 'scenes/encore.json';
export const EMPTY_SCENE = 'empty';

/** The path of the scene to fetch (from the repo root), or null for an empty scene. `qs` is a URLSearchParams. */
export function scenePathFor(qs, replayScene = null) {
  const asked = qs.get('scene');
  if (asked === EMPTY_SCENE) return null;
  return asked || replayScene || DEFAULT_SCENE;
}

/** An empty scene document at `hour`. */
export const emptyScene = (hour = 21) => ({ format: 'uew-scene@1', environment: { hour }, areas: [], instances: [], meta: { name: 'Untitled scene', made_by: '3DPLAT builder' } });

/** The page URL's query for the other scene: the empty one from a world, the default world from the empty one. Other flags (?q, ?webgl, ?lang) are kept; ?replay and ?hour belong to the scene they were given with and are dropped. */
export function switchSceneQuery(qs) {
  const next = new URLSearchParams(qs);
  next.delete('replay'); next.delete('hour');
  if (qs.get('scene') === EMPTY_SCENE) next.delete('scene'); else next.set('scene', EMPTY_SCENE);
  return next.toString();
}

/**
 * The opening camera of a scene that carries `meta.view` (scenes/scene.schema.json): { p, target } as written for a
 * landscape screen; on a portrait one (aspect < 1) the camera stands further back along the same line, so more of the
 * scene's width stays in the frame (0.9 / aspect, capped at 1.9 x). null when the scene has no view (the page then frames the areas).
 */
export function openingView(doc, aspect = 16 / 10) {
  const v = doc?.meta?.view;
  const vec = (q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite);
  if (!v || !vec(v.p) || !vec(v.target)) return null;
  // a portrait screen: the scene's own portrait view when it has one
  if (aspect < 1 && v.portrait && vec(v.portrait.p) && vec(v.portrait.target)) return { p: [...v.portrait.p], target: [...v.portrait.target] };
  const k = aspect >= 1 ? 1 : Math.min(1.9, 0.9 / Math.max(aspect, 0.1));
  return { p: v.p.map((c, i) => v.target[i] + (c - v.target[i]) * k), target: [...v.target] };
}
