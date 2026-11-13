// director.mjs: the loop. Every tick (5 s by default) the director
//   1 reads the game state (state.mjs) and draws the mood card for this stretch of the fight (seeded)
//   2 asks the model for one decision, with the fixed prompt, the compact grammar (and the JSON Schema, for a runtime
//     that refuses the grammar) and a seed; waits at most timeoutMs
//   3 checks the answer (schema.mjs); a late, failed or malformed answer is dropped and the rules decide instead
//   4 checks a taunt's two lines (banter.mjs); a bad line is replaced from the bank
//   5 passes the actions through the guard (guard.mjs: cooldowns, enemy cap, mercy) and hands the game what is left
//   6 keeps a record: who decided (model or rules), the one-line why, what was applied, what was refused and why
// A waves game can have the model think ahead: prepare() during the 3-2-1 before wave 1 (see prepare).
// The gate (setGate): a waves game closes it while a wave is being fought, so the model never generates beside the fight
// (the generation shares the GPU with the scene: 1 frame in 10 hitched, 12 Nov 2026). Closed, no request is started
// (prepare() does nothing, a tick or a line falls to the rules and the bank), and a generation in flight is interrupted.
// The model is an object with decide() and interrupt() (builder/director/webllm-model.js in the page, mock-model.mjs in
// CI); it can be set after a lazy load with setModel(). The game is two functions: getState() and apply(action).
// Seeded: the mood sequence and the rules' dice come from `seed`, and the model is given seed-derived sampling seeds,
// so one seed replays a run on the rules or the mock, and different seeds give different runs.
import { DEFAULT_ZONES, decisionSchema, decisionGrammar, banterGrammar, parseDecision, toActions } from './schema.mjs';
import { createGuard } from './guard.mjs';
import { normaliseState, summarise } from './state.mjs';
import { rulesDecision, MOODS } from './rules.mjs';
import { checkLine, pickLine, resolveLine, banterSchema, parseBanter, toVoiceLine, CUES } from './banter.mjs';
import { systemPrompt, userPrompt, BANTER_SYSTEM, banterPrompt } from './prompt.mjs';
import { mulberry32, pick } from './rng.mjs';
import { directorSettings, limitsFor } from './settings.mjs';
import { yieldToMain } from './schedule.mjs';

const LOG_MAX = 50, MOOD_TICKS = 3;
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 100);

export function describe(a) {
  if (a.type === 'spawn_ghosts') return `spawn ${a.count} @ ${a.zone}`;
  if (a.type === 'set_tactic') return `tactic ${a.tactic}`;
  if (a.type === 'sandstorm') return `${a.intensity} sandstorm${a.seconds ? ` ${a.seconds} s` : ''}`;
  if (a.type === 'taunt') return `${a.speaker}: "${a.en}"`;
  return String(a && a.type);
}

export function createDirector({ getState, apply, seed = 1, model = null, zones = DEFAULT_ZONES, limits, intervalMs = 5000, timeoutMs = 4000,
  maxTokens = 110, temperature = 0.9, now = clock, onRecord = null, settings = null, lines = null, busy: sceneBusy = null } = {}) {
  seed = (Number(seed) >>> 0) || 1;
  // a world's settings (the AI Director behaviour) shape the limits; with none, the defaults apply unchanged
  const set = settings ? directorSettings(settings) : null;
  const guard = createGuard({ limits: set ? limitsFor(set, limits || {}) : limits, zones });
  const aggression = set ? set.aggression : null;
  // written (default): the model picks what a line is about and the line comes from the written bank; generated: it writes it
  lines = lines === 'generated' || (lines === null && set?.lines === 'generated') ? 'generated' : 'written';
  const system = systemPrompt({ lines, zones });
  const moodRng = mulberry32(seed), rng = mulberry32(seed ^ 0x9e3779b9), lineRng = mulberry32(seed ^ 0x85ebca6b);
  const schema = decisionSchema(zones, { lines }), grammar = decisionGrammar(zones, { lines });
  const log = [];
  let tickNo = 0, mood = null, busy = false, open = true, timer = null, ticking = false, lineNo = 0, lastLine = null, prepared = null;

  // a model call: started, then waited for up to a deadline. A late answer is dropped, and the model is not asked again
  // until it has finished (busy).
  function startCall(req) {
    if (!open) throw new Error('a wave is being fought: the model generates only in the gaps');
    if (busy) throw new Error('model still busy with the last answer');
    busy = true;
    const call = Promise.resolve().then(() => model.decide(req));
    call.then(() => { busy = false; }, () => { busy = false; });
    return call;
  }
  async function within(call, ms, used) {
    let handle;
    const late = new Promise((_, reject) => { handle = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
    try { return await Promise.race([call, late]); }
    catch (e) { if (/timed out/.test(e.message)) { try { used.interrupt?.(); } catch { /* the runtime's own trouble */ } } throw e; }
    finally { clearTimeout(handle); }
  }
  const callSeed = (n) => ((Math.imul(seed, 1000003) + n) >>> 0) % 2147483647;
  // the mood card of decision n: a new one every MOOD_TICKS decisions, drawn once (prepare() and tick() ask for the same n)
  const moods = new Map();
  function moodFor(n) {
    if (!moods.has(n)) { const prev = moods.get(n - 1) ?? null; moods.set(n, prev === null || (n - 1) % MOOD_TICKS === 0 ? pick(moodRng, MOODS.filter((m) => m !== prev)) : prev); moods.delete(n - 4); }
    return moods.get(n);
  }
  const readState = () => { try { return { state: normaliseState(getState()) }; } catch (e) { return { state: normaliseState(null), stateError: short(e) }; } };
  // `busy`: true while the scene is struggling (schedule.mjs createLoadMeter); the model then paces itself between tokens
  const isBusy = () => { try { return !!(sceneBusy && sceneBusy()); } catch { return false; } };
  const request = (summary, n) => ({ system, user: userPrompt(summary), schema, grammar, lines, seed: callSeed(n), maxTokens, temperature, throttle: isBusy() });

  /**
   * Think ahead. Beside a 3D scene a decision takes about 3.5 s and sometimes over 6 (the GPU is shared; measured 12 Nov
   * 2026), more than the quiet seconds between waves. So a waves game calls prepare() while the wave is still running
   * (about 70% cleared, or when its last ghost has spawned): the model starts on the next decision from the state at
   * that moment. The next tick() / decide() then commits that answer if it has arrived and still passes the guard against
   * the state at the commit; otherwise the rules answer. -> true when a thought was started.
   */
  function prepare() {
    if (!model || busy || prepared || !open) return false;
    const n = tickNo + 1, { state } = readState();
    const summary = summarise(state, { cooldowns: guard.cooldowns(now() / 1000), mood: moodFor(n), aggression });
    try { prepared = { n, t0: clock(), used: model, summary, call: startCall(request(summary, n)) }; } catch { return false; }
    const mine = prepared; mine.done = false;
    mine.call.then(() => { mine.done = true; }, () => { mine.done = true; });
    mine.call.catch(() => {});                       // read at the commit; an early failure must not be an unhandled rejection
    return true;
  }

  /** Open or close the gate. Closing interrupts a generation in flight and drops a thought still being made (one that has
   * already arrived is kept: it costs the GPU nothing). */
  function setGate(on) {
    on = !!on; if (on === open) return open;
    open = on;
    if (!open) {
      if (prepared && !prepared.done) prepared = null;
      if (busy) { try { model?.interrupt?.(); } catch { /* the runtime's own trouble */ } }
    }
    return open;
  }

  async function tick() {
    const n = ++tickNo, t = now() / 1000;
    mood = moodFor(n);
    const { state, stateError } = readState();
    const cooldowns = guard.cooldowns(t);
    const summary = summarise(state, { cooldowns, mood, aggression });
    const rec = { tick: n, t: Math.round(t * 10) / 10, wave: state.wave, source: 'rules', modelId: null, prepared: false, mood, why: '', applied: [], rejected: [], summary, ms: 0, tokens: 0, tokensPerSecond: 0 };
    if (stateError) rec.stateError = stateError;

    let decision = null, call = null, t0 = clock(), used = model;
    if (prepared && prepared.n === n) { ({ call, t0, used } = prepared); rec.prepared = true; rec.readAt = prepared.summary; }   // thought ahead, from the earlier state
    prepared = null;
    try {
      if (!call && used) call = startCall(request(summary, n));
      if (call) {
        const res = await within(call, timeoutMs, used);
        rec.ms = Math.round(clock() - t0);
        await yieldToMain();                           // the answer's parsing is its own task, not part of the message handler's
        const p = parseDecision(res && res.text, { zones, lines });
        if (!p.ok) throw new Error(p.errors.join('; '));
        decision = p.decision;
        rec.source = 'model'; rec.modelId = used.id;
        rec.tokens = (res.tokens | 0) || Math.ceil(String(res.text).length / 4);
        rec.tokensPerSecond = Math.round((res.tokensPerSecond > 0 ? res.tokensPerSecond : rec.tokens / Math.max(rec.ms, 1) * 1000) * 10) / 10;
      }
    } catch (e) { rec.ms = Math.round(clock() - t0); rec.fallback = short(e); }
    if (!decision) decision = rulesDecision(state, rng, { mood, zones, cooldowns, aggression: aggression ?? 0.5, speakers: guard.limits.speakers });
    rec.why = decision.why;
    await yieldToMain();

    const actions = toActions(decision);
    for (const a of actions) {
      if (a.type !== 'taunt') continue;
      if (a.about !== undefined) {                     // by topic: the written line, in both languages
        let line = resolveLine(a.speaker, a.about, state, lineRng);
        if (line.en === lastLine) line = resolveLine(a.speaker, a.about, state, lineRng);   // one more draw rather than the same line twice running
        delete a.about; a.en = line.en; a.ar = line.ar; lastLine = line.en;
        continue;
      }
      const c = checkLine(a);
      if (c.ok) { a.en = c.en; a.ar = c.ar; continue; }
      rec.rejected.push({ action: { ...a }, reason: `line failed the check (${c.errors[0]}): bank line used` });
      Object.assign(a, pickLine(a.speaker, 'taunt', lineRng));
    }
    const g = guard.check(actions, state, t);
    rec.rejected.push(...g.rejected);
    for (const a of g.applied) {
      try { apply(a); rec.applied.push(a); }
      catch (e) { rec.rejected.push({ action: a, reason: `the game refused it: ${short(e)}` }); }
    }
    await yieldToMain();                               // applying to the game and the panel's DOM are separate tasks
    rec.line = `#${n} ${rec.source === 'model' ? (rec.prepared ? 'AI (thought ahead)' : 'AI') : 'rules'} · ${mood} · ${rec.applied.map(describe).join(', ') || 'hold'} — ${rec.why}`;
    log.push(rec); if (log.length > LOG_MAX) log.shift();
    if (onRecord) { try { onRecord(rec); } catch { /* a panel error must not stop the director */ } }
    return rec;
  }

  /** One line for a speaker at a cue (CUES), outside the tick: from the model when it gives a clean one, else the bank. */
  async function say(speaker, cue = 'taunt') {
    speaker = speaker === 'djinn' ? 'djinn' : 'nemesis';
    if (!guard.limits.speakers.includes(speaker)) return null;   // this world switched the speaker off
    cue = CUES.includes(cue) ? cue : 'taunt';
    let line = null, source = 'bank';
    if (model && lines === 'generated') {              // only a world that asked for generated lines has the model write one
      try {
        let state; try { state = normaliseState(getState()); } catch { state = normaliseState(null); }
        const res = await within(startCall({ system: BANTER_SYSTEM[speaker], user: banterPrompt(cue, summarise(state, { cooldowns: {}, mood: mood || 'patient' })), schema: banterSchema(), grammar: banterGrammar(), seed: callSeed(0x10000 + lineNo), maxTokens: 80, temperature }), timeoutMs, model);
        const p = parseBanter(res && res.text);
        if (p.ok) { line = p.line; source = 'model'; }
      } catch { /* the bank answers */ }
    }
    if (!line) line = pickLine(speaker, cue, lineRng);
    const id = `${speaker}-d-${String(++lineNo).padStart(4, '0')}`;
    return { speaker, cue, en: line.en, ar: line.ar, source, voice: toVoiceLine({ id, speaker, en: line.en, ar: line.ar }) };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { if (ticking) return; ticking = true; tick().finally(() => { ticking = false; }); }, intervalMs);
  }
  function stop() { clearInterval(timer); timer = null; }
  return { tick, decide: tick, prepare, say, start, stop, settings: set, lines, setGate, get gateOpen() { return open; }, setModel: (m) => { model = m || null; }, model: () => model, log: () => log.slice(), cooldowns: () => guard.cooldowns(now() / 1000), seed, zones, limits: guard.limits, get running() { return !!timer; } };
}
