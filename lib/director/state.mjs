// state.mjs: the game state the director reads, made safe, and the one-line summary the model is shown.
// The game hands over { t, player: { x, z, hp, hpMax, zone }, enemies: { count }, hour, tactic, storm, events: [{ t, type }] }.
// Nothing from the game is copied into the prompt as free text: numbers are clamped, and names (zone, event types) are
// kept only when they look like a name ([a-z][a-z0-9_]*), so a string in the state cannot write instructions.
import { TACTICS, isName } from './schema.mjs';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normaliseState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.player && typeof r.player === 'object' ? r.player : {};
  const hpMax = Math.max(1, num(p.hpMax, 100));
  const events = Array.isArray(r.events) ? r.events.filter((e) => e && isName(e.type)).slice(-8).map((e) => ({ t: Math.max(0, num(e.t, 0)), type: e.type })) : [];
  return {
    t: Math.max(0, num(r.t, 0)),
    wave: Number.isInteger(r.wave) && r.wave >= 0 && r.wave < 1000 ? r.wave : null,   // waves games: the wave just finished
    player: { x: num(p.x, 0), z: num(p.z, 0), hp: clamp(num(p.hp, hpMax), 0, hpMax), hpMax, zone: isName(p.zone) ? p.zone : null, style: isName(p.style) ? p.style : null },   // style: how the player has been playing, a name the game chooses (melee, ranged, runner, camper, ...)
    enemies: { count: clamp(Math.round(num(r.enemies && r.enemies.count, 0)), 0, 99) },
    hour: ((num(r.hour, 17) % 24) + 24) % 24,
    tactic: TACTICS.includes(r.tactic) ? r.tactic : 'swarm',
    storm: r.storm === true,
    events,
  };
}

export function phaseOfDay(hour) {
  if (hour < 5 || hour >= 20) return 'night';
  if (hour < 7) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 15) return 'midday';
  if (hour < 16.5) return 'afternoon';
  if (hour < 18.5) return 'golden hour';
  return 'dusk';
}

/** One line, under 480 characters: what the model reads each tick. */
export function summarise(s, { cooldowns = {}, mood = 'patient', aggression = null } = {}) {
  const recent = new Map();
  for (const e of s.events) if (s.t - e.t <= 30) recent.set(e.type, (recent.get(e.type) || 0) + 1);
  const ev = [...recent].slice(-5).map(([k, n]) => `${k} x${n}`).join(', ') || 'nothing';
  const ready = [], wait = [], off = [];
  for (const k of ['spawn', 'tactic', 'sandstorm', 'taunt']) (cooldowns[k] < 0 ? off : cooldowns[k] > 0 ? wait : ready).push(cooldowns[k] > 0 ? `${k} ${cooldowns[k]} s` : k);
  return [
    `t ${Math.round(s.t)} s${s.wave !== null ? `, after wave ${s.wave}` : ''}`,
    `${phaseOfDay(s.hour)} (${Math.round(s.hour * 10) / 10} h)`,
    `player hp ${Math.round(s.player.hp)}/${Math.round(s.player.hpMax)}${s.player.zone ? ` at ${s.player.zone}` : ''}${s.player.style ? `, style ${s.player.style}` : ''}`,
    `enemies ${s.enemies.count}, tactic ${s.tactic}`,
    `storm ${s.storm ? 'on' : 'off'}`,
    `recent: ${ev}`,
    `ready: ${ready.join(', ') || 'nothing'}${wait.length ? `; wait: ${wait.join(', ')}` : ''}${off.length ? `; off: ${off.join(', ')}` : ''}`,
    `mood: ${isName(mood) ? mood : 'patient'}${aggression !== null ? `, aggression ${Math.round(aggression * 100)}%` : ''}`,
  ].join(' | ');
}
