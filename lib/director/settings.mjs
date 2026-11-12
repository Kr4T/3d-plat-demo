// settings.mjs: what a creator can set on the "AI Director" behaviour (behaviours/ai_director/behaviour.json), made
// safe, and the game limits those settings give the guard. The director is not tied to one game: a world adds the
// behaviour, sets these, and passes its own zones and state. The action menu is the same four actions in every world.
//   aggression 0..1   how hard the director may push: the enemy cap, the largest spawn, the spawn cooldown, the mercy line
//   speakers          who may speak: both | nemesis | djinn | none
//   spawn, tactics, sandstorm   switch an action kind off for this world
//   pace              timer (a decision every `seconds`) or waves (the game calls decide() between waves)
//   model             auto (by device) | rules | small | full        seed  0 = a new seed each run
//   lines             written (the model picks which hand-written line; default) | generated (the model writes the line
//                     in English and Arabic itself: experimental, the small models' Arabic is not usable, 12 Nov 2026)
//   panel             show the debug panel
import { DEFAULT_LIMITS } from './guard.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ aggression: 0.5, speakers: 'both', spawn: true, tactics: true, sandstorm: true, pace: 'timer', seconds: 6, model: 'auto', lines: 'written', seed: 0, panel: false });
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function directorSettings(p) {
  const r = p && typeof p === 'object' ? p : {}, D = DEFAULT_SETTINGS;
  return {
    aggression: num(r.aggression, 0, 1, D.aggression),
    speakers: oneOf(r.speakers, ['both', 'nemesis', 'djinn', 'none'], D.speakers),
    spawn: bool(r.spawn, D.spawn), tactics: bool(r.tactics, D.tactics), sandstorm: bool(r.sandstorm, D.sandstorm),
    pace: oneOf(r.pace, ['timer', 'waves'], D.pace),
    seconds: num(r.seconds, 3, 30, D.seconds),
    model: oneOf(r.model, ['auto', 'rules', 'small', 'full'], D.model),
    lines: oneOf(r.lines, ['written', 'generated'], D.lines),
    seed: Math.round(num(r.seed, 0, 999999, D.seed)),
    panel: bool(r.panel, D.panel),
  };
}

/** The guard's limits for these settings, on top of `base` (DEFAULT_LIMITS, or a phone's). Aggression 0.5 changes nothing. */
export function limitsFor(settings, base = {}) {
  const s = directorSettings(settings), a = s.aggression, B = { ...DEFAULT_LIMITS, ...base };
  const speakers = s.speakers === 'both' ? ['nemesis', 'djinn'] : s.speakers === 'none' ? [] : [s.speakers];
  const allowed = [s.spawn && 'spawn_ghosts', s.tactics && 'set_tactic', s.sandstorm && 'sandstorm', speakers.length && 'taunt'].filter(Boolean);
  return {
    ...base,
    maxEnemies: Math.max(1, Math.round(B.maxEnemies * (0.5 + a))),
    maxSpawn: Math.min(6, Math.max(1, Math.round(2 + 8 * a))),
    mercyHp: Math.round(B.mercyHp * (1.5 - a) * 1000) / 1000,
    cooldown: { ...(base.cooldown || {}), spawn: Math.round(DEFAULT_LIMITS.cooldown.spawn * (1.5 - a) * 10) / 10 },
    allowed, speakers,
  };
}
