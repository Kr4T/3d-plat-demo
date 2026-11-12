// rules.mjs: the rules director. It answers a decision in the same shape as the model's, from the state, the mood card
// and the seeded rng, with no model: on a phone without WebGPU, while the model downloads, and whenever a model answer
// is late or fails the check. Simple on purpose: read health and the enemy count, then let the mood and the dice vary it.
import { DEFAULT_ZONES } from './schema.mjs';
import { pick, int, chance } from './rng.mjs';
import { STYLE_LINES, EVENT_LINES } from './banter.mjs';
import { phaseOfDay } from './state.mjs';

export const MOODS = Object.freeze(['patient', 'cruel', 'trickster', 'storm_caller', 'showman']);
const OTHER = { flank: 'swarm', swarm: 'flank', retreat: 'flank' };

export function rulesDecision(s, rng, { mood = 'patient', zones = DEFAULT_ZONES, cooldowns = {}, aggression = 0.5, speakers = ['nemesis', 'djinn'] } = {}) {
  const hp = s.player.hp / s.player.hpMax, n = s.enemies.count;
  const ready = (k) => !cooldowns[k];              // 0 or missing: ready; above 0: cooling down; -1: switched off
  const push = 0.5 + aggression;                   // 0.5 .. 1.5
  const far = zones.filter((z) => z !== s.player.zone);
  let zone = pick(rng, far.length ? far : zones);
  let count = 0, tactic = 'keep', sandstorm = 'none', why, cue = 'taunt', strong = false, even = false;
  const night = ['night', 'dusk'].includes(phaseOfDay(s.hour));

  if (hp < 0.25) {
    tactic = s.tactic === 'retreat' ? 'keep' : 'retreat';
    why = 'player is nearly down: pull the ghosts back'; cue = 'player_hurt';
  } else if (n === 0) {
    count = int(rng, 2, 4) + (mood === 'cruel' ? 1 : 0);
    tactic = mood === 'trickster' ? 'flank' : pick(rng, ['swarm', 'flank']);
    cue = 'greeting';
  } else if (n >= 8) {
    tactic = chance(rng, 0.6) ? OTHER[s.tactic] : 'keep';
    why = tactic === 'keep' ? 'plenty of ghosts out: let them work' : `plenty of ghosts out: switch to ${tactic}`;
  } else if (hp > 0.6) {
    count = int(rng, 1, mood === 'cruel' ? 4 : 3);
    tactic = chance(rng, mood === 'trickster' ? 0.7 : 0.35) ? OTHER[s.tactic] : 'keep';
    if (ready('sandstorm') && !s.storm && chance(rng, ((mood === 'storm_caller' ? 0.5 : 0.1) + (night ? 0.1 : 0)) * push)) sandstorm = chance(rng, 0.4) ? 'heavy' : 'light';
    strong = true;
    if (sandstorm !== 'none') cue = 'storm';
  } else {
    count = mood === 'patient' ? 0 : int(rng, 0, 2);
    tactic = chance(rng, 0.3) ? OTHER[s.tactic] : 'keep';
    even = true;
    if (s.events.some((e) => e.type === 'ghost_killed' && s.t - e.t <= 10)) cue = 'ghost_killed';
  }
  if (count > 0) count = Math.min(6, Math.max(1, Math.round(count * push)));
  if (!ready('spawn')) count = 0;
  if (!ready('tactic')) tactic = 'keep';
  if (!ready('sandstorm')) sandstorm = 'none';
  // the why is written after the trims, so the line says what was asked for
  if (cue === 'greeting') why = count ? `the field is empty: ${count} ghosts from ${zone}` : 'the field is empty: wait for the next opening';
  else if (strong) why = sandstorm !== 'none' ? `player is strong: a ${sandstorm} storm${count ? ` and ${count} more from ${zone}` : ''}` : count ? `player is strong: ${count} more from ${zone}` : 'player is strong: hold and look for an opening';
  else if (even) why = count ? `an even fight: ${count} more from ${zone} to keep the pressure` : 'an even fight: wait and watch';

  let taunt = { speaker: 'none', about: 'taunt' };
  if (ready('taunt') && speakers.length && chance(rng, mood === 'showman' ? 0.75 : 0.35)) {
    const want = cue === 'player_hurt' || cue === 'ghost_killed' ? pick(rng, ['djinn', 'djinn', 'nemesis']) : pick(rng, ['nemesis', 'nemesis', 'djinn']);
    const speaker = speakers.includes(want) ? want : speakers[0];
    // the nemesis first on what the player just did (Encore's written lines), then on how they play, then the bank
    const did = speaker === 'nemesis' ? (hp < 0.25 ? 'low_health' : [...s.events].reverse().find((e) => EVENT_LINES[e.type] && s.t - e.t <= 15)?.type) : null;
    const styled = speaker === 'nemesis' && STYLE_LINES[s.player.style] && chance(rng, 0.6);
    taunt = { speaker, about: did ? 'last_event' : styled ? 'player_style' : cue };   // the line itself: banter.mjs resolveLine
  }
  return { why: why.slice(0, 120), spawn: { zone, count }, tactic, sandstorm, taunt };
}
