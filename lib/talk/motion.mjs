// motion.mjs: how a talking piece moves (Talk behaviour, 12 Nov 2026). Pure (no renderer); THREE objects are only read and
// their bone rotation or morph influence written.
// Two paths, chosen per model:
//  - rig: the model has a jaw bone (the threejs-animation skill: procedural bone control after mixer.update) or a mouth
//    morph target (morphTargetInfluences by name, as r187 webgpu_morphtargets_face drives the facecap's jawOpen); the jaw opens
//    with the amplitude.
//  - shader: neither (the HY 3D imports are static meshes): the upper part nods and sways in the vertex stage, masked by
//    height, driven by the amplitude (lib/talk/talk-node.mjs, TSL), so no rig is needed.
// The amplitude comes from the line's precomputed envelope when it has one, else from the AnalyserNode's RMS (rmsOf),
// smoothed (smoothAmp) so the jaw does not chatter.

const JAW_BONE = /jaw/i;
// mouth-open morphs as the common rigs name them: ARKit / facecap (jawOpen, mouthOpen), Ready Player Me / Oculus visemes
// (viseme_aa), VRM (aa, A), Mixamo-style (MouthOpen)
const MOUTH_MORPH = [/^jaw_?open$/i, /^mouth_?open$/i, /^viseme_?aa$/i, /^(aa|a)$/i, /^vrc\.v_aa$/i, /mouth.*open|open.*mouth/i];

/** The motion path of a model: { path: 'jaw', bone, rest } | { path: 'morph', mesh, index, name } | { path: 'shader' }. */
export function chooseMotion(object) {
  if (!object || typeof object.traverse !== 'function') return { path: 'shader' };
  let bone = null, morph = null;
  object.traverse((o) => {
    if (!bone && o.isBone && JAW_BONE.test(o.name || '')) bone = o;
    if (!morph && o.morphTargetDictionary && Array.isArray(o.morphTargetInfluences)) {
      const names = Object.keys(o.morphTargetDictionary);
      for (const re of MOUTH_MORPH) { const n = names.find((k) => re.test(k)); if (n) { morph = { mesh: o, index: o.morphTargetDictionary[n], name: n }; break; } }
    }
  });
  if (bone) return { path: 'jaw', bone, rest: bone.rotation.x };
  if (morph) return { path: 'morph', ...morph };
  return { path: 'shader' };
}

/** Jaw opening at full amplitude, radians (about 20 degrees, a speaking mouth, not a yawn). */
export const JAW_OPEN = 0.35;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Drives a rig path with the amplitude 0..1. */
export function driveRig(motion, amp) {
  const a = clamp01(+amp || 0);
  if (motion?.path === 'jaw') motion.bone.rotation.x = motion.rest + a * JAW_OPEN;
  else if (motion?.path === 'morph') motion.mesh.morphTargetInfluences[motion.index] = a;
}

/** One step of the smoothing: an exponential approach (THREE.MathUtils.damp's form), opening faster than it closes. */
export const ATTACK = 28, RELEASE = 9; // per second
export function smoothAmp(prev, target, dt) {
  const k = target > prev ? ATTACK : RELEASE;
  return prev + (target - prev) * (1 - Math.exp(-k * Math.max(0, dt)));
}

/** The RMS of a time-domain block (AnalyserNode.getFloatTimeDomainData). */
export function rmsOf(block) {
  if (!block?.length) return 0;
  let s = 0; for (let i = 0; i < block.length; i++) s += block[i] * block[i];
  return Math.sqrt(s / block.length);
}

/** The analyser RMS as a 0..1 level: speech at about -16 LUFS peaks near 0.3 rms; below a noise floor it is silence. */
export const rmsLevel = (rms) => clamp01((rms - 0.01) / 0.25);
