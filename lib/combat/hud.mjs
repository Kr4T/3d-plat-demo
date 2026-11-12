// hud.mjs: the fight's page elements (DOM over the canvas, no 3D): the combo counter (combo_attack), the waves line, and
// the end panel with "Again" (waves). Made only in a browser; every function is a no-op without a document.
const lang = () => (globalThis.document?.documentElement?.lang === 'ar' ? 'ar' : 'en');
export const T = (s) => (typeof s === 'string' ? s : s[lang()] ?? s.en);
const hasDom = () => typeof globalThis.document?.createElement === 'function';
const host = (ctx) => ctx?.stage?.renderer?.domElement?.parentElement || globalThis.document?.body || null;
const box = 'position:fixed;z-index:25;pointer-events:none;color:#fff;font:600 15px/1.3 system-ui,sans-serif;text-shadow:0 1px 3px rgba(0,0,0,.7)';

/** A text pinned on the screen: `where` is CSS (e.g. 'top:72px;left:50%;transform:translateX(-50%)'). */
export function label(ctx, name, where) {
  const h = host(ctx); if (!h || !hasDom()) return { set() {}, remove() {}, el: null };
  const el = document.createElement('div'); el.dataset[name] = ''; el.style.cssText = `${box};${where};display:none`; el.setAttribute('aria-live', 'polite');
  h.appendChild(el);
  return { el, set(text) { el.textContent = text || ''; el.style.display = text ? 'block' : 'none'; }, remove() { el.remove(); } };
}

/** The end panel: a title, lines, and one button; Enter, Space, R or a tap anywhere on it calls onAgain once. */
export function endPanel(ctx, { title, lines = [], again, onAgain }) {
  const h = host(ctx); if (!h || !hasDom()) return { remove() {} };
  const el = document.createElement('div'); el.dataset.wavesOver = ''; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', title);
  el.style.cssText = 'position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(10,10,16,.45);touch-action:manipulation';
  const card = document.createElement('div'); card.style.cssText = 'min-width:240px;max-width:min(88vw,420px);padding:22px 26px;border-radius:16px;background:rgba(20,22,30,.86);border:1px solid rgba(255,255,255,.25);color:#fff;font:500 16px/1.5 system-ui,sans-serif;text-align:center';
  const hd = document.createElement('div'); hd.textContent = title; hd.style.cssText = 'font:700 24px/1.3 system-ui,sans-serif;margin-bottom:8px';
  card.appendChild(hd);
  for (const l of lines) { const d = document.createElement('div'); d.textContent = l; card.appendChild(d); }
  const b = document.createElement('button'); b.type = 'button'; b.dataset.wavesAgain = ''; b.textContent = again;
  b.style.cssText = 'margin-top:14px;padding:10px 26px;border-radius:999px;border:0;background:#e9c46a;color:#1b1b1f;font:700 16px system-ui,sans-serif';
  card.appendChild(b); el.appendChild(card); h.appendChild(el);
  let done = false;
  const go = (e) => { if (done) return; e?.preventDefault?.(); e?.stopPropagation?.(); done = true; cleanup(); onAgain(); };
  const key = (e) => { if (['Enter', 'Space', 'KeyR'].includes(e.code)) go(e); };
  const cleanup = () => { removeEventListener('keydown', key, true); el.remove(); };
  addEventListener('keydown', key, true); el.addEventListener('pointerdown', go);
  return { el, remove: () => { done = true; cleanup(); } };
}

/** A caption line from a speaker in the page's caption box (the Talk behaviour's, ctx.hud.caption; Talk ships silent). */
export function caption(ctx, speaker, text) {
  const el = ctx?.hud?.caption; if (!el || !hasDom()) return () => {};
  const p = document.createElement('p'); p.className = lang() === 'ar' ? 'cap-ar' : 'cap-en'; p.dataset.wavesCaption = ''; p.textContent = `${speaker}: ${text}`;
  el.replaceChildren(p); el.hidden = false;
  return () => { if (p.parentElement === el) { el.replaceChildren(); el.hidden = true; } };
}

/** The game's button cluster (bottom right on a touch screen; the walk's stick has the left): one per page, shared by every
 * behaviour and by other workers' code through window.__game.buttons:
 *   const off = window.__game.buttons.add({ id, label, onDown, onUp, size = 60, order = 0 })   // off() removes it
 * Buttons are at least 56 px, laid out in two columns from the bottom right (order: lower is nearer the thumb), inside the
 * safe area, mirrored in a right-to-left page (the cluster stays on the right: the stick is on the left). The cluster is
 * shown while it has buttons and `show(true)` was called (Play on a touch screen); Jump and Dodge plug in the same way. */
export function gameButtons(ctx) {
  const g = (globalThis.__game ||= {});
  if (g.buttons) return g.buttons;
  const items = new Map(); let el = null, visible = false;
  const draw = () => {
    if (!hasDom()) return;
    if (!el) { const h = host(ctx); if (!h) return; el = document.createElement('div'); el.dataset.gameButtons = ''; el.dataset.combat = ''; el.dir = 'ltr'; h.appendChild(el); }
    el.style.cssText = `position:fixed;right:calc(14px + env(safe-area-inset-right));bottom:calc(22px + env(safe-area-inset-bottom));display:${visible && items.size ? 'grid' : 'none'};grid-template-columns:auto auto;gap:12px;align-items:end;justify-items:end;z-index:30;touch-action:none;direction:rtl`;
    const want = [...items.values()].sort((a, b) => a.order - b.order);
    el.replaceChildren(...want.map((it) => it.el));
  };
  g.buttons = {
    add({ id, label, onDown, onUp, size = 60, order = 0, attrs = {} } = {}) {
      if (!id) throw new Error('buttons.add({ id, label, onDown })');
      g.buttons.remove(id);
      const it = { id, order, el: null };
      if (hasDom()) {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.gameButton = id; for (const [k, v] of Object.entries(attrs)) b.dataset[k] = v;
        const px = Math.max(56, size); b.textContent = label; b.setAttribute('aria-label', label);
        b.style.cssText = `width:${px}px;height:${px}px;border-radius:50%;border:2px solid rgba(255,255,255,.78);background:rgba(20,22,30,.55);color:#fff;font:600 14px system-ui,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none;direction:ltr`;
        let held = false;
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); held = true; try { onDown?.(e); } catch (err) { console.error('game button', id, err); } });
        const up = (e) => { if (!held) return; held = false; try { onUp?.(e); } catch (err) { console.error('game button', id, err); } };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        it.el = b;
      }
      items.set(id, it); draw();
      return () => g.buttons.remove(id);
    },
    remove(id) { const it = items.get(id); if (!it) return false; it.el?.remove(); items.delete(id); draw(); return true; },
    show(on) { visible = !!on; draw(); },
    list: () => [...items.values()].sort((a, b) => a.order - b.order).map((it) => it.id),
    get visible() { return visible; },
  };
  return g.buttons;
}

/** A bar pinned on the screen (the hero's health): set(fraction 0..1). `where` is CSS. */
export function meter(ctx, name, where, colour = '#e5484d') {
  const h = host(ctx); if (!h || !hasDom()) return { set() {}, remove() {}, el: null };
  const el = document.createElement('div'); el.dataset[name] = ''; el.setAttribute('role', 'meter'); el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
  el.style.cssText = `position:fixed;z-index:25;pointer-events:none;${where};height:12px;border-radius:6px;background:rgba(20,22,30,.6);border:1px solid rgba(255,255,255,.75);overflow:hidden`;
  const fill = document.createElement('div'); fill.style.cssText = `height:100%;width:100%;background:${colour};transition:width .15s linear`;
  el.appendChild(fill); h.appendChild(el);
  return { el, set(f, labelText) { const v = Math.round(Math.max(0, Math.min(1, f)) * 100); fill.style.width = `${v}%`; el.setAttribute('aria-valuenow', String(v)); if (labelText) el.setAttribute('aria-label', labelText); }, remove() { el.remove(); } };
}
