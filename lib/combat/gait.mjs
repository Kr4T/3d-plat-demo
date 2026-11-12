// gait.mjs: how a rigged character shown as an actor gets about between attacks. The walk (lib/walk) moves the item; this
// turns its speed into the walk cycle's phase (lib/combat/moves.mjs LOCOMOTION.walk) and a blend with the guard stance:
// standing is the stance, walking the cycle, in between a mix (eased over about a quarter second). The phase follows the
// distance covered, so faster means quicker steps, and the steps lengthen with the speed (stepLength) so a run is not a
// scurry. The feet are not planted (no IK): they slide a little, more in a run. In the air the legs hold.
import { LOCOMOTION, STANCE, poseAt, fullPose, blendPose } from './moves.mjs';

/** Metres per step at a speed (m/s): 1.1 m at a 3.4 m/s walk (3 steps a second), 1.8 m at a 6.2 m/s run (3.4 a second). */
export const stepLength = (speed) => 0.25 + 0.25 * Math.max(0, speed);

/** How much farther than the walk cycle's own stride the legs reach in a full run and a full sprint (the pose is carried
 * past the cycle's keys by this much: blendPose with a weight over 1). */
export const RUN_REACH = 0.25, SPRINT_REACH = 0.55;

export function createGait({ cycle = LOCOMOTION.walk, stance = STANCE, full = 1.2, ease = 9 } = {}) {
  let phase = 0, weight = 0, reach = 1;
  return {
    get phase() { return phase; }, get weight() { return weight; },
    /** state: { speed (m/s over the ground), grounded, gait? }. `gait` is the walk's own (lib/walk/locomotion.mjs
     * createGaitState, walk.gait(): { idle, run, sprint, phase }): when it is given it is the one driver of the legs: the
     * phase is its phase (not advanced here too), the blend is 1 - idle, and the stride opens with the run and the sprint
     * (reach), so the same cycle is a run and then a sprint, not a walk played fast. Without it (an enemy the waves move,
     * a test) the speed drives the cycle as before. */
    update({ speed = 0, grounded = true, gait = null } = {}, dt = 0) {
      if (gait && Number.isFinite(gait.phase)) {
        const want = gait.airborne ? weight : Math.min(1, Math.max(0, 1 - (gait.idle ?? 1)));
        weight += (want - weight) * (1 - Math.exp(-ease * dt));
        if (want === 0 && weight < 1e-3) weight = 0;
        phase = gait.phase;
        const r = 1 + RUN_REACH * (gait.run || 0) + SPRINT_REACH * (gait.sprint || 0);
        reach += (r - reach) * (1 - Math.exp(-ease * dt));
        return this;
      }
      reach += (1 - reach) * (1 - Math.exp(-ease * dt));
      const want = grounded ? Math.min(1, Math.max(0, speed) / full) : weight;
      weight += (want - weight) * (1 - Math.exp(-ease * dt));
      if (want === 0 && weight < 1e-3) weight = 0;
      if (grounded && speed > 0.05) phase += (speed * dt) / (2 * stepLength(speed));
      return this;
    },
    get reach() { return reach; },
    pose() { const base = fullPose({}, stance); return weight > 0 ? blendPose(base, poseAt(cycle, ((phase % 1) + 1) % 1), weight * reach) : base; },
    reset() { phase = 0; weight = 0; reach = 1; },
  };
}
