// validate-lite.mjs: the uew-scene@1 check for the browser (Task 11). lib/formats/validate.mjs runs Ajv over the JSON Schemas
// and reads them from disk, which a page cannot do, so the builder page maps that file to this one in its import map
// (builder/index.html: "/lib/formats/validate.mjs" -> "/lib/formats/validate-lite.mjs") and lib/scene/patch.mjs checks every
// patched document here instead. It is a hand-written copy of scenes/scene.schema.json; tests/editing.test.mjs checks that
// it agrees with Ajv on valid documents and on every kind of fault the schema names. Components get the registry's
// structural check in the browser (lib/runtime/registry.mjs), so validateComponent here is that check, not the schema.
// Numbers must be finite, as Ajv's `type: number` requires (NaN and Infinity can reach a document from a slider or toLocal).

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const REF = /^[a-z0-9][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+$/, TO = /^[^.]+\.[^.]+$/;
const ENV = { hour: [0, 24], moon: 'bool', clouds: [0, 1], fog: [0, 1], wetness: [0, 1], waterLevel: 'num', date: 'date', latitude: [-89, 89], longitude: [-180, 180], haze: [0, 1], keyLight: [0, 2] };
const DATE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
// a real day (2026-02-31 is not), as lib/scene/check-patches.mjs isEnvDate; Ajv's schema pattern cannot say this
const realDay = (v) => { const [y, m, d] = v.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

function only(o, keys, at, errors) { for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${at}${k}: must NOT have additional properties`); }
function need(o, keys, at, errors) { for (const k of keys) if (!Object.hasOwn(o, k)) errors.push(`${at}${k}: must have required property '${k}'`); }

function behaviourList(list, at, errors) {
  if (!Array.isArray(list)) { errors.push(`${at}: must be array`); return; }
  const seen = new Set();
  list.forEach((b, i) => {
    const a = `${at}[${i}]`;
    if (!isObj(b)) { errors.push(`${a}: must be object`); return; }
    if (typeof b.type === 'string') { if (seen.has(b.type)) errors.push(`${a}: behaviour ${b.type} twice`); seen.add(b.type); }
    only(b, ['type', 'params'], `${a}.`, errors); need(b, ['type', 'params'], `${a}.`, errors);
    if (Object.hasOwn(b, 'type') && !(typeof b.type === 'string' && /^[a-z][a-z0-9_]*$/.test(b.type))) errors.push(`${a}.type: must be a behaviour type`);
    if (Object.hasOwn(b, 'params') && !isObj(b.params)) errors.push(`${a}.params: must be object`);
  });
}

function instance(it, at, errors) {
  if (!isObj(it)) { errors.push(`${at}: must be object`); return; }
  only(it, ['uid', 'component', 'transform', 'params', 'behaviours', 'links'], `${at}.`, errors);
  need(it, ['uid', 'component', 'transform', 'params', 'links'], `${at}.`, errors);
  if (Object.hasOwn(it, 'uid') && !(typeof it.uid === 'string' && it.uid.length >= 1)) errors.push(`${at}.uid: must be a non-empty string`);
  if (Object.hasOwn(it, 'component') && !(typeof it.component === 'string' && REF.test(it.component))) errors.push(`${at}.component: must match id@x.y.z`);
  if (Object.hasOwn(it, 'transform')) {
    const t = it.transform;
    if (!isObj(t)) errors.push(`${at}.transform: must be object`);
    else {
      only(t, ['p', 'yaw', 's'], `${at}.transform.`, errors);
      need(t, ['p', 'yaw', 's'], `${at}.transform.`, errors);
      if (Object.hasOwn(t, 'p') && !(Array.isArray(t.p) && t.p.length === 3 && t.p.every(isNum))) errors.push(`${at}.transform.p: must be 3 numbers`);
      if (Object.hasOwn(t, 'yaw') && !isNum(t.yaw)) errors.push(`${at}.transform.yaw: must be number`);
      if (Object.hasOwn(t, 's') && !(isNum(t.s) && t.s > 0)) errors.push(`${at}.transform.s: must be > 0`);
    }
  }
  if (Object.hasOwn(it, 'params') && !isObj(it.params)) errors.push(`${at}.params: must be object`);
  if (Object.hasOwn(it, 'behaviours')) behaviourList(it.behaviours, `${at}.behaviours`, errors);
  if (Object.hasOwn(it, 'links')) {
    if (!Array.isArray(it.links)) errors.push(`${at}.links: must be array`);
    else it.links.forEach((l, i) => {
      const a = `${at}.links[${i}]`;
      if (!isObj(l)) { errors.push(`${a}: must be object`); return; }
      only(l, ['socket', 'to'], `${a}.`, errors);
      need(l, ['socket', 'to'], `${a}.`, errors);
      if (Object.hasOwn(l, 'socket') && typeof l.socket !== 'string') errors.push(`${a}.socket: must be string`);
      if (Object.hasOwn(l, 'to') && !(typeof l.to === 'string' && TO.test(l.to))) errors.push(`${a}.to: must be "uid.socket"`);
    });
  }
}

export function validateScene(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['(root): must be object'] };
  only(obj, ['format', 'environment', 'world', 'areas', 'instances', 'groups', 'meta'], '', errors);
  if (Object.hasOwn(obj, 'world')) { if (!isObj(obj.world)) errors.push('world: must be object'); else { only(obj.world, ['behaviours'], 'world.', errors); if (Object.hasOwn(obj.world, 'behaviours')) behaviourList(obj.world.behaviours, 'world.behaviours', errors); } }
  need(obj, ['format', 'environment', 'instances', 'meta'], '', errors);
  if (Object.hasOwn(obj, 'format') && obj.format !== 'uew-scene@1') errors.push('format: must be equal to constant uew-scene@1');
  if (Object.hasOwn(obj, 'environment')) {
    const e = obj.environment;
    if (!isObj(e)) errors.push('environment: must be object');
    else for (const [k, v] of Object.entries(e)) {
      const rule = ENV[k];
      if (!rule) errors.push(`environment.${k}: must NOT have additional properties`);
      else if (rule === 'bool') { if (typeof v !== 'boolean') errors.push(`environment.${k}: must be boolean`); }
      else if (rule === 'num') { if (!isNum(v)) errors.push(`environment.${k}: must be number`); }
      else if (rule === 'date') { if (!(typeof v === 'string' && DATE.test(v))) errors.push(`environment.${k}: must match pattern YYYY-MM-DD`); else if (!realDay(v)) errors.push(`environment.${k}: must be a real calendar day`); }
      else if (!(isNum(v) && v >= rule[0] && v <= rule[1])) errors.push(`environment.${k}: must be a number in ${rule[0]}..${rule[1]}`);
    }
  }
  for (const list of ['areas', 'instances']) {
    if (!Object.hasOwn(obj, list)) continue;
    if (!Array.isArray(obj[list])) errors.push(`${list}: must be array`);
    else obj[list].forEach((it, i) => instance(it, `${list}[${i}]`, errors));
  }
  if (Object.hasOwn(obj, 'groups')) {
    if (!Array.isArray(obj.groups)) errors.push('groups: must be array');
    else obj.groups.forEach((g, i) => {
      const a = `groups[${i}]`;
      if (!isObj(g)) { errors.push(`${a}: must be object`); return; }
      only(g, ['id', 'name', 'members'], `${a}.`, errors);
      need(g, ['id', 'members'], `${a}.`, errors);
      if (Object.hasOwn(g, 'id') && typeof g.id !== 'string') errors.push(`${a}.id: must be string`);
      if (Object.hasOwn(g, 'name') && typeof g.name !== 'string') errors.push(`${a}.name: must be string`);
      if (Object.hasOwn(g, 'members') && !(Array.isArray(g.members) && g.members.every((m) => typeof m === 'string'))) errors.push(`${a}.members: must be an array of strings`);
    });
  }
  if (Object.hasOwn(obj, 'meta')) {
    const m = obj.meta;
    if (!isObj(m)) errors.push('meta: must be object');
    else {
      only(m, ['name', 'made_by', 'history', 'view'], 'meta.', errors);
      need(m, ['name', 'made_by'], 'meta.', errors);
      for (const k of ['name', 'made_by']) if (Object.hasOwn(m, k) && !(typeof m[k] === 'string' && m[k].length >= 1)) errors.push(`meta.${k}: must be a non-empty string`);
      if (Object.hasOwn(m, 'history') && typeof m.history !== 'string') errors.push('meta.history: must be string');
      if (Object.hasOwn(m, 'view')) { // the opening view: { p: [x, y, z], target: [x, y, z] }
        const v = m.view, vec = (q) => Array.isArray(q) && q.length === 3 && q.every((n) => typeof n === 'number' && Number.isFinite(n));
        const pt = v?.portrait;
        if (!isObj(v) || Object.keys(v).some((k) => k !== 'p' && k !== 'target' && k !== 'portrait') || !vec(v.p) || !vec(v.target)) errors.push('meta.view: must be { p: [x, y, z], target: [x, y, z] }');
        else if (pt !== undefined && (!isObj(pt) || Object.keys(pt).some((k) => k !== 'p' && k !== 'target') || !vec(pt.p) || !vec(pt.target))) errors.push('meta.view.portrait: must be { p: [x, y, z], target: [x, y, z] }');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The browser's sockets list: types only (the full accepts check runs in Node). */
export function loadSockets(json) {
  const t = isObj(json) && isObj(json.types) ? json.types : {};
  const has = (a, b) => Object.hasOwn(t, a) && isObj(t[a]) && Array.isArray(t[a].accepts) && t[a].accepts.includes(b);
  return { types: Object.keys(t), accepts: (a, b) => has(a, b) && has(b, a) };
}

/** Structural only, as lib/runtime/registry.mjs in the browser: identity and the fields a variant needs. */
export function validateComponent(c) {
  const errors = [];
  if (!isObj(c)) return { ok: false, errors: ['(root): must be an object'] };
  if (c.format !== 'uew-component@1') errors.push('format: must be uew-component@1');
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errors.push('id: invalid');
  if (typeof c.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(c.version)) errors.push('version: invalid');
  for (const k of ['en', 'ar']) if (!isObj(c.name) || typeof c.name[k] !== 'string' || !c.name[k]) errors.push(`name.${k}: required`);
  if (c.parent !== undefined && !(typeof c.parent === 'string' && REF.test(c.parent))) errors.push('parent: must match id@x.y.z');
  if (c.defaults_override !== undefined && c.parent === undefined) errors.push('defaults_override: only allowed on a variant (with parent)');
  return { ok: errors.length === 0, errors };
}
