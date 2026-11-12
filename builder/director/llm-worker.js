// llm-worker.js: the Web Worker that holds the language model (WebLLM 0.2.88, vendor/web-llm-0.2.88), so loading and
// generating never run on the page's main thread and the page never parses the 6.8 MB runtime.
// The page talks to it with four plain messages; what comes back from a decision is a string and a few numbers:
//   -> { type: 'load', spec, warm }         spec = one of lib/director/tier.mjs MODELS (pinned URLs, SRI on the library);
//                                           warm = a decide request, run before "ready" (see warmUp)
//   <- { type: 'progress', progress, text } | { type: 'ready', loadMs, warmMs, mode, warmUp, cached, downloadBytes } | { type: 'error', message }
//   -> { type: 'decide', n, req }           req = { system, user, schema, grammar, seed, maxTokens, temperature }
//   <- { type: 'answer', n, mode, prefix, text, tokens, promptTokens, tokensPerSecond, prefillTokensPerSecond, ttftMs, ms } | { type: 'fail', n, message }
//   -> { type: 'busy', on }                 the page's frame meter: while on, tokens are paced (schedule.mjs createPacer)
//   -> { type: 'interrupt' } | { type: 'unload' }
// The answer is constrained by a grammar (see MODES below); each call is a fresh two-message chat, thinking off.
import { MLCEngine, hasModelInCache } from '../../vendor/web-llm-0.2.88/index.js';
import { withoutRuntimePrefix } from '../../lib/director/model-output.mjs';
import { parseDecision } from '../../lib/director/schema.mjs';
import { createPacer } from '../../lib/director/schedule.mjs';

let engine = null, spec = null, pageBusy = false;
// pageBusy: the page's frame meter says the scene is struggling (builder/director/boot.js); the token loop then waits a beat
// between tokens so the GPU is not held for the whole decision (lib/director/schedule.mjs)
const pacer = createPacer({ busy: () => pageBusy });
const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 300);

async function cachedBytes() {
  let n = 0;
  try {
    for (const name of await caches.keys()) {
      if (!/^webllm\//.test(name)) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (!req.url.startsWith(spec.url) && req.url !== spec.lib) continue;
        const res = await cache.match(req);
        n += Number(res?.headers.get('content-length')) || 0;
      }
    }
  } catch { /* the Cache API can be off (private windows): the size is then unknown */ }
  return n;
}

async function load(s, warm) {
  spec = s;
  const appConfig = { model_list: [{ model: s.url, model_id: s.id, model_lib: s.lib, integrity: { model_lib: s.libIntegrity, onFailure: 'error' },
    overrides: { context_window_size: 4096, conv_config: { stop_token_ids: s.stopTokenIds } } }] };
  const t0 = performance.now();
  let cached = false;
  try { cached = await hasModelInCache(s.id, appConfig); } catch { /* unknown */ }
  engine = new MLCEngine({ appConfig, initProgressCallback: (r) => postMessage({ type: 'progress', progress: r.progress, text: String(r.text).slice(0, 200) }) });
  await engine.reload(s.id);
  const loadMs = Math.round(performance.now() - t0);
  let warmUpTried = [];
  if (warm) { postMessage({ type: 'progress', progress: 1, text: 'Warming up: the first decision compiles the GPU pipelines' }); warmUpTried = await warmUp(warm); }
  postMessage({ type: 'ready', loadMs, warmMs: Math.round(performance.now() - t0) - loadMs, mode: MODES[mode], warmUp: warmUpTried, cached, downloadBytes: await cachedBytes() });
}

// How the answer is constrained, best first. The worker settles on a mode during the warm-up, by trying each on a real
// decision and keeping the first whose answer passes the page's own strict check (lib/director/schema.mjs):
//   grammar  our compact EBNF (schema.mjs decisionGrammar): no whitespace, about a third fewer tokens. Written without a
//            GPU to try it on; if XGrammar refuses it, or what it yields fails the check, the next mode is used
//   schema   the JSON Schema: seen working on a real GPU (RTX 4090, 12 Nov 2026), about 130 tokens a decision
//   plain    any JSON object (the page still checks every answer)
// Thinking is off (enable_thinking: false). WebLLM does that by prefixing a fixed empty think block to the assistant's
// turn and returns it with the message; model-output.mjs takes exactly that prefix off, and nothing else.
const MODES = ['grammar', 'schema', 'plain'];
let mode = 0;
const format = (req, m) => (MODES[m] === 'grammar' && req.grammar ? { type: 'grammar', grammar: req.grammar }
  : MODES[m] === 'plain' ? { type: 'json_object' } : { type: 'json_object', schema: JSON.stringify(req.schema) });

const messagesOf = (req) => [{ role: 'system', content: req.system }, { role: 'user', content: req.user }];
const paramsOf = (req, m) => ({ messages: messagesOf(req), response_format: format(req, m), seed: req.seed, max_tokens: req.maxTokens, temperature: req.temperature ?? 0.9, top_p: 0.95, extra_body: { enable_thinking: false } });
const answerOf = (m, t0, content, finish, u) => {
  const x = u.extra || {}, { text, prefix } = withoutRuntimePrefix(content);
  return { mode: MODES[m], prefix, text, finish, tokens: u.completion_tokens | 0, promptTokens: u.prompt_tokens | 0, tokensPerSecond: x.decode_tokens_per_s || 0,
    prefillTokensPerSecond: x.prefill_tokens_per_s || 0, ttftMs: Math.round((x.time_to_first_token_s || 0) * 1000), ms: Math.round(performance.now() - t0) };
};

// A decision streams its tokens, and between them the pacer waits when the page is busy. One long uninterrupted decode
// holds the GPU the scene draws on (frame spikes up to 583 ms were measured); with gaps the frames fit in between.
// The warm-up (no scene yet) and a runtime that will not stream use the plain call.
async function generate(req, m, { paced = true } = {}) {
  const t0 = performance.now();
  if (paced) {
    try {
      const stream = await engine.chat.completions.create({ ...paramsOf(req, m), stream: true, stream_options: { include_usage: true } });
      let content = '', finish = null, usage = null, i = 0;
      for await (const ch of stream) {
        const c = ch.choices?.[0];
        if (c?.delta?.content) { content += c.delta.content; i++; }
        if (c?.finish_reason) finish = c.finish_reason;
        if (ch.usage) usage = ch.usage;
        await pacer.pace(i);
      }
      return answerOf(m, t0, content, finish, usage || { completion_tokens: i });
    } catch (err) { if (/interrupt/i.test(short(err))) throw err; /* a runtime that cannot stream with this mode: the plain call */ }
  }
  const out = await engine.chat.completions.create(paramsOf(req, m));
  return answerOf(m, t0, out.choices?.[0]?.message?.content ?? '', out.choices?.[0]?.finish_reason ?? null, out.usage || {});
}

// The first generation after a load is slow (34 s to the first token on an RTX 4090: the GPU pipelines are compiled
// then). So the load is not "ready" until a real decision has run here; the rules director answers meanwhile. The same
// warm-up picks the mode: each is tried once, and the first whose answer is a valid decision is kept.
async function warmUp(req) {
  const tried = [];
  for (let m = 0; m < MODES.length; m++) {
    if (MODES[m] === 'grammar' && !req.grammar) continue;
    try {
      const r = await generate(req, m, { paced: false });
      const ok = parseDecision(r.text, { lines: req.lines }).ok;
      tried.push({ mode: MODES[m], ok, ms: r.ms, tokens: r.tokens, ...(ok ? {} : { text: r.text.slice(0, 160) }) });
      if (ok) { mode = m; return tried; }
    } catch (err) { tried.push({ mode: MODES[m], ok: false, error: short(err).slice(0, 160) }); }
  }
  mode = MODES.indexOf('schema');      // nothing passed: keep the mode seen working on a GPU; the rules cover bad answers
  return tried;
}

async function decide(n, req) {
  postMessage({ type: 'answer', n, ...(await generate(req, mode)) });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') await load(m.spec, m.warm);
    else if (m.type === 'decide') { try { await decide(m.n, m.req); } catch (err) { postMessage({ type: 'fail', n: m.n, message: short(err) }); } }
    else if (m.type === 'busy') pageBusy = !!m.on;
    else if (m.type === 'interrupt') engine?.interruptGenerate();
    else if (m.type === 'unload') { await engine?.unload(); engine = null; }
  } catch (err) { postMessage({ type: 'error', message: short(err) }); }
};
