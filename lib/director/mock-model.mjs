// mock-model.mjs: a stand-in for the browser model, for CI and the page's ?director=mock run: no download, no GPU.
// A model is { id, decide({ system, user, schema, seed, maxTokens }) -> { text, tokens, tokensPerSecond? }, interrupt() }.
// With `script` it answers those texts in order (the last one repeats): the tests use this to feed the director good,
// bad and greedy answers. Without, it writes a valid decision (or a line) from a seeded rng, as a small model would.
import { mulberry32, pick, int, chance } from './rng.mjs';
import { TACTICS } from './schema.mjs';
import { LINES } from './banter.mjs';

export function createMockModel({ seed = 1, script = null, delayMs = 0, fail = null, id = 'mock-director-1' } = {}) {
  let i = 0;
  const WHY = ['press while the player is strong', 'keep them guessing', 'thin the pressure for a moment', 'a new angle of attack', 'let the weather do the work'];
  const model = {
    id, calls: [], interrupts: 0,
    async decide(req) {
      model.calls.push(req);
      if (fail) throw fail;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      let text;
      if (script) text = script[Math.min(i++, script.length - 1)];
      else {
        const rng = mulberry32((Math.imul(seed, 2654435761) ^ (req.seed | 0)) >>> 0);
        const zones = req.schema?.properties?.spawn?.properties?.zone?.enum;
        if (zones) {
          const speaker = chance(rng, 0.4) ? pick(rng, ['nemesis', 'djinn']) : 'none';
          const line = speaker === 'none' ? { en: '', ar: '' } : pick(rng, LINES[speaker].taunt);
          const about = req.schema.properties.taunt.properties.about?.enum;
          text = JSON.stringify({ spawn: { zone: pick(rng, zones), count: int(rng, 0, 4) }, tactic: pick(rng, [...TACTICS, 'keep']),
            sandstorm: chance(rng, 0.15) ? pick(rng, ['light', 'heavy']) : 'none', taunt: about ? { speaker, about: pick(rng, about) } : { speaker, en: line.en, ar: line.ar }, why: pick(rng, WHY) });
        } else text = JSON.stringify(pick(rng, /djinn/.test(req.system) ? LINES.djinn.taunt : LINES.nemesis.taunt));
      }
      return { text, tokens: Math.max(1, Math.ceil(String(text).length / 4)), tokensPerSecond: 40 };
    },
    interrupt() { model.interrupts++; },
  };
  return model;
}
