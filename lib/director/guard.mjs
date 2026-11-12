// guard.mjs: what the model asks for is not what the game gets. The guard holds the game's limits and is the last
// word on every action, whoever proposed it (the model or the rules):
// The limits follow Encore's design (Kr4T/3DPLAT docs/design/2026-11-encore.md, section 4); a world's settings move them.
// Not here: "nothing inside 6 m of the hero" is the game's rule, since only the game knows where a zone's points are.
//   cooldowns   a spawn every 6 s, a tactic change every 8 s, a sandstorm every 45 s, a line every 10 s
//   enemy cap   a spawn is trimmed to what fits under maxEnemies, or refused
//   mercy       under a quarter health: no new ghosts, and a heavy storm becomes a light one (he may still gloat)
//   settings    an action kind or a speaker the world switched off (settings.mjs)
//   no-ops      the tactic already in use, a storm while one blows, a zone or an action type it does not know
// check() returns what to apply and, for the debug panel, what was refused or trimmed and why.
import { DEFAULT_ZONES, TACTICS, MAX_SPAWN } from './schema.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  maxEnemies: 10, maxSpawn: MAX_SPAWN, mercyHp: 0.25,   // Encore's design: 10 ghosts alive on desktop, 6 on a phone
  cooldown: Object.freeze({ spawn: 6, tactic: 8, sandstorm: 45, taunt: 10 }),   // seconds
  stormSeconds: Object.freeze({ light: 8, heavy: 14 }),
  allowed: Object.freeze(['spawn_ghosts', 'set_tactic', 'sandstorm', 'taunt']),   // a world can switch kinds off (settings.mjs)
  speakers: Object.freeze(['nemesis', 'djinn']),
});
export const PHONE_LIMITS = Object.freeze({ maxEnemies: 6 });

export function createGuard({ limits = {}, zones = DEFAULT_ZONES } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits, cooldown: { ...DEFAULT_LIMITS.cooldown, ...(limits.cooldown || {}) }, stormSeconds: { ...DEFAULT_LIMITS.stormSeconds, ...(limits.stormSeconds || {}) } };
  const last = { spawn: -Infinity, tactic: -Infinity, sandstorm: -Infinity, taunt: -Infinity };
  const KIND = { spawn: 'spawn_ghosts', tactic: 'set_tactic', sandstorm: 'sandstorm', taunt: 'taunt' };
  const left = (k, t) => Math.max(0, Math.ceil(L.cooldown[k] - (t - last[k])));
  const cd = (k, t) => (L.allowed.includes(KIND[k]) ? left(k, t) : -1);

  /** Seconds until each kind of action is allowed again (0 = ready; -1 = switched off for this world). */
  const cooldowns = (t) => ({ spawn: cd('spawn', t), tactic: cd('tactic', t), sandstorm: cd('sandstorm', t), taunt: cd('taunt', t) });

  /** actions (from schema.mjs toActions), the normalised state, the time in seconds -> { applied, rejected: [{ action, reason }] } */
  function check(actions, state, t) {
    const applied = [], rejected = [];
    const no = (action, reason) => rejected.push({ action, reason });
    const hurt = state.player.hp / state.player.hpMax < L.mercyHp;
    const seen = new Set();
    for (const a of Array.isArray(actions) ? actions : []) {
      const type = a && typeof a.type === 'string' ? a.type : '';
      if (seen.has(type)) { no(a, 'one of each kind per decision'); continue; }
      seen.add(type);
      if (Object.values(KIND).includes(type) && !L.allowed.includes(type)) { no(a, 'switched off for this world'); continue; }
      if (type === 'spawn_ghosts') {
        if (!zones.includes(a.zone) || !Number.isInteger(a.count) || a.count < 1) { no(a, 'unknown zone or count'); continue; }
        if (left('spawn', t) > 0) { no(a, `spawn cooldown (${left('spawn', t)} s)`); continue; }
        let count = Math.min(a.count, L.maxSpawn);
        if (count < a.count) no(a, `at most ${L.maxSpawn} at once here: ${count} instead of ${a.count}`);
        if (hurt) { no(a, `mercy: player under ${Math.round(L.mercyHp * 100)}% health, no new ghosts`); continue; }
        const room = L.maxEnemies - state.enemies.count;
        if (room <= 0) { no(a, `enemy cap (${L.maxEnemies}) reached`); continue; }
        if (count > room) { no({ ...a, count }, `enemy cap (${L.maxEnemies}): ${room} instead of ${count}`); count = room; }
        applied.push({ type, zone: a.zone, count }); last.spawn = t;
      } else if (type === 'set_tactic') {
        if (!TACTICS.includes(a.tactic)) { no(a, 'unknown tactic'); continue; }
        if (a.tactic === state.tactic) { no(a, `already ${a.tactic}`); continue; }
        if (left('tactic', t) > 0) { no(a, `tactic cooldown (${left('tactic', t)} s)`); continue; }
        applied.push({ type, tactic: a.tactic }); last.tactic = t;
      } else if (type === 'sandstorm') {
        if (a.intensity !== 'light' && a.intensity !== 'heavy') { no(a, 'unknown storm level'); continue; }
        if (state.storm) { no(a, 'a storm is already blowing'); continue; }
        if (left('sandstorm', t) > 0) { no(a, `sandstorm cooldown (${left('sandstorm', t)} s)`); continue; }
        let intensity = a.intensity;
        if (hurt && intensity === 'heavy') { no(a, `mercy: player under ${Math.round(L.mercyHp * 100)}% health, a light storm instead`); intensity = 'light'; }
        applied.push({ type, intensity, seconds: L.stormSeconds[intensity] }); last.sandstorm = t;
      } else if (type === 'taunt') {
        if (a.speaker !== 'nemesis' && a.speaker !== 'djinn') { no(a, 'unknown speaker'); continue; }
        if (!L.speakers.includes(a.speaker)) { no(a, `${a.speaker} does not speak in this world`); continue; }
        if (left('taunt', t) > 0) { no(a, `line cooldown (${left('taunt', t)} s)`); continue; }
        applied.push({ type, speaker: a.speaker, en: a.en, ar: a.ar }); last.taunt = t;
      } else no(a, 'unknown action');
    }
    return { applied, rejected };
  }
  return { check, cooldowns, limits: L };
}
