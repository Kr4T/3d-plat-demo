// Apache-2.0, © UE-WORLD contributors (Kr4T/UE-WORLD); modified. Full text: builder/LICENSE-Apache-2.0.txt.
// The ?audit=1 overlay and window.__SCENE_FEATURES__ / __AUDIT_SCORE__ / __shot, as the private threejs-sota skill asks.
// Adapted from that skill's drop-in audit/scene-features.js (itself from
// UE-WORLD docs/demo/riyadh-voxel/main.js), with the "Measure each feature's cost" button of Boulevard City's
// measureFeatures / drawAudit (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/main.js).
// Changes: the checklist URL is beside this module (builder/checklist.json, a copy of the skill's), the overlay mounts
// in the 3D view, and measuring is delegated to the stage (measure(feature, avg) switches one feature off and times it).
export const on = (v, na = false) => (na ? 'n.a.' : v ? 'on' : 'off');

export async function installAudit({ features, revision = '', mount = document.body, enabled = false, measure = null, measurable = [], checklistUrl = new URL('./checklist.json', import.meta.url) } = {}) {
  window.__SCENE_FEATURES__ = features();
  let CHECK = null, el = null, cost = {};
  if (enabled) {
    CHECK = await fetch(checklistUrl).then((r) => r.json()).catch(() => null);
    el = document.createElement('div');
    el.id = 'audit';
    el.style.cssText = 'position:absolute;top:12px;right:12px;max-width:min(360px,calc(100% - 24px));max-height:62%;overflow:auto;'
      + 'font:11px/1.35 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.72);color:#eee;padding:8px;border-radius:6px;z-index:10';
    mount.appendChild(el);
  }
  function score() {
    const F = features(); window.__SCENE_FEATURES__ = F;
    const items = CHECK ? CHECK.items : Object.keys(F).map((id) => ({ id, name: id, examples: [] }));
    const applicable = items.filter((i) => F[i.id] !== 'n.a.'), onItems = applicable.filter((i) => F[i.id] === 'on');
    window.__AUDIT_SCORE__ = { on: onItems.length, applicable: applicable.length, total: items.length };
    return { F, items };
  }
  async function measureAll() { // each feature off for 40 frames, timed against everything on (Boulevard measureFeatures)
    const avg = (n = 40) => new Promise((ok) => { let k = 0; const t0 = performance.now(); const tick = () => { if (++k >= n) ok((performance.now() - t0) / n); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const base = await avg(), out = { _baseMs: +base.toFixed(2) };
    for (const f of measurable) { if (features()[f] !== 'on') continue; out[f] = +(base - await measure(f, avg)).toFixed(2); }
    cost = out; window.__AUDIT_COST__ = out; return out;
  }
  function draw(renderer, fps = 0) {
    const { F, items } = score();
    if (!el) return;
    const info = renderer.info.render, s = window.__AUDIT_SCORE__;
    const colour = { on: '#9be39b', off: '#e59a9a', 'n.a.': '#999' };
    const gpu = info.timestamp ? `${info.timestamp.toFixed(2)} ms GPU` : 'GPU timer: not supported here';
    el.innerHTML = `<b>Audit · three r${revision} · ${renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2'}</b><br>`
      + `${fps.toFixed(0)} fps · ${info.drawCalls ?? info.calls} draws · ${((info.triangles || 0) / 1000).toFixed(0)}k tris · ${gpu}<br>`
      + `coverage: <b>${s.on} / ${s.applicable}</b> applicable (${s.total} in the checklist)<table>`
      + items.map((i) => { const v = F[i.id] ?? 'MISSING', ex = i.examples?.[0], c = cost[i.id];
        return `<tr><td style="color:${colour[v] || '#f55'}">${v}</td><td>${ex ? `<a style="color:#9cf" href="${ex.link}" target="_blank" rel="noopener">${i.name}</a>` : i.name}</td><td>${c !== undefined ? `${c} ms` : ''}</td></tr>`; }).join('')
      + '</table>'
      + (measure ? `<button id="measure" style="margin-top:6px;font:inherit">Measure each feature's cost</button>${cost._baseMs ? `<div>frame ${cost._baseMs} ms with everything on</div>` : ''}` : '');
    const b = el.querySelector('#measure');
    if (b) b.onclick = () => { b.textContent = 'Measuring… (keep the view still)'; measureAll().then(() => draw(renderer, fps)); };
  }
  return { AUDIT: enabled, score, draw, measureAll, done(renderer, fps) { draw(renderer, fps); window.__shot = true; }, dispose() { el?.remove(); } };
}
