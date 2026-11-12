// health.mjs: hit points (the health behaviour's state). Pure. Damage lowers hp (never below 0); at 0 the holder is dead and
// takes no more damage or regen. Regen adds `regen` hp a second, from `regenDelay` seconds after the last hit, up to max.
export function createHealth({ hp = 100, max = 100, regen = 0, regenDelay = 2 } = {}) {
  let cur = Math.min(hp, max), dead = cur <= 0, sinceHit = Infinity;
  const api = {
    get hp() { return cur; }, get max() { return max; }, get dead() { return dead; }, get fraction() { return max > 0 ? cur / max : 0; },
    damage(amount, info = {}) {
      if (dead || !(amount > 0)) return { hp: cur, died: false, dealt: 0 };
      const before = cur; cur = Math.max(0, cur - amount); sinceHit = 0;
      if (cur === 0) dead = true;
      return { hp: cur, died: dead, dealt: before - cur, ...info };
    },
    update(dt) { sinceHit += dt; if (!dead && regen > 0 && sinceHit >= regenDelay && cur < max) cur = Math.min(max, cur + regen * dt); return cur; },
    set(p = {}) { if (p.max !== undefined) max = p.max; if (p.regen !== undefined) regen = p.regen; if (p.hp !== undefined) { cur = Math.min(p.hp, max); dead = cur <= 0; } cur = Math.min(cur, max); },
    reset(p = {}) { cur = Math.min(p.hp ?? max, max); dead = cur <= 0; sinceHit = Infinity; },
  };
  return api;
}
