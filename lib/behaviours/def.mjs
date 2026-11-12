// def.mjs: the behaviour definition (behaviours/<type>/behaviour.json, uew-behaviour@1), the shared contract every game
// feature uses (Kereem via the coordinator, 12 Nov 2026: "the builder is the PLATFORM"): { format, type, name: { en, ar },
// summary: { en, ar }, targets: ['character' | 'animal' | 'piece' | 'world'], params: [the component param schema] }.
// The JSON schema is behaviours/behaviour.schema.json (Node: lib/formats/validate.mjs validateBehaviour); this is the same
// rule set without Ajv, for the page. Pure; read by tools/build-registry.mjs, lib/runtime/registry.mjs and lib/scene/check-patches.mjs.

export const BEHAVIOUR_FORMAT = 'uew-behaviour@1';
/** The reserved uid of the scene itself: world behaviours (targets 'world') live in doc.world.behaviours. */
export const WORLD_UID = '@world';
export const TARGETS = ['character', 'animal', 'piece', 'world'];
export const TYPE = /^[a-z][a-z0-9_]*$/; // as behaviours/behaviour.schema.json
const PARAM_TYPES = ['number', 'enum', 'bool', 'colour']; // the component param schema's (components/component.schema.json), shapes aside
const AFFECTS = ['scale', 'material', 'light', 'module', 'effect'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bi = (v) => isObj(v) && typeof v.en === 'string' && v.en && typeof v.ar === 'string' && v.ar;

/** Problems with a behaviour.json, [] when it is valid. */
export function behaviourErrors(j) {
  const e = [];
  if (!isObj(j)) return ['(root): must be an object'];
  if (j.format !== BEHAVIOUR_FORMAT) e.push(`format: must be ${BEHAVIOUR_FORMAT}`);
  if (typeof j.type !== 'string' || !TYPE.test(j.type)) e.push('type: lower-case letters, digits and _');
  if (!bi(j.name)) e.push('name: { en, ar } required');
  if (!bi(j.summary)) e.push('summary: { en, ar } required');
  if (!Array.isArray(j.targets) || !j.targets.length || !j.targets.every((t) => TARGETS.includes(t))) e.push(`targets: one or more of ${TARGETS.join(', ')}`);
  if (!Array.isArray(j.params)) e.push('params: a list');
  else j.params.forEach((p, i) => {
    if (!isObj(p) || typeof p.name !== 'string' || !PARAM_TYPES.includes(p.type) || !Object.hasOwn(p, 'default') || !bi(p.label) || !AFFECTS.includes(p.affects)) e.push(`params[${i}]: { name, type (${PARAM_TYPES.join(', ')}), default, label: { en, ar }, affects (${AFFECTS.join(', ')}) }`);
    else if (p.type === 'enum' && !(Array.isArray(p.options) && p.options.includes(p.default))) e.push(`params[${i}]: an enum needs options that hold the default`);
  });
  for (const k of Object.keys(j)) if (!['format', 'type', 'name', 'summary', 'targets', 'params'].includes(k)) e.push(`${k}: must NOT have additional properties`);
  return e;
}

/** A behaviour's params with its defaults filled in. */
export function behaviourParams(def, given = {}) {
  const out = {};
  for (const p of def?.params || []) out[p.name] = structuredClone(Object.hasOwn(given || {}, p.name) ? given[p.name] : p.default);
  return out;
}
