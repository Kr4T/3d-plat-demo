// hud.js: the ?hud line the threejs-sota skill asks for (fps · renderer · revision · draws · triangles · pixel ratio),
// as Boulevard City's #fps line (Kr4T/3DPLAT round2/boulevard 3352816, apps/boulevard-city-3d/main.js), plus the preset
// and the pipeline's passes. Headless fps means nothing (SwiftShader): real-phone fps comes from this line on a phone.
export function hudLine(i) {
  const tris = i.triangles < 10000 ? String(i.triangles) : `${(i.triangles / 1000).toFixed(0)}k`;
  return `${i.fps.toFixed(0)} fps · ${i.backend} · three r${i.revision} · ${i.draws} draws · ${tris} tris · ${i.pixelRatio.toFixed(2)}x · ${i.preset} · ${i.pipeline}`;
}

export function createHud(stage, { qs = new URLSearchParams(location.search), mount = document.body } = {}) {
  if (!qs.has('hud')) return null;
  const el = document.createElement('div');
  el.id = 'hud';
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'color:rgba(243,239,232,.85);background:rgba(10,12,20,.6);padding:4px 8px;border-radius:6px;pointer-events:none;z-index:5;overflow-wrap:anywhere';
  el.textContent = '…';
  mount.appendChild(el);
  let acc = 0;
  const off = stage.onFrame((dt) => {
    acc += dt; if (acc < 0.5) return; acc = 0;
    const i = stage.hudInfo(); if (!i.fps) return;
    el.textContent = hudLine(i); window.__HUD__ = i;
  });
  return { el, dispose() { off(); el.remove(); } };
}
