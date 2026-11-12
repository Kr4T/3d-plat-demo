// banter.mjs: short in-character lines for the nemesis and the djinn, in Arabic and English.
//   LINES      a hand-written bank per speaker and cue; used by the rules director and whenever a generated line fails
//              the check. The Arabic is Modern Standard Arabic written by the worker, NOT yet read by a native speaker.
//   checkLine  what a generated line must pass before it is shown: both languages present, at most 90 characters, the
//              English in Latin letters, the Arabic in Arabic letters (a small model that drifts mixes scripts), no links,
//              none of the words on the content rule's list (religion, politics, profanity)
//   toVoiceLine the line in the talk worker's voice-line format (assets/voice/<character>/<id>.json: text, timed
//              subtitles in both languages), with audio: null and generated: true, so the TTS pipeline can voice it later
import { sanitizeLine, parseStrict, LINE_MAX } from './schema.mjs';
import { pick } from './rng.mjs';

export const CUES = Object.freeze(['taunt', 'player_hurt', 'ghost_killed', 'storm', 'greeting']);
const L = (en, ar) => Object.freeze({ en, ar });
export const LINES = Object.freeze({
  nemesis: Object.freeze({
    taunt: [L('The sand remembers you.', 'الرمل يتذكّرك.'), L('You walk on my desert.', 'أنت تمشي على صحرائي.'), L('Every dune here obeys me.', 'كل كثيب هنا يطيعني.'), L('Run. The ghosts enjoy a chase.', 'اهرب. الأشباح تحب المطاردة.')],
    player_hurt: [L('You bleed like the rest.', 'تنزف مثل غيرك.'), L('Kneel, and it ends quickly.', 'اركع، وينتهي الأمر سريعاً.'), L('Is that all your strength?', 'أهذه كل قوتك؟')],
    ghost_killed: [L('I have more than you can count.', 'عندي أكثر مما تستطيع عدّه.'), L('One grain from a whole desert.', 'حبة رمل من صحراء كاملة.'), L('They rise again. You will not.', 'هم ينهضون من جديد. أنت لن تنهض.')],
    storm: [L('Let the wind bury you.', 'لتدفنك الريح.'), L('The storm answers my call.', 'العاصفة تلبّي ندائي.'), L('Breathe sand, little one.', 'تنفّس الرمل أيها الصغير.')],
    greeting: [L('So you finally came.', 'إذن جئت أخيراً.'), L('Welcome to your grave.', 'أهلاً بك في قبرك.'), L('I have waited a long time.', 'انتظرتك طويلاً.')],
  }),
  djinn: Object.freeze({
    taunt: [L('Oh, this will be fun.', 'آه، سيكون هذا ممتعاً.'), L('I bet on the ghosts.', 'أراهن على الأشباح.'), L('Careful, he hates losing.', 'احذر، هو يكره الخسارة.')],
    player_hurt: [L('That looked painful.', 'يبدو أن ذلك مؤلم.'), L('Still standing? Impressive.', 'ما زلت واقفاً؟ مدهش.'), L('A wish would help now.', 'أمنية واحدة كانت ستنفعك الآن.')],
    ghost_killed: [L('Nicely done, mortal.', 'أحسنت أيها الفاني.'), L('He will not like that.', 'لن يعجبه ذلك.'), L('One less. A thousand more.', 'نقص واحد. وبقي ألف.')],
    storm: [L('Hold on to your head.', 'أمسك رأسك جيداً.'), L('I love this weather.', 'أحب هذا الطقس.'), L('Close your eyes. Or do not.', 'أغمض عينيك. أو لا تفعل.')],
    greeting: [L('A visitor. After a thousand years.', 'زائر. بعد ألف عام.'), L('Wishes cost extra at dusk.', 'الأماني أغلى عند الغروب.'), L('Do not mind the ghosts.', 'لا تهتم بالأشباح.')],
  }),
});

// the nemesis on how the player plays (state.player.style): the game names the style, these are the known ones
export const STYLE_LINES = Object.freeze({
  melee: [L('You love to stand close. Good.', 'تحب الاقتراب. جيد.'), L('Swing all you like.', 'اضرب كما تشاء.')],
  ranged: [L('You fight from far away. Coward.', 'تقاتل من بعيد. يا جبان.'), L('Distance will not save you.', 'المسافة لن تنقذك.')],
  runner: [L('Run. I am everywhere.', 'اهرب. أنا في كل مكان.'), L('You cannot outrun the sand.', 'لن تسبق الرمل.')],
  camper: [L('Still hiding in that corner?', 'ما زلت مختبئاً في تلك الزاوية؟'), L('Come out. The show needs you.', 'اخرج. العرض يحتاجك.')],
});

// the nemesis on what the player just did: Encore's six written lines (Kr4T/3DPLAT docs/design/2026-11-encore.md, section 4).
// The Arabic is the design lead's first draft in Saudi dialect, "Kereem to approve" before any line is voiced. Keyed by
// the event type the game reports in state.events (the names are this worker's proposal to the combat worker), except
// low_health, which the rules read from the player's health.
export const EVENT_LINES = Object.freeze({
  triple_kill: L('Three? I have a desert of them.', 'ثلاثة؟ عندي صحراء كاملة منهم.'),
  camped_wave: L('Hiding by the water. Sensible. Camels do the same.', 'متخبّي عند الماء؟ عاقل. الإبل تسوّي كذا بعد.'),
  flawless_wave: L('Stop dancing and bleed.', 'خلّ الرقص وانزف.'),
  hit_from_behind: L('Behind you. It is always behind you.', 'وراك. دايم وراك.'),
  low_health: L('The crowd came for a show. Give them an ending.', 'الجمهور جاي يشوف عرض. عطهم النهاية.'),
  set_cleared: L('Enjoy the dusk. The night is mine.', 'استمتع بالغروب. الليل لي.'),
});

/** A bank line for the speaker and cue, picked with the seeded rng; an unknown cue gives a taunt. */
export function pickLine(speaker, cue, rng) {
  const who = LINES[speaker] || LINES.nemesis;
  return pick(rng, who[cue] || who.taunt);
}

/**
 * The written line for a taunt the model (or the rules) asked for by topic: schema.mjs ABOUT. last_event: the nemesis on
 * what the player just did (EVENT_LINES; low health counts); player_style: the nemesis on how they play (STYLE_LINES);
 * the rest are the bank's cues. When there is nothing to say on the topic, a plain taunt. Both languages are hand-written.
 */
export function resolveLine(speaker, about, state, rng) {
  if (speaker === 'nemesis' && about === 'last_event') {
    const hurt = state.player.hp / state.player.hpMax < 0.25;
    const ev = hurt ? 'low_health' : [...state.events].reverse().find((e) => EVENT_LINES[e.type] && state.t - e.t <= 15)?.type;
    if (ev) return EVENT_LINES[ev];
  }
  if (speaker === 'nemesis' && about === 'player_style' && STYLE_LINES[state.player.style]) return pick(rng, STYLE_LINES[state.player.style]);
  return pickLine(speaker, CUES.includes(about) ? about : 'taunt', rng);
}

const letters = (s) => s.match(/\p{L}/gu) || [];
const LINK = /https?:|www\.|[a-z0-9-]+\.(com|net|org|io|ai|sa|ae)\b/i;
// Encore's content rule: no religion, no politics, no real people, no profanity. A coarse word list, not a moderation
// model: it catches the obvious, and a caught line falls back to a written one.
const BANNED_EN = /\b(god|gods|allah|prophet|quran|koran|bible|jesus|christ\w*|islam\w*|muslim\w*|jew\w*|heaven|hell|pray\w*|president|king|prince|minister|government|election|fuck\w*|shit\w*|bitch\w*|bastard\w*|damn\w*|whore\w*)\b/i;
const BANNED_AR = /الله|اللّه|رب[ّ]?ي|النبي|الرسول|القرآن|الإسلام|مسلم|يهود|نصار|الجنة|جهنم|الملك|الأمير|الرئيس|الحكومة|الوزير|لعن|كلب|حمار|عاهر/u;
/** { ok, en, ar, errors }: the cleaned line, or why it may not be shown. */
export function checkLine(line) {
  const en = sanitizeLine(line && line.en, 400), ar = sanitizeLine(line && line.ar, 400), errors = [];
  const one = (name, text, script, label) => {
    const ls = letters(text);
    if (ls.length < 2) errors.push(`${name}: empty`);
    else if (Array.from(text).length > LINE_MAX) errors.push(`${name}: longer than ${LINE_MAX} characters`);
    else if (!ls.every((c) => script.test(c))) errors.push(`${name}: not all in ${label} letters`);
    if (LINK.test(text)) errors.push(`${name}: holds a link`);
    if ((name === 'en' ? BANNED_EN : BANNED_AR).test(text)) errors.push(`${name}: a word the content rule does not allow`);
  };
  one('en', en, /\p{Script=Latin}/u, 'Latin');
  one('ar', ar, /\p{Script=Arabic}/u, 'Arabic');
  return errors.length ? { ok: false, errors } : { ok: true, en, ar };
}

export function banterSchema() {
  return { type: 'object', additionalProperties: false, required: ['en', 'ar'],
    properties: { en: { type: 'string', maxLength: LINE_MAX }, ar: { type: 'string', maxLength: LINE_MAX } } };
}
/** Model text for one line -> { ok, line: { en, ar } } or { ok: false, errors }. */
export function parseBanter(text) {
  const p = parseStrict(text, ['en', 'ar']);
  if (!p.ok) return { ok: false, errors: p.errors };
  const c = checkLine(p.value);
  return c.ok ? { ok: true, line: { en: c.en, ar: c.ar } } : { ok: false, errors: c.errors };
}

const sentences = (s) => s.split(/(?<=[.!?؟…])\s+/u).filter(Boolean);
const words = (s) => s.split(/\s+/).filter(Boolean).length;
/** The line as a voice-line record (the talk worker's format), timed by its length; audio comes later from TTS. */
export function toVoiceLine({ id, speaker, en, ar }) {
  const duration = Math.min(8, Math.max(1.5, 0.6 + 0.38 * Math.max(words(en), words(ar))));
  const E = sentences(en), A = sentences(ar);
  const parts = E.length === A.length && E.length > 1 ? E.map((e, i) => ({ en: e, ar: A[i] })) : [{ en, ar }];
  const total = parts.reduce((n, p) => n + p.en.length, 0) || 1;
  const lead = 0.2, span = duration - lead - 0.1, gap = parts.length > 1 ? 0.15 : 0;
  let at = lead;
  const subtitles = parts.map((p, i) => {
    const len = span * (p.en.length / total);
    const cue = { start: +at.toFixed(2), end: +(at + len - (i < parts.length - 1 ? gap : 0)).toFixed(2), ar: p.ar, en: p.en };
    at += len;
    return cue;
  });
  return { id, character: speaker, audio: null, generated: true, duration_s: +duration.toFixed(2), text: { ar, en }, subtitles };
}
