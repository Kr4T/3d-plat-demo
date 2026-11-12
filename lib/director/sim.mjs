// sim.mjs: a stand-in game for the director, until the combat worker's game is connected (window.__director.connect).
// It is NOT the game: a seeded, headless toy with a player, a ghost count, a tactic, a storm timer and a clock, enough
// for the director to have something to read and change. The debug panel says "simulated" while it is in use.
import { mulberry32, pick, chance } from './rng.mjs';
import { DEFAULT_ZONES } from './schema.mjs';

export function createSim({ seed = 1, zones = DEFAULT_ZONES, hour = 17 } = {}) {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const s = { t: 0, player: { x: 0, z: 0, hp: 100, hpMax: 100, zone: zones[0] }, enemies: { count: 0 }, hour, tactic: 'swarm', storm: false, events: [] };
  let stormLeft = 0;
  const event = (type) => { s.events.push({ t: s.t, type }); if (s.events.length > 8) s.events.shift(); };
  const HIT = { swarm: 0.05, flank: 0.07, retreat: 0.01 }, KILL = { swarm: 0.22, flank: 0.16, retreat: 0.08 };

  function apply(a) {
    if (a.type === 'spawn_ghosts') { s.enemies.count += a.count; event('ghosts_spawned'); }
    else if (a.type === 'set_tactic') s.tactic = a.tactic;
    else if (a.type === 'sandstorm') { s.storm = true; stormLeft = a.seconds; event('storm_started'); }
    else if (a.type === 'taunt') event('taunt_heard');
  }
  /** Advance by dt seconds, in whole-second steps. */
  function step(dt) {
    for (let k = 0; k < Math.round(dt); k++) {
      s.t += 1; s.hour = (s.hour + 1 / 120) % 24;
      if (s.storm && (stormLeft -= 1) <= 0) { s.storm = false; event('storm_ended'); }
      const n = s.enemies.count;
      if (n > 0 && chance(rng, Math.min(0.6, n * HIT[s.tactic] * (s.storm ? 1.5 : 1)))) { s.player.hp = Math.max(0, s.player.hp - 6); event('player_hit'); }
      if (n > 0 && chance(rng, KILL[s.tactic] * (s.storm ? 0.6 : 1))) { s.enemies.count -= 1; event('ghost_killed'); }
      if (n === 0 || s.tactic === 'retreat') s.player.hp = Math.min(s.player.hpMax, s.player.hp + 1.5);
      if (chance(rng, 0.04)) { s.player.zone = pick(rng, zones); s.player.x = Math.round((rng() - 0.5) * 120); s.player.z = Math.round((rng() - 0.5) * 120); }
      if (s.player.hp <= 0) { s.player.hp = s.player.hpMax; s.enemies.count = 0; event('player_down'); }
    }
  }
  const state = () => JSON.parse(JSON.stringify(s));
  return { state, apply, step, simulated: true };
}
