// schema.mjs: the one thing the model is allowed to write. A decision is a JSON object with exactly five keys, every
// value from a fixed list or a bounded number or a short line of text:
//   { "spawn": { "zone": <zone>, "count": 0-6 }, "tactic": flank|swarm|retreat|keep, "sandstorm": none|light|heavy,
//     "taunt": { "speaker": none|nemesis|djinn, "about": <what the line is about> }, "why": "one line" }
// (with lines "generated", experimental, the taunt is { speaker, en, ar } and the model writes the line itself)
// The same shape is given to the runtime as a JSON Schema (WebLLM compiles it to a grammar, so the model cannot emit
// anything else), and parseDecision checks it again in code: the grammar is a convenience, this file is the rule.
// toActions turns a decision into the game's action list. Nothing here runs, loads or fetches anything the model wrote.
export const DEFAULT_ZONES = Object.freeze(['stage_front', 'boulevard', 'dunes', 'lake_shore'])  // defaults named after the Encore map; a world passes its own;
export const TACTICS = Object.freeze(['flank', 'swarm', 'retreat']);
export const STORMS = Object.freeze(['none', 'light', 'heavy']);
export const SPEAKERS = Object.freeze(['none', 'nemesis', 'djinn']);
export const MAX_SPAWN = 6;
export const WHY_MAX = 120, LINE_MAX = 90;
const MAX_TEXT = 2000;            // a decision is about 300 characters; anything far longer is not one
const NAME = /^[a-z][a-z0-9_]{1,31}$/;
export const isName = (s) => typeof s === 'string' && NAME.test(s);

// newlines and tabs become spaces; other control characters, bidi overrides and isolates, zero-width spaces and angle
// brackets are removed (a line is shown as a subtitle and may be read out; it must not carry markup or flip the text)
const DROP = /[\u0000-\u001F\u007F-\u009F؜​‎‏‪-‮⁦-⁩﻿<>]/g;
/** One clean line of at most `max` characters; '' for anything that is not a string. */
export function sanitizeLine(s, max = LINE_MAX) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/[\n\r\t]+/g, ' ').replace(DROP, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join('').trim();
}

// What a line may be about. In the default mode ("written") the model does not write the line: it picks the speaker and
// one of these, and code takes the line, in both languages, from the written bank (banter.mjs resolveLine). Reason: on a
// real GPU (12 Nov 2026) Qwen3.5-2B and 0.8B both wrote Arabic that was not Arabic and did not match their English.
export const ABOUT = Object.freeze(['taunt', 'player_hurt', 'ghost_killed', 'storm', 'greeting', 'player_style', 'last_event']);
export const LINE_MODES = Object.freeze(['written', 'generated']);   // generated: the model writes en and ar itself (experimental)
const KEYS = ['spawn', 'tactic', 'sandstorm', 'taunt', 'why'];        // "why" last: the reason for the choices just made

/** The JSON Schema of a decision, for the runtime (the fallback to the compact grammar) and for ajv in the tests. */
export function decisionSchema(zones = DEFAULT_ZONES, { lines = 'written' } = {}) {
  const text = (maxLength) => ({ type: 'string', maxLength });
  const oneOf = (list) => ({ type: 'string', enum: [...list] });
  const taunt = lines === 'generated'
    ? { type: 'object', additionalProperties: false, required: ['speaker', 'en', 'ar'], properties: { speaker: oneOf(SPEAKERS), en: text(LINE_MAX), ar: text(LINE_MAX) } }
    : { type: 'object', additionalProperties: false, required: ['speaker', 'about'], properties: { speaker: oneOf(SPEAKERS), about: oneOf(ABOUT) } };
  return {
    type: 'object', additionalProperties: false, required: [...KEYS],
    properties: {
      spawn: { type: 'object', additionalProperties: false, required: ['zone', 'count'],
        properties: { zone: oneOf(zones), count: { type: 'integer', minimum: 0, maximum: MAX_SPAWN } } },
      tactic: oneOf([...TACTICS, 'keep']),
      sandstorm: oneOf(STORMS),
      taunt,
      why: text(WHY_MAX),
    },
  };
}

// ---- the same shape as a compact grammar ----
// The JSON Schema lets the runtime put spaces and newlines between tokens: on a real GPU a decision came to about 130
// tokens, 4.1 s at 35 tokens a second. This EBNF (XGrammar's dialect, response_format type "grammar") describes the one
// compact form, JSON.stringify's: no whitespace, the keys in this order, so every token is content. Seen accepted and
// under 3.5 s a decision on an NVIDIA L4 (12 Nov 2026). A string is any run of characters except the quote, the
// backslash and control characters (one line, no escapes); the reason starts with a letter and is at least 8 characters.
const lit = (s) => JSON.stringify(s);              // an EBNF string literal uses the same escapes as JSON
const anyOf = (list) => list.map(lit).join(' | ');
const TEXT_RULES = 'text ::= char*\nchar ::= [^"\\\\\\x00-\\x1F]';
const WHY_RULE = 'reason ::= [A-Za-z] char char char char char char char char*';
/** The decision as an EBNF grammar; what it accepts, parseDecision accepts (when the lengths and lines check out). */
export function decisionGrammar(zones = DEFAULT_ZONES, { lines = 'written' } = {}) {
  const taunt = lines === 'generated' ? `${lit('","en":"')} text ${lit('","ar":"')} text ${lit('"},"why":"')}` : `${lit('","about":"')} about ${lit('"},"why":"')}`;
  return [
    `root ::= ${lit('{"spawn":{"zone":"')} zone ${lit('","count":')} count ${lit('},"tactic":"')} tactic ${lit('","sandstorm":"')} storm ${lit('","taunt":{"speaker":"')} speaker ${taunt} reason ${lit('"}')}`,
    `zone ::= ${anyOf(zones)}`,
    `count ::= [0-${MAX_SPAWN}]`,
    `tactic ::= ${anyOf([...TACTICS, 'keep'])}`,
    `storm ::= ${anyOf(STORMS)}`,
    `speaker ::= ${anyOf(SPEAKERS)}`,
    ...(lines === 'generated' ? [] : [`about ::= ${anyOf(ABOUT)}`]),
    WHY_RULE,
    TEXT_RULES,
  ].join('\n');
}
/** One line in two languages, { "en": "...", "ar": "..." }, as a compact grammar (banter.mjs; generated lines only). */
export const banterGrammar = () => [`root ::= ${lit('{"en":"')} text ${lit('","ar":"')} text ${lit('"}')}`, TEXT_RULES].join('\n');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x)); };

/** Strict JSON text of the given keys: { ok, value } or { ok: false, errors }. */
export function parseStrict(text, keys) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['empty answer'] };
  if (text.length > MAX_TEXT) return { ok: false, errors: [`answer too long (${text.length} characters)`] };
  let v;
  try { v = JSON.parse(text); } catch (e) { return { ok: false, errors: [`not JSON: ${String(e.message).slice(0, 80)}`] }; }
  if (!isObj(v)) return { ok: false, errors: ['not a JSON object'] };
  if (!sameKeys(v, keys)) return { ok: false, errors: [`keys must be exactly ${keys.join(', ')} (got ${Object.keys(v).slice(0, 8).map((k) => sanitizeLine(k, 20)).join(', ') || 'none'})`] };
  return { ok: true, value: v };
}

// a reason is a sentence: at least three words with letters (the small model once answered ","); else it says so
// and a reason that copies the state line back (seen from the small model: "Player is in t 200 s | midday (12 h) | ...") is not one
const cleanWhy = (w) => { const c = sanitizeLine(w, WHY_MAX); return (c.match(/\p{L}{2,}/gu) || []).length >= 3 && !/\||\bt \d+ s\b/.test(c) ? c : '(no reason given)'; };

/**
 * Model text -> { ok: true, decision } or { ok: false, errors }. The decision is rebuilt field by field from checked
 * values, so nothing the model wrote survives except enum members, one bounded integer and cleaned lines.
 */
export function parseDecision(text, { zones = DEFAULT_ZONES, lines = 'written' } = {}) {
  const p = parseStrict(text, KEYS);
  const gen = lines === 'generated';
  if (!p.ok) return { ok: false, errors: p.errors };
  const v = p.value, errors = [];
  const shown = (x) => sanitizeLine(typeof x === 'string' ? x : JSON.stringify(x) ?? String(x), 24);
  if (typeof v.why !== 'string') errors.push('why: must be text');
  if (!isObj(v.spawn) || !sameKeys(v.spawn, ['zone', 'count'])) errors.push('spawn: must be { zone, count }');
  else {
    if (!zones.includes(v.spawn.zone)) errors.push(`spawn.zone: "${shown(v.spawn.zone)}" is not a zone`);
    if (!Number.isInteger(v.spawn.count) || v.spawn.count < 0 || v.spawn.count > MAX_SPAWN) errors.push(`spawn.count: must be a whole number 0-${MAX_SPAWN}`);
  }
  if (typeof v.tactic !== 'string' || !(TACTICS.includes(v.tactic) || v.tactic === 'keep')) errors.push(`tactic: "${shown(v.tactic)}" is not a tactic`);
  if (typeof v.sandstorm !== 'string' || !STORMS.includes(v.sandstorm)) errors.push(`sandstorm: "${shown(v.sandstorm)}" is not a storm level`);
  if (!isObj(v.taunt) || !sameKeys(v.taunt, gen ? ['speaker', 'en', 'ar'] : ['speaker', 'about'])) errors.push(`taunt: must be ${gen ? '{ speaker, en, ar }' : '{ speaker, about }'}`);
  else {
    if (typeof v.taunt.speaker !== 'string' || !SPEAKERS.includes(v.taunt.speaker)) errors.push(`taunt.speaker: "${shown(v.taunt.speaker)}" is not a speaker`);
    if (gen && (typeof v.taunt.en !== 'string' || typeof v.taunt.ar !== 'string')) errors.push('taunt.en and taunt.ar: must be text');
    if (!gen && (typeof v.taunt.about !== 'string' || !ABOUT.includes(v.taunt.about))) errors.push(`taunt.about: "${shown(v.taunt.about)}" is not something a line can be about`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, decision: {
    why: cleanWhy(v.why),
    spawn: { zone: v.spawn.zone, count: v.spawn.count },
    tactic: v.tactic, sandstorm: v.sandstorm,
    // the lines keep up to 200 characters here so banter.mjs checkLine can refuse a long one instead of cutting it mid-word
    taunt: gen ? { speaker: v.taunt.speaker, en: sanitizeLine(v.taunt.en, 200), ar: sanitizeLine(v.taunt.ar, 200) } : { speaker: v.taunt.speaker, about: v.taunt.about },
  } };
}

/** A decision as the game's actions, in a fixed order; the quiet values (0, keep, none) make no action. */
export function toActions(d) {
  const out = [];
  if (d.spawn.count > 0) out.push({ type: 'spawn_ghosts', zone: d.spawn.zone, count: d.spawn.count });
  if (d.tactic !== 'keep') out.push({ type: 'set_tactic', tactic: d.tactic });
  if (d.sandstorm !== 'none') out.push({ type: 'sandstorm', intensity: d.sandstorm });
  // a taunt carries either the line (en, ar) or what it is about; the director turns `about` into a written line
  if (d.taunt.speaker !== 'none') out.push(d.taunt.about !== undefined ? { type: 'taunt', speaker: d.taunt.speaker, about: d.taunt.about } : { type: 'taunt', speaker: d.taunt.speaker, en: d.taunt.en, ar: d.taunt.ar });
  return out;
}
