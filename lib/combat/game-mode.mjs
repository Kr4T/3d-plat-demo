// game-mode.mjs: is this scene a game? PLAY (builder/creative-ui.js) starts game mode (Walk with the builder UI hidden, the
// behaviours' own screen) only then; otherwise PLAY is the clean presentation view, where a tap on a talking character
// plays its line (scenes/talk-demo.json and scenes/small-plaza.json have a player and are not games). A game is a scene
// with a player (an item carrying the Player behaviour) AND the Waves world behaviour. Pure.
export const GAME_BEHAVIOURS = ['waves'];
export function isGame(doc) {
  const player = (doc?.instances || []).some((x) => (x.behaviours || []).some((b) => b.type === 'player'));
  const game = (doc?.world?.behaviours || []).some((b) => GAME_BEHAVIOURS.includes(b.type));
  return player && game;
}

/** ?director=off in the address: no AI director on this page at all (not the page's, not a world's behaviour). */
export function directorOff(search) {
  try { const qs = search instanceof URLSearchParams ? search : new URLSearchParams(typeof search === 'string' ? search : globalThis.location?.search || ''); return (qs.get('director') || '').toLowerCase() === 'off'; } catch { return false; }
}

/** The model's name as people know it: 'Qwen3.5-2B-q4f16_1-MLC' -> 'Qwen3.5-2B' (the quantisation and runtime tags off). */
export const modelName = (id) => String(id || '').replace(/-MLC$/, '').replace(/-q\d[a-z0-9_]*$/i, '');

/** What the game's screen says about who decides between the waves, honestly: 'AI · <model>' only once a real model is
 * loaded and deciding (builder/director/boot.js api.info); 'AI loading 43%' while it downloads (api.loading: the rules
 * decide meanwhile); 'Rules' when the rules decide and nothing is loading (a phone, WebGL); 'Mock (test)' for the test
 * model (?director=mock); null with no director. { kind, en, ar }. */
export function directorBadge(api) {
  if (!api) return null;
  if (api.tier?.tier === 'mock') return { kind: 'mock', en: 'Mock (test)', ar: 'نموذج اختبار' };
  if (api.info?.modelId) { const name = modelName(api.info.modelId); return { kind: 'model', en: `AI · ${name}`, ar: `ذكاء · ${name}` }; }
  if (api.loading) { const pct = Math.max(0, Math.min(100, Math.round((+api.loading.progress || 0) * 100))); return { kind: 'loading', en: `AI loading ${pct}%`, ar: `تحميل الذكاء ${pct}%` }; }
  return { kind: 'rules', en: 'Rules', ar: 'قواعد' };
}
