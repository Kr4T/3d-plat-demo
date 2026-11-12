// waves.mjs: the waves game as pure rules (the `waves` world behaviour, lib/behaviours/waves.mjs, runs them). No three, no DOM.
//   waves      3 by default; wave k sends waveSize(k) enemies (3, 5, 7), plus what the AI director asked for (at most 6)
//   spawning   one at a time, `spawnEvery` seconds apart, never more alive than `cap` (10 on a desktop, 6 on a phone),
//              never within `minDist` 6 m of the player (spawnPoint: a ring 8 to 12 m out, on the side the zone gives)
//   mercy      while the player is under 25 % health no new enemy comes as long as one is alive (with none alive one
//              still comes: the game must be able to end)
//   between    a gap of at most `breakSeconds` 5 s; the behaviour asks the director to decide() at its start and prepare()
//              when 70 % of a wave is down. The next wave starts when the decision is in (decided()), not before a
//              `beat` of 2 s, and at the 5 s deadline whatever happened (the model never answering included)
//   end        won after the last wave, lost when the player dies; restart() is immediate
//   score      seconds fought (breaks not counted) + `hitPenalty` 5 for each hit taken; lower is better; the best run kept
// update(dt, { hp: 0..1 }) returns what happened: { type: 'spawn', zone } | 'prepare' | 'wave_end' { wave, flawless } |
// 'wave_start' { wave, size } | 'won' { score } | 'lost' (from playerDied()).
export const MAX_EXTRA = 6, HIT_PENALTY = 5, MERCY = 0.25, MIN_DIST = 6;
export const capFor = (phone) => (phone ? 6 : 10);
export const waveSize = (k, first = 3, more = 2) => first + (k - 1) * more;
export const scoreOf = ({ time, hitsTaken }, penalty = HIT_PENALTY) => Math.round((time + hitsTaken * penalty) * 10) / 10;

/** The best (lowest) score, kept in a storage that may throw (private mode) or be missing. */
export function createBest(storage, key = '3dplat.waves.best') {
  let mem = null;
  const read = () => { try { const v = parseFloat(storage?.getItem(key)); return Number.isFinite(v) ? v : mem; } catch { return mem; } };
  return {
    get: () => read(),
    offer(score) { const was = read(), isNew = was === null || score < was; if (isNew) { mem = score; try { storage?.setItem(key, String(score)); } catch { /* kept in memory */ } } return { best: isNew ? score : was, isNew }; },
  };
}

/** Hits in a row: `gap` seconds without one, or a hit taken (broken()), starts again. */
export function createComboCounter({ gap = 2.5 } = {}) {
  let n = 0, last = -Infinity, best = 0;
  return {
    hit(t) { n = t - last > gap ? 1 : n + 1; last = t; best = Math.max(best, n); return n; },
    broken() { n = 0; last = -Infinity; },
    value: (t) => (t - last > gap ? 0 : n),
    get best() { return best; },
  };
}

/** Where an enemy appears: [x, z], at least minDist from the player, on the side zone / zones of the compass, spread a little. */
export function spawnPoint({ player, zone = 0, zones = 4, rng = Math.random, minDist = MIN_DIST, ring = [8, 12] }) {
  const a = ((zone % zones) / zones) * Math.PI * 2 + (rng() - 0.5) * 1.2;
  const r = Math.max(minDist + 0.5, ring[0] + rng() * (ring[1] - ring[0]));
  return [player[0] + Math.sin(a) * r, player[1] + Math.cos(a) * r];
}

/** Where an enemy appears when the scene has spawn pieces (uid spawn-<zone>): beside the zone's piece (within `spread`
 * metres); if that is within minDist of the player, beside the piece farthest from him; if none is far enough, the ring. */
export function spawnAt({ player, points, zone = 0, rng = Math.random, minDist = MIN_DIST, spread = 1.5 }) {
  const far = (q) => Math.hypot(q[0] - player[0], q[1] - player[1]);
  const near = (q) => { const a = rng() * Math.PI * 2, r = rng() * spread; return [q[0] + Math.sin(a) * r, q[1] + Math.cos(a) * r]; };
  if (points?.length) {
    const want = points[((zone % points.length) + points.length) % points.length];
    const best = far(want) >= minDist + spread ? want : [...points].sort((a, b) => far(b) - far(a))[0];
    if (far(best) >= minDist + spread) return near(best);
  }
  return spawnPoint({ player, zone, zones: Math.max(1, points?.length || 4), rng, minDist });
}

export function createWaves({ waves = 3, first = 3, more = 2, cap = 10, breakSeconds = 5, beat = 2, spawnEvery = 1.2, mercy = MERCY } = {}) {
  let s;
  const fresh = () => ({ phase: 'idle', wave: 0, size: 0, toSpawn: 0, alive: 0, killed: 0, killedInWave: 0, time: 0, hitsTaken: 0, hitsInWave: 0, breakLeft: 0, decided: false, spawnIn: 0, extra: 0, zone: 0, tactic: 'swarm', prepared: false });
  const begin = (k, out) => { s.wave = k; s.size = waveSize(k, first, more) + s.extra; s.extra = 0; s.toSpawn = s.size; s.killedInWave = 0; s.hitsInWave = 0; s.prepared = false; s.spawnIn = 0; s.phase = 'fighting'; out?.push({ type: 'wave_start', wave: k, size: s.size }); };
  s = fresh();
  return {
    state: () => ({ ...s, waves, cap, score: scoreOf(s) }),
    start() { s = fresh(); const out = []; begin(1, out); return out; },
    restart() { return this.start(); },
    update(dt, { hp = 1 } = {}) {
      const out = [];
      if (s.phase === 'fighting') {
        s.time += dt; s.spawnIn -= dt;
        const held = hp < mercy && s.alive > 0;
        if (s.toSpawn > 0 && s.alive < cap && s.spawnIn <= 0 && !held) { s.toSpawn--; s.alive++; s.spawnIn = spawnEvery; out.push({ type: 'spawn', zone: s.zone }); }
        if (!s.prepared && s.killedInWave >= 0.7 * s.size) { s.prepared = true; out.push({ type: 'prepare', wave: s.wave }); }
        if (s.toSpawn === 0 && s.alive === 0) {
          out.push({ type: 'wave_end', wave: s.wave, flawless: s.hitsInWave === 0 });
          if (s.wave >= waves) { s.phase = 'won'; out.push({ type: 'won', score: scoreOf(s) }); } else { s.phase = 'break'; s.breakLeft = breakSeconds; s.decided = false; }
        }
      } else if (s.phase === 'break') { s.breakLeft -= dt; if (s.breakLeft <= 1e-9 || (s.decided && breakSeconds - s.breakLeft >= beat - 1e-9)) begin(s.wave + 1, out); }
      return out;
    },
    /** The director's decision for the next wave is in (applied through direct()). */
    decided() { if (s.phase === 'break') s.decided = true; },
    kill() { if (s.alive > 0) { s.alive--; s.killed++; s.killedInWave++; } },
    playerHit() { if (s.phase === 'fighting' || s.phase === 'break') { s.hitsTaken++; s.hitsInWave++; } },
    playerDied() { if (s.phase === 'won' || s.phase === 'lost' || s.phase === 'idle') return []; s.phase = 'lost'; return [{ type: 'lost', score: scoreOf(s) }]; },
    /** An action of the AI director (lib/director/schema.mjs): more enemies for the next wave from a zone, or the tactic. */
    direct(a) {
      if (a?.type === 'spawn_ghosts') { s.extra = Math.min(MAX_EXTRA, Math.max(0, Math.round(+a.count || 0))); if (Number.isInteger(a.zone)) s.zone = a.zone; }
      else if (a?.type === 'set_tactic' && ['swarm', 'flank', 'retreat'].includes(a.tactic)) s.tactic = a.tactic;
    },
  };
}
