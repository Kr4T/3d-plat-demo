// combo.mjs: the combo state machine of the combo_attack behaviour. Pure (no three, no DOM): press('light' | 'heavy') and
// update(dt, timeScale) -> events. Rules:
//   idle          a light press starts the chain (moves[light], light1), a heavy press the heavy
//   during a move a press is buffered (the latest one, for `buffer` seconds of real time); from `cancelFrom` of the move's
//                 normalised time a buffered light chains to the move's `next` (none: the chain starts again), a buffered heavy
//                 starts the heavy (a finisher from any light)
//   after a move  for `grace` seconds a light press still continues the chain; later it starts at light1 again
//   hit windows   open while hit[0] <= u < hit[1] (normalised clip time); each opening has its own id (one hit per target per
//                 window is the hit sweep's rule, lib/combat/hits.mjs)
// Events: { type: 'start', move, kind } | { type: 'window', move, open, window, u } | { type: 'end', move }.
// timeScale: the hit-stop (0.05 for 60-90 ms) slows the move; buffering and grace run on real time.
export function createCombo({ moves, light = 'light1', heavy = 'heavy', buffer = 0.35, cancelFrom = 0.7, grace = 0.3, speed = 1 } = {}) {
  let phase = 'idle', move = null, t = 0, u = 0, windowOpen = false, windowId = 0, buffered = null, since = Infinity, last = null;
  const def = () => moves[move];
  function start(id, out) {
    if (windowOpen) { windowOpen = false; out.push({ type: 'window', move, open: false, window: windowId, u }); }
    move = id; t = 0; u = 0; phase = 'attack'; buffered = null;
    out.push({ type: 'start', move: id, kind: moves[id].kind });
  }
  const chainFrom = (prev) => (prev && moves[prev]?.next && moves[moves[prev].next] ? moves[prev].next : light);
  return {
    press(kind) { if (kind === 'light' || kind === 'heavy') buffered = { kind, age: 0, fresh: true }; },
    update(dt, timeScale = 1) {
      const out = [];
      // a press ages from the frame after it was made: one slow frame (longer than the buffer) must not lose it
      if (buffered) { if (buffered.fresh) buffered.fresh = false; else buffered.age += dt; if (buffered.age > buffer) buffered = null; }
      if (phase === 'idle') {
        since += dt;
        if (buffered) { const b = buffered; start(b.kind === 'heavy' ? heavy : since <= grace ? chainFrom(last) : light, out); }
        return out;
      }
      const m = def();
      t += dt * timeScale * speed; u = Math.min(1, t / m.duration);
      if (!windowOpen && u >= m.hit[0] && u < m.hit[1]) { windowOpen = true; windowId++; out.push({ type: 'window', move, open: true, window: windowId, u }); }
      if (windowOpen && u >= m.hit[1]) { windowOpen = false; out.push({ type: 'window', move, open: false, window: windowId, u }); }
      if (buffered && u >= cancelFrom) { const b = buffered, prev = move; start(b.kind === 'heavy' ? heavy : chainFrom(prev), out); return out; }
      if (u >= 1) { out.push({ type: 'end', move }); last = move; move = null; phase = 'idle'; since = 0; u = 0; t = 0; }
      return out;
    },
    state: () => ({ phase, move, t, u, windowOpen, window: windowId, buffered: buffered?.kind || null }),
    reset() { phase = 'idle'; move = null; t = 0; u = 0; windowOpen = false; buffered = null; since = Infinity; last = null; },
  };
}
