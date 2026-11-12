// hand.mjs: a hand's frame from the rig, for holding things (lib/combat/grip.mjs, lib/behaviours/equippable.mjs). From the
// joint named `<side>Hand` (the VRM name UniRig gives it) its child chains are followed: the finger chain is the one that
// ends farthest from the wrist, the thumb chain the other. In the model's rest space:
//   x  along the fingers (wrist to the first finger joint)       the edge of a held blade leads with the knuckles
//   z  the thumb's direction, square to x                        a held blade comes out of the fist on the thumb side
//   y  z cross x                                                 the flat of a held blade faces y
//   palm  the middle of the fist: `palmAt` (0.6) of the way from the wrist to the first finger joint
// joints: [{ name, parent, p }] (lib/rig/humanoid.mjs). Pure.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function handFrame(joints, side = 'right', { palmAt = 0.6, map = null } = {}) {
  const name = map?.[`${side}Hand`] || `${side}Hand`;
  const by = new Map(joints.map((j) => [j.name, j])), hand = by.get(name);
  if (!hand) throw new Error(`hand: no joint "${name}"`);
  const kids = (n) => joints.filter((j) => j.parent === n);
  const chains = kids(name).map((c) => { const ch = [c]; for (let k = kids(c.name); k.length; k = kids(k[0].name)) ch.push(k[0]); return ch; });
  if (chains.length < 2) throw new Error(`hand: ${name} needs a finger chain and a thumb chain (found ${chains.length})`);
  const far = (ch) => Math.hypot(...sub(ch.at(-1).p, hand.p));
  chains.sort((a, b) => far(b) - far(a));
  const fingers = chains[0], thumb = chains[1];
  const toKnuckle = sub(fingers[0].p, hand.p), x = norm(toKnuckle);
  const t = sub(thumb[0].p, hand.p), z = norm(sub(t, x.map((v) => v * dot(t, x)))), y = cross(z, x);
  const palm = hand.p.map((v, i) => v + toKnuckle[i] * palmAt);
  return { hand: name, fingers: fingers[0].name, thumb: thumb[0].name, wrist: [...hand.p], palm, x, y, z };
}
