// panel.js: the director's debug panel and the subtitles, plain DOM (no 3D).
//   createPanel(mount)      the panel: who is deciding (AI model or rules), the model and its load, the last decision as
//                           one line of "why" with the actions applied and the ones refused (and why), the state line the
//                           model read, the last decisions, the measurements, and four buttons. ` or F9 folds it.
//   createSubtitles(mount)  a nemesis or djinn line at the bottom of the view, Arabic (right to left) over English.
// Everything the model wrote reaches the page through textContent only.
import { describe } from '../../lib/director/director.mjs';

const CSS = `
.dir-panel, .dir-subs { --d-ink: var(--ink, #08070c); --d-cream: var(--cream, #f6f1e7); --d-muted: var(--muted, #c4baa9); --d-gold: var(--gold, #e7c26a);
  --d-line: var(--line, rgba(255,255,255,.14)); --d-bad: var(--bad, #ff8a73); --d-ok: var(--ok, #8be0a4);
  --d-display: var(--display, "Chakra Petch", system-ui, sans-serif); --d-body: var(--body, "Inter", system-ui, -apple-system, "Segoe UI", sans-serif); }
.dir-panel { position: fixed; z-index: 40; inset-block-start: max(12px, env(safe-area-inset-top)); inset-inline-end: 12px; inline-size: min(440px, calc(100vw - 24px));
  max-block-size: calc(100dvh - 24px); overflow: auto; padding: 12px 14px 14px; border-radius: 16px; border: 1px solid var(--d-line); color: var(--d-cream);
  background: rgba(12,10,18,.86); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); font: 13px/1.45 var(--d-body); box-shadow: 0 12px 40px rgba(0,0,0,.45); pointer-events: auto; }
.dir-panel * { box-sizing: border-box; }
.dir-panel[data-folded="true"] > :not(.dir-head):not(.dir-now) { display: none; }
.dir-panel[data-folded="true"] .dir-now { margin-block-start: 8px; padding: 0; border: 0; background: none; }
.dir-panel[data-folded="true"] .dir-now > :not(.dir-why) { display: none; }
.dir-panel[data-folded="true"] .dir-why { margin: 0; font-size: 14px; }
.dir-head { display: flex; align-items: center; gap: 6px 8px; flex-wrap: wrap; padding-inline-end: 40px; position: relative; min-block-size: 28px; }
.dir-title { font: 700 13px var(--d-display); letter-spacing: .08em; text-transform: uppercase; color: var(--d-gold); margin-inline-end: auto; }
.dir-badge { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--d-line); font: 600 11px var(--d-display); letter-spacing: .04em; white-space: nowrap; }
.dir-badge[data-kind="model"] { background: var(--d-gold); color: #1b1408; border-color: transparent; }
.dir-badge[data-kind="rules"] { color: var(--d-cream); }
.dir-badge[data-kind="sim"] { color: var(--d-muted); border-style: dashed; }
.dir-fold { position: absolute; inset-block-start: -8px; inset-inline-end: -10px; min-inline-size: 44px; min-block-size: 44px; border: 0; background: none; color: var(--d-muted); font: 700 18px var(--d-display); cursor: pointer; border-radius: 10px; }
.dir-fold:hover, .dir-fold:focus-visible { color: var(--d-cream); background: rgba(255,255,255,.08); outline: none; }
.dir-status { margin-block-start: 8px; color: var(--d-muted); font-size: 12px; }
.dir-bar { block-size: 4px; border-radius: 2px; background: rgba(255,255,255,.1); margin-block-start: 6px; overflow: hidden; }
.dir-bar > i { display: block; block-size: 100%; inline-size: 0; background: var(--d-gold); transition: inline-size .3s; }
.dir-now { margin-block-start: 12px; padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,.05); border: 1px solid var(--d-line); }
.dir-label { font: 600 10px var(--d-display); letter-spacing: .12em; text-transform: uppercase; color: var(--d-muted); }
.dir-why { margin-block: 2px 8px; font: 600 16px/1.3 var(--d-display); color: var(--d-cream); overflow-wrap: anywhere; }
.dir-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dir-chip { padding: 3px 9px; border-radius: 8px; background: rgba(231,194,106,.16); border: 1px solid rgba(231,194,106,.4); font-size: 12px; overflow-wrap: anywhere; }
.dir-chip[data-kind="hold"] { background: none; border-color: var(--d-line); color: var(--d-muted); }
.dir-refused { margin: 8px 0 0; padding: 0; list-style: none; color: var(--d-bad); font-size: 12px; }
.dir-refused li { overflow-wrap: anywhere; }
.dir-note { margin-block-start: 6px; color: var(--d-muted); font-size: 12px; overflow-wrap: anywhere; }
.dir-state { margin-block-start: 10px; color: var(--d-muted); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.dir-log { margin: 10px 0 0; padding: 0; list-style: none; max-block-size: 132px; overflow: auto; font-size: 12px; color: var(--d-muted); }
.dir-log li { padding-block: 2px; border-block-start: 1px solid rgba(255,255,255,.06); overflow-wrap: anywhere; }
.dir-log b { color: var(--d-cream); font-weight: 600; }
.dir-perf { margin-block-start: 10px; font-size: 12px; color: var(--d-cream); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dir-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-block-start: 12px; }
.dir-btn { min-block-size: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--d-line); background: rgba(255,255,255,.06); color: var(--d-cream); font: 600 12px var(--d-display); cursor: pointer; }
.dir-btn:hover, .dir-btn:focus-visible { background: rgba(255,255,255,.14); outline: none; border-color: var(--d-gold); }
.dir-btn[disabled] { opacity: .5; cursor: default; }
.dir-btn[data-primary="true"] { background: var(--d-gold); color: #1b1408; border-color: transparent; }
@media (max-width: 640px) { .dir-panel { inset-block-start: auto; inset-block-end: max(8px, env(safe-area-inset-bottom)); inset-inline: 8px; inline-size: auto; max-block-size: 58dvh; } }
/* in the builder (a page with the PLAY button) the panel starts under the top bar: it never covers the bar's buttons */
@media (min-width: 641px) { body:has(#play):not(.walking):not(.playing) .dir-panel { inset-block-start: calc(max(12px, env(safe-area-inset-top)) + 76px); max-block-size: calc(100dvh - 100px); } }
/* game mode (Walk or Play: body.walking, body.playing): compact and clear of the game's screen. Desktop: bottom left (the
   health bar and waves line are at the top, the key hint in the middle of the bottom). Phone: a small strip top right (the
   Exit chip is top left, the health bar under it, the stick bottom left, the attack buttons bottom right) */
@media (min-width: 641px) { body.walking .dir-panel, body.playing .dir-panel { inset-block-start: auto; inset-block-end: 16px; inset-inline-end: auto; inset-inline-start: 16px; inline-size: min(280px, 22vw); max-block-size: 34dvh; } }
@media (max-width: 640px) { body.walking .dir-panel, body.playing .dir-panel { inset-block-end: auto; inset-block-start: max(10px, env(safe-area-inset-top)); inset-inline-start: auto; inset-inline-end: 8px; inline-size: min(186px, 47vw); max-block-size: 52px; overflow: hidden; padding: 6px 10px; } }
.dir-subs { position: fixed; z-index: 39; inset-inline: 0; inset-block-end: max(9vh, calc(env(safe-area-inset-bottom) + 24px)); display: grid; justify-items: center; gap: 2px; padding-inline: 16px; pointer-events: none; text-align: center;
  opacity: 0; transform: translateY(6px); transition: opacity .25s, transform .25s; }
.dir-subs[data-on="true"] { opacity: 1; transform: none; }
.dir-subs .who { font: 700 11px var(--d-display); letter-spacing: .14em; text-transform: uppercase; color: var(--d-gold); text-shadow: 0 1px 3px #000; }
.dir-subs .ar, .dir-subs .en { max-inline-size: min(720px, 100%); padding: 2px 12px; border-radius: 8px; background: rgba(0,0,0,.62); color: #fff; text-shadow: 0 1px 2px #000; overflow-wrap: anywhere; }
.dir-subs .ar { font: 600 22px/1.5 "Noto Kufi Arabic", var(--d-body); }
.dir-subs .en { font: 500 17px/1.4 var(--d-body); }
@media (max-width: 640px) { .dir-subs { inset-block-end: auto; inset-block-start: 14vh; } .dir-subs .ar { font-size: 18px; } .dir-subs .en { font-size: 14px; } }
@media (prefers-reduced-motion: reduce) { .dir-subs, .dir-bar > i { transition: none; } }
`;
const NAMES = { nemesis: { en: 'Nemesis', ar: 'الخصم' }, djinn: { en: 'Djinn', ar: 'الجني' } };

function styles(doc) {
  if (doc.getElementById('dir-css')) return;
  const s = doc.createElement('style'); s.id = 'dir-css'; s.textContent = CSS; doc.head.append(s);
}
const el = (doc, tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const MB = (bytes) => `${Math.round(bytes / 1048576).toLocaleString('en')} MB`;

export function createSubtitles(mount = document.body) {
  const doc = mount.ownerDocument; styles(doc);
  const box = el(doc, 'div', 'dir-subs'); box.setAttribute('aria-live', 'polite'); box.dataset.on = 'false';
  const who = el(doc, 'div', 'who'), ar = el(doc, 'div', 'ar'), en = el(doc, 'div', 'en');
  ar.lang = 'ar'; ar.dir = 'rtl'; en.lang = 'en'; en.dir = 'ltr';
  box.append(who, ar, en); mount.append(box);
  let timer = null;
  return {
    el: box,
    /** Show { speaker, en, ar } for `seconds` (a voice line's duration_s plus a beat). */
    show(line, seconds = 4.5) {
      const n = NAMES[line.speaker] || NAMES.nemesis;
      who.textContent = `${n.en} · ${n.ar}`; ar.textContent = line.ar; en.textContent = line.en;
      box.dataset.on = 'true'; box.dataset.speaker = line.speaker;
      clearTimeout(timer); timer = setTimeout(() => { box.dataset.on = 'false'; }, seconds * 1000);
    },
    hide() { clearTimeout(timer); box.dataset.on = 'false'; },
  };
}

export function createPanel(mount = document.body, { onLoad, onMeasure, onSeed, onPause, folded = false } = {}) {
  const doc = mount.ownerDocument; styles(doc);
  const root = el(doc, 'section', 'dir-panel'); root.id = 'director-panel'; root.setAttribute('aria-label', 'AI director'); root.dataset.folded = 'false';
  const head = el(doc, 'div', 'dir-head');
  const title = el(doc, 'div', 'dir-title', 'AI director');
  const who = el(doc, 'span', 'dir-badge', 'rules'); who.dataset.kind = 'rules'; who.id = 'dir-who';
  const seedBadge = el(doc, 'span', 'dir-badge', 'seed'); seedBadge.id = 'dir-seed';
  const simBadge = el(doc, 'span', 'dir-badge', 'simulated game'); simBadge.dataset.kind = 'sim'; simBadge.id = 'dir-sim';
  const fold = el(doc, 'button', 'dir-fold', '–'); fold.type = 'button'; fold.setAttribute('aria-label', 'Fold the director panel'); fold.setAttribute('aria-expanded', 'true');
  head.append(title, who, seedBadge, simBadge, fold);
  const status = el(doc, 'div', 'dir-status'); status.id = 'dir-status';
  const bar = el(doc, 'div', 'dir-bar'); const fill = el(doc, 'i'); bar.append(fill); bar.hidden = true;
  const now = el(doc, 'div', 'dir-now');
  const label = el(doc, 'div', 'dir-label', 'Last decision');
  const why = el(doc, 'div', 'dir-why', 'Waiting for the first decision…'); why.id = 'dir-why';
  const chips = el(doc, 'div', 'dir-chips'); chips.id = 'dir-actions';
  const refused = el(doc, 'ul', 'dir-refused'); refused.id = 'dir-refused';
  const note = el(doc, 'div', 'dir-note'); note.id = 'dir-note';
  now.append(label, why, chips, refused, note);
  const state = el(doc, 'div', 'dir-state'); state.id = 'dir-state';
  const log = el(doc, 'ul', 'dir-log'); log.id = 'dir-log';
  const perf = el(doc, 'div', 'dir-perf'); perf.id = 'dir-perf';
  const btns = el(doc, 'div', 'dir-btns');
  const button = (id, text, fn) => { const b = el(doc, 'button', 'dir-btn', text); b.type = 'button'; b.id = id; b.addEventListener('click', () => fn?.(b)); btns.append(b); return b; };
  const bLoad = button('dir-load', 'Load AI model', onLoad); bLoad.dataset.primary = 'true'; bLoad.hidden = true;
  const bMeasure = button('dir-measure', 'Measure', onMeasure); bMeasure.hidden = true;
  const bSeed = button('dir-newseed', 'New seed', onSeed);
  const bPause = button('dir-pause', 'Pause', onPause);
  root.append(head, status, bar, now, state, log, perf, btns);
  mount.append(root);

  const setFolded = (f) => { root.dataset.folded = String(f); fold.textContent = f ? '+' : '–'; fold.setAttribute('aria-expanded', String(!f)); };
  fold.addEventListener('click', () => setFolded(root.dataset.folded !== 'true'));
  const onKey = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Backquote' || e.code === 'F9') { setFolded(root.dataset.folded !== 'true'); e.preventDefault(); }
  };
  doc.addEventListener('keydown', onKey);
  setFolded(folded);

  return {
    el: root, setFolded,
    setSeed(seed) { seedBadge.textContent = `seed ${seed}`; },
    setSimulated(on) { simBadge.hidden = !on; },
    setPaused(on) { bPause.textContent = on ? 'Resume' : 'Pause'; },
    /** kind: 'rules' | 'loading' | 'model' | 'error' | 'offer'; text is the status line; progress 0..1 while loading. */
    setStatus(kind, text, progress = null) {
      status.textContent = text; root.dataset.status = kind;
      bar.hidden = kind !== 'loading'; if (progress !== null) fill.style.inlineSize = `${Math.round(progress * 100)}%`;
    },
    offerLoad(text) { bLoad.textContent = text; bLoad.hidden = false; bLoad.disabled = false; },
    hideLoad() { bLoad.hidden = true; },
    showMeasure(on) { bMeasure.hidden = !on; },
    busy(on, text) { bMeasure.disabled = on; if (text) bMeasure.textContent = text; },
    /** A director record (lib/director/director.mjs): the one line of why, the actions, what was refused. */
    record(rec) {
      const isModel = rec.source === 'model';
      who.textContent = isModel ? `AI · ${rec.modelId.replace(/-MLC$/, '')}` : 'rules'; who.dataset.kind = isModel ? 'model' : 'rules';
      label.textContent = `Decision #${rec.tick}${rec.wave !== null && rec.wave !== undefined ? ` · after wave ${rec.wave}` : ''} · ${isModel ? (rec.prepared ? 'the model, thought ahead' : 'the model') : 'the rules'} · mood ${rec.mood.replace('_', ' ')}${isModel ? ` · ${rec.ms} ms · ${rec.tokens} tokens · ${rec.tokensPerSecond} tok/s` : ''}`;
      why.textContent = rec.why;
      chips.replaceChildren(...(rec.applied.length ? rec.applied.map((a) => el(doc, 'span', 'dir-chip', describe(a))) : [Object.assign(el(doc, 'span', 'dir-chip', 'hold: nothing changed'), { })]));
      if (!rec.applied.length) chips.firstChild.dataset.kind = 'hold';
      refused.replaceChildren(...rec.rejected.map((r) => el(doc, 'li', '', `refused: ${describe(r.action)} (${r.reason})`)));
      note.textContent = rec.fallback ? `Model answer not used (${rec.fallback}); the rules decided.` : '';
      state.textContent = rec.summary;
      const li = el(doc, 'li'); const b = el(doc, 'b', '', `#${rec.tick}${rec.wave !== null && rec.wave !== undefined ? ` wave ${rec.wave}` : ''} ${isModel ? 'AI' : 'rules'} `); li.append(b, doc.createTextNode(`${rec.applied.map(describe).join(', ') || 'hold'} — ${rec.why}`));
      log.prepend(li); while (log.children.length > 8) log.lastChild.remove();
    },
    /** info: { modelId, downloadMB, downloadBytes, loadMs, cached }, m: a measure() result or null. */
    perf(info, m = null) {
      const parts = [];
      if (info) parts.push(`${info.modelId.replace(/-MLC$/, '')}: ${info.downloadBytes ? MB(info.downloadBytes) : `${info.downloadMB.toLocaleString('en')} MB`} download · loaded in ${(info.loadMs / 1000).toFixed(1)} s${info.cached ? ' (from cache)' : ' (first load)'}, warm-up ${((info.warmMs || 0) / 1000).toFixed(1)} s`);
      if (m) parts.push(`${m.mode} mode · ${m.tokensPerSecond} tok/s · ${m.msPerDecision} ms per decision (worst ${m.msWorst}) · ${m.tokensPerDecision} tokens · ${m.valid}/${m.runs} valid JSON · frame gap p95 ${m.frameGapP95} ms`);
      perf.textContent = parts.join(' — ');
    },
    destroy() { doc.removeEventListener('keydown', onKey); root.remove(); },
  };
}
