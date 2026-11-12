// trigger.js: loop or trigger, the shared clock contract for effect components (builder kit, wave 1). Every effect piece
// (fireworks, fire and smoke, explosion, roof strobes) plays either on a loop or once when fired, so the AI chat's
// `fire_effect` tool and Make-a-clip's timeline can set one off at a chosen moment. Agreed with the builder worker
// (session_01UkE38L23wqMmxCBdpVtGUs, 11 Nov 2026): `mode` is an `affects: "effect"` enum param (never splits the batch);
// firing is not a scene patch (a moment, not state: it stays out of the undo history); and it reads only the TSL clock
// (NodeFrame.time), never the wall clock, so the clip renderer and the gate's frozen bench clock step it deterministically.
//
// The contract, on the effect handle that effect.create() returns (lib/runtime/scene-view.mjs):
//   fire(uid, { at } = {}) -> boolean   start the piece `uid` now (the last TSL clock time the effect drew at) or at
//                                       `at` seconds on the TSL clock; false when uid is not one of the effect's pieces
//                                       or the piece is in loop mode. A second fire restarts it.
//   triggers()            -> [uid]      the pieces in trigger mode (what the chat may fire).
// The component's params (component.json):
//   { "name": "mode", "type": "enum", "options": ["loop", "trigger"], "default": "loop", "affects": "effect" }
// In the shader each piece reads its age from slot i (its row in the effect): loop -> the piece's own repeating age;
// trigger -> seconds since it was fired, or NEVER (far past the end: drawn at nothing) until it is fired.
// r187 example: webgpu_compute_particles (TSL `time`, uniform arrays read per instance), as builder/vfx/fountain.js.
import { uniformArray, time, select, fract, float, Fn, OnBeforeObjectUpdate } from 'three/tsl';

export const MODES = Object.freeze(['loop', 'trigger']);
export const NEVER = -1e6; // s: a start time so far back that every effect has ended (an unfired trigger draws nothing)

/** The `mode` param's definition for a component.json (one place, so every effect states it the same way). */
export function modeParam(def = 'loop') {
  return { name: 'mode', type: 'enum', options: [...MODES], default: def, label: { en: 'Play', ar: 'التشغيل' }, affects: 'effect' };
}

/** Pure, for Node tests and the JS side: a piece's age in seconds at clock time t. */
export function ageAt({ mode, period, offset = 0, start = NEVER }, t) {
  if (mode === 'trigger') return t - start;
  const p = Math.max(1e-6, period);
  return ((((t + offset) / p) % 1) + 1) % 1 * p;
}

/**
 * The per-piece trigger table for one effect: `capacity` slots (one per piece), each with a mode, a start time and a loop
 * offset, read by the shader as uniform arrays. `ageNode(slot, period)` is the age in seconds as a TSL node.
 */
export function createTriggers(capacity) {
  const n = Math.max(1, capacity);
  const START = uniformArray(new Array(n).fill(NEVER), 'float'); // trigger: TSL clock time it was fired
  const LOOP = uniformArray(new Array(n).fill(1), 'float'); // 1 loop, 0 trigger
  const OFFSET = uniformArray(new Array(n).fill(0), 'float'); // loop: phase offset in seconds
  let uids = [], now = 0;
  const clockNode = Fn(() => { OnBeforeObjectUpdate((frame) => { now = frame.time; }); return float(0); })();
  return {
    capacity: n, START, LOOP, OFFSET,
    /** Add to any node of the effect's material (e.g. `.add(table.clockNode)`): keeps `now` at the drawn TSL time. */
    clockNode,
    get now() { return now; },
    /** Set the pieces: [{ uid, params: { mode } , offset? }]; keeps a trigger's start when the same uid stays in trigger mode. */
    set(list) {
      if (list.length > n) throw new Error(`trigger table holds ${n} pieces, got ${list.length}`);
      const keep = new Map(uids.map((u, i) => [u, START.array[i]]));
      uids = list.map((it) => it.uid);
      list.forEach((it, i) => {
        const trig = it.params?.mode === 'trigger';
        LOOP.array[i] = trig ? 0 : 1;
        OFFSET.array[i] = it.offset || 0;
        START.array[i] = trig ? (keep.get(it.uid) ?? NEVER) : NEVER;
      });
    },
    fire(uid, { at } = {}) {
      const i = uids.indexOf(uid);
      if (i < 0 || LOOP.array[i] > 0.5) return false;
      START.array[i] = Number.isFinite(at) ? at : now;
      return true;
    },
    triggers: () => uids.filter((_, i) => LOOP.array[i] < 0.5),
    /** Age in seconds of piece `slot` (a TSL int/uint node), looping on `period` (seconds, node or number). */
    ageNode(slot, period) {
      const p = float(period), loopAge = fract(time.add(OFFSET.element(slot)).div(p)).mul(p);
      return select(LOOP.element(slot).greaterThan(0.5), loopAge, time.sub(START.element(slot)));
    },
  };
}
