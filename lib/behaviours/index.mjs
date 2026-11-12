// index.mjs: the behaviour runtime (the shared contract). Each type is a module lib/behaviours/<type>.mjs exporting
// attach(ctx, item, params) -> { update?(dt), onTap?(hit), onParams?(params), dispose() }. This loader imports a type's
// module the first time an item in the document carries it (lazy, by type), attaches one handle per (item, type), passes
// changed params to onParams, and disposes the handle when the item or the behaviour goes.
//   ctx = { view, stage, audio, physics, effects, hud, items(), find(uid) } (physics: the walk's Rapier world, builder/walk.js
//   physics; items / find are added here when the page gives none). World behaviours (targets 'world') live in
//   doc.world.behaviours and attach once per scene with item { uid: '@world', world: true }.
//   const bh = createBehaviours(ctx, registry);  await bh.sync(doc);  bh.update(dt);  bh.tap(uid, hit);  bh.list('player')
import { behaviourParams, WORLD_UID } from './def.mjs';
export { WORLD_UID };

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
const defaultLoad = (type) => import(new URL(`./${type}.mjs`, import.meta.url).href);

export function createBehaviours(ctx, registry, { load = defaultLoad } = {}) {
  const modules = new Map(); // type -> Promise<module>
  const live = new Map(); // `${uid}|${type}` -> { uid, type, item, params, key, handle }
  let chain = Promise.resolve(), current = null, disposed = false; // disposed: a sync in flight attaches nothing (review of PR #28, S3)
  // ctx.items() / ctx.find(uid): the document's items for any behaviour (world ones look round the scene)
  const all = () => [...(current?.areas || []), ...(current?.instances || [])];
  if (!ctx.items) ctx.items = () => all();
  if (!ctx.find) ctx.find = (uid) => all().find((x) => x.uid === uid) || null;
  const mod = (type) => { if (!modules.has(type)) modules.set(type, load(type).catch((e) => { modules.delete(type); throw e; })); return modules.get(type); };
  async function doSync(doc) {
    if (disposed) return;
    current = doc;
    const want = new Map();
    const worldItem = { uid: WORLD_UID, world: true, behaviours: Array.isArray(doc?.world?.behaviours) ? doc.world.behaviours : [] };
    for (const item of [...(doc?.areas || []), ...(doc?.instances || []), worldItem]) for (const b of Array.isArray(item.behaviours) ? item.behaviours : []) {
      const def = registry.behaviour?.(b.type); if (!def) continue;
      want.set(`${item.uid}|${b.type}`, { uid: item.uid, type: b.type, item, params: behaviourParams(def, b.params) });
    }
    for (const [k, h] of live) if (!want.has(k)) { live.delete(k); try { h.handle?.dispose?.(); } catch (e) { console.error('behaviour dispose', k, e); } }
    for (const [k, w] of want) {
      const key = stable(w.params), had = live.get(k);
      if (had) { had.item = w.item; if (had.key !== key) { had.key = key; had.params = w.params; try { had.handle?.onParams?.(w.params); } catch (e) { console.error('behaviour onParams', k, e); } } continue; }
      let m; try { m = await mod(w.type); } catch (e) { console.error('behaviour load', w.type, e); continue; }
      if (disposed) return;
      const handle = m.attach(ctx, w.item, w.params) || {};
      live.set(k, { ...w, key, handle });
    }
  }
  return {
    sync(doc) { const run = chain.then(() => doSync(doc)); chain = run.catch(() => {}); return run; },
    update(dt) { for (const h of live.values()) h.handle?.update?.(dt); },
    tap(uid, hit) { let n = 0; for (const h of live.values()) if (h.uid === uid && h.handle?.onTap) { h.handle.onTap(hit); n++; } return n; },
    /** The live behaviours of a type: [{ uid, type, item, params, handle }]. */
    list: (type) => [...live.values()].filter((h) => h.type === type),
    get: (uid, type) => live.get(`${uid}|${type}`) || null,
    dispose() { disposed = true; for (const h of live.values()) { try { h.handle?.dispose?.(); } catch { /* ignore */ } } live.clear(); },
  };
}
