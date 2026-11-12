// registry.mjs: loads the components and materials registries (spec §5, §6) from a base folder or URL.
// r187 examples: webgpu_loader_gltf (model files fetched and parsed at run time; here only their URLs are resolved) and
// webgpu_generator_city (generator modules: the r187 city generators are what generator components wrap).
// Layout under `base`: components/index.json { sockets, components: [{ id, version, path? }] } (path defaults to
// `<id>/component.json`), each component.json (uew-component@1), materials/index.json { presets: [id] }, and
// materials/<preset>/material.json + material.js. Generator modules are imported when the registry loads.
// Variants (spec §5.6): a component with `parent` is sparse; it is resolved by deep-merging its parent: the parent's
// params with defaults replaced by `defaults_override` (and any params the variant restates), material overrides merged
// per slot, files resolved against the parent's folder. A variant whose parent is missing is reported, not thrown.
import { loadMaterial } from './materials.mjs';
import { behaviourErrors } from '../behaviours/def.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

// In Node the full validator (Ajv + the JSON Schemas, lib/formats/validate.mjs). It reads the schemas from disk, so a
// browser gets a structural check of the same required fields; the component gate (Task 6) validates every component
// in full before it reaches components/index.json.
async function getValidator() {
  if (IS_NODE) {
    const m = await import('../formats/validate.mjs');
    return { level: 'schema', validateComponent: m.validateComponent, loadSockets: m.loadSockets };
  }
  return { level: 'structural', validateComponent: structuralCheck, loadSockets: (json) => ({ types: Object.keys(json?.types || {}), accepts: () => false }) };
}

function structuralCheck(c) {
  const errors = [];
  if (!isObj(c)) return { ok: false, errors: ['(root): must be an object'] };
  if (c.format !== 'uew-component@1') errors.push('format: must be uew-component@1');
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errors.push('id: invalid');
  if (typeof c.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(c.version)) errors.push('version: invalid');
  for (const k of ['en', 'ar']) if (!isObj(c.name) || typeof c.name[k] !== 'string' || !c.name[k]) errors.push(`name.${k}: required`);
  if (c.defaults_override !== undefined && c.parent === undefined) errors.push('defaults_override: only allowed with parent');
  if (c.parent === undefined) {
    if (c.kind === 'mesh' && !(isObj(c.files) && c.files.lod0)) errors.push('files.lod0: required for a mesh component');
    else if (c.kind === 'generator' && !(isObj(c.files) && c.files.module)) errors.push('files.module: required for a generator component');
    else if (c.kind !== 'mesh' && c.kind !== 'generator') errors.push('kind: must be mesh or generator');
  }
  return { ok: errors.length === 0, errors };
}

function absolute(base) {
  const s = String(base).endsWith('/') ? String(base) : `${base}/`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return new URL(s);
  if (typeof location !== 'undefined') return new URL(s, location.href);
  return new URL(s, `file://${process.cwd()}/`);
}

/** A variant merged onto its (resolved) parent. Returns { json, errors }. */
export function mergeVariant(parent, variant) {
  const errors = [];
  const { ref: _r, dir: _d, module: _m, ...data } = parent; // the module namespace is not cloneable, and not data
  const out = structuredClone(data);
  for (const [k, v] of Object.entries(variant)) {
    if (k === 'params' || k === 'materials' || k === 'defaults_override') continue;
    out[k] = structuredClone(v);
  }
  out.params = Array.isArray(out.params) ? out.params : [];
  for (const p of Array.isArray(variant.params) ? variant.params : []) {
    const i = out.params.findIndex((q) => q.name === p.name);
    if (i >= 0) out.params[i] = { ...out.params[i], ...structuredClone(p) }; else out.params.push(structuredClone(p));
  }
  for (const [name, value] of Object.entries(isObj(variant.defaults_override) ? variant.defaults_override : {})) {
    const p = out.params.find((q) => q.name === name);
    if (!p) errors.push(`defaults_override.${name}: the parent has no param "${name}"`);
    else p.default = structuredClone(value);
  }
  if (variant.defaults_override !== undefined) out.defaults_override = structuredClone(variant.defaults_override);
  out.materials = Array.isArray(out.materials) ? out.materials : [];
  for (const m of Array.isArray(variant.materials) ? variant.materials : []) {
    const pm = out.materials.find((q) => q.slot === m.slot);
    if (pm) { if (m.preset) pm.preset = m.preset; pm.overrides = { ...(pm.overrides || {}), ...structuredClone(m.overrides || {}) }; }
    else out.materials.push(structuredClone(m));
  }
  return { json: out, errors };
}

/**
 * loadRegistry(base, fetchFn = fetch) -> Registry
 * Registry = { get(ref), list(), material(preset), ranges(ref), problem(ref), rejected, warnings, validation, fetchBuffer(url) }
 * ComponentDef = the component.json (variants resolved) + { ref, dir (URL its files resolve against), module (generators) }.
 */
export async function loadRegistry(base, fetchFn = globalThis.fetch?.bind(globalThis), { validate } = {}) {
  const root = absolute(base), componentsURL = new URL('components/', root), materialsURL = new URL('materials/', root);
  const v = validate ? { level: 'custom', ...validate } : await getValidator();
  const getJSON = async (url) => { const r = await fetchFn(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

  const indexURL = new URL('index.json', componentsURL).href;
  let index;
  try { index = await getJSON(indexURL); } catch (e) { throw new Error(`registry: cannot read ${indexURL}: ${e.message}`); }
  const warnings = [], rejected = [], problems = new Map();
  let sockets = v.loadSockets({ types: {} }), socketTypes = {};
  try { const sj = await getJSON(new URL(index.sockets || 'sockets.json', componentsURL).href); sockets = v.loadSockets(sj); socketTypes = sj?.types && typeof sj.types === 'object' ? sj.types : {}; }
  catch (e) { warnings.push(`sockets: ${e.message}; every socket type will be unknown`); }

  // 1. read and validate every listed component.json
  const raw = new Map(); // ref -> { json, dir }
  await Promise.all((Array.isArray(index.components) ? index.components : []).map(async (entry) => {
    const e = typeof entry === 'string' ? { path: entry } : entry || {};
    const rel = e.path || `${e.id}/component.json`;
    const url = new URL(rel, componentsURL);
    const listed = e.id && e.version ? `${e.id}@${e.version}` : rel;
    let json;
    try { json = await getJSON(url.href); } catch (err) { rejected.push({ ref: listed, path: rel, errors: [`cannot read: ${err.message}`] }); return; }
    const ref = isObj(json) && json.id && json.version ? `${json.id}@${json.version}` : listed;
    const res = v.validateComponent(json, sockets);
    if (!res.ok) { rejected.push({ ref, path: rel, errors: res.errors }); return; }
    if (e.id && e.version && ref !== listed) { rejected.push({ ref, path: rel, errors: [`index lists ${listed}, the file says ${ref}`] }); return; }
    if (raw.has(ref)) { rejected.push({ ref, path: rel, errors: ['listed twice'] }); return; }
    raw.set(ref, { json, dir: new URL('./', url).href });
  }));

  // 2. resolve variants (recursively, with a cycle guard)
  const defs = new Map();
  const resolve = (ref, stack = []) => {
    if (defs.has(ref)) return defs.get(ref);
    if (problems.has(ref)) return null;
    const r = raw.get(ref);
    if (!r) { problems.set(ref, rejected.some((x) => x.ref === ref) ? 'rejected by validation' : 'unknown component'); return null; }
    let def;
    if (r.json.parent) {
      if (stack.includes(ref)) { problems.set(ref, `variant cycle: ${[...stack, ref].join(' -> ')}`); return null; }
      const parent = resolve(r.json.parent, [...stack, ref]);
      if (!parent) { problems.set(ref, `variant parent ${r.json.parent} missing (${problems.get(r.json.parent) || 'unknown component'})`); return null; }
      const { json, errors } = mergeVariant(parent, r.json);
      const check = v.validateComponent(json, sockets);
      if (errors.length || !check.ok) { const all = [...errors, ...check.errors]; rejected.push({ ref, path: `${r.json.id}/component.json`, errors: all }); problems.set(ref, `variant invalid: ${all.join('; ')}`); return null; }
      def = { ...json, ref, dir: parent.dir, module: parent.module };
    } else def = { ...structuredClone(r.json), ref, dir: r.dir };
    defs.set(ref, def);
    return def;
  };

  // 3. generator modules: imported once per URL (variants share their parent's)
  const modules = new Map();
  const importModule = (url) => { if (!modules.has(url)) modules.set(url, import(url)); return modules.get(url); };
  for (const ref of raw.keys()) if (!raw.get(ref).json.parent) {
    const def = resolve(ref);
    if (def?.kind !== 'generator') continue;
    try {
      const mod = await importModule(new URL(def.files.module, def.dir).href);
      if (typeof mod.build !== 'function') throw new Error('no build(params, ctx) export');
      def.module = mod;
    } catch (err) {
      defs.delete(ref); problems.set(ref, `generator module ${def.files.module}: ${err.message}`);
      rejected.push({ ref, path: def.files.module, errors: [`module: ${err.message}`] });
    }
  }
  for (const ref of raw.keys()) resolve(ref);
  for (const def of defs.values()) Object.freeze(def);

  // 4. behaviours (the shared contract: behaviours/<type>/behaviour.json, listed under index.behaviours)
  const behaviours = new Map();
  await Promise.all((Array.isArray(index.behaviours) ? index.behaviours : []).map(async (e) => {
    const rel = e?.path || `../behaviours/${e?.type}/behaviour.json`;
    try {
      const json = await getJSON(new URL(rel, componentsURL).href);
      const errs = behaviourErrors(json);
      if (errs.length) { rejected.push({ ref: `behaviour:${e?.type}`, path: rel, errors: errs }); return; }
      behaviours.set(json.type, Object.freeze({ ...json, dir: new URL('./', new URL(rel, componentsURL)).href }));
    } catch (err) { rejected.push({ ref: `behaviour:${e?.type}`, path: rel, errors: [`cannot read: ${err.message}`] }); }
  }));

  // 5. material presets, by name
  const materials = new Map();
  let presetIds = [];
  try { const mi = await getJSON(new URL('index.json', materialsURL).href); presetIds = Array.isArray(mi.presets) ? mi.presets : []; }
  catch (e) { warnings.push(`materials/index.json: ${e.message}; no material presets`); }
  await Promise.all(presetIds.map(async (id) => {
    try { materials.set(id, await loadMaterial(id, materialsURL, fetchFn)); } catch (e) { warnings.push(`material ${id}: ${e.message}`); }
  }));
  for (const def of defs.values()) for (const m of def.materials || []) {
    if (!materials.has(m.preset)) warnings.push(`${def.ref} slot ${m.slot}: material preset ${m.preset} is not in the materials registry`);
  }

  return {
    base: root.href,
    validation: v.level,
    rejected, warnings,
    socketTypes, // components/sockets.json's table { type: { accepts } }, as the server's registry has it (lib/scene/check-patches.mjs)
    get: (ref) => defs.get(ref) || null,
    list: () => [...defs.values()],
    material: (preset) => materials.get(preset) || null,
    behaviour: (type) => behaviours.get(type) || null,
    behaviours: () => [...behaviours.values()].sort((a, b) => (a.type < b.type ? -1 : 1)),
    problem(ref) {
      if (defs.has(ref)) return null;
      if (problems.has(ref)) return problems.get(ref);
      const r = rejected.find((x) => x.ref === ref);
      return r ? `rejected: ${r.errors.join('; ')}` : 'unknown component';
    },
    ranges(ref) {
      const def = defs.get(ref), out = {};
      for (const p of def?.params || []) if (p.type === 'number') out[p.name] = [p.min ?? -Infinity, p.max ?? Infinity];
      return out;
    },
    async fetchBuffer(url) { const r = await fetchFn(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); },
  };
}
