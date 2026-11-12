// stage.js: the builder's 3D view. A copy of Boulevard City's render pipeline (Kr4T/3DPLAT round2/boulevard 3352816,
// apps/boulevard-city-3d/main.js: the renderer block and buildPipeline) and of 3DPLAT's shell stage (Kr4T/3DPLAT main
// e0d91a2, worlds/runtime/stage.js: createStage(host, { qs }), fxScene composited after the main pass), built on the r187
// example webgpu_lights_clustered_city (renderer.lighting slot for ClusteredLighting, background and fog slots, bloom)
// and the pipeline examples webgpu_postprocessing_ssr, webgpu_postprocessing_ao, webgpu_postprocessing_traa,
// webgpu_postprocessing_fxaa and webgpu_shadowmap_csm. See builder/REFERENCES.md and PROVENANCE.md.
// Presets as Boulevard: High (WebGPU) = SSR (wet paving, water) + GTAO + bloom + TRAA, CSM on the sun; Phone and ?webgl =
// bloom + FXAA. Flags: ?q=phone|high, ?webgl, ?hud (builder/hud.js), ?audit=1, ?still, ?hour=<0..24>,
// ?clouds=flat|volumetric (builder/vfx/clouds.js cloudTier).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, metalness, roughness, packNormalToRGB, unpackRGBToNormal, sample, vec2, vec4, uniform, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { createEnvironment, createCoalescer } from './environment.js';
import { cloudTier } from './vfx/clouds.js';
import { applySSRPreset } from '../shared/materials/water-ssr.js';
import { installAudit, on } from './audit.js';

/** The ceiling of the scene colour handed to the post chain (builder/stage.js sanitizeHDR): finite, far above white. */
export const HDR_MAX = 512;
export async function createStage(host, { qs = new URLSearchParams(location.search) } = {}) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const PHONE_DEVICE = coarse || Math.min(screen.width, screen.height) < 600;
  const preset = qs.get('q') === 'phone' || qs.get('q') === 'high' ? qs.get('q') : PHONE_DEVICE ? 'phone' : 'high';
  const PHONE = preset === 'phone', AUDIT = qs.has('audit'), STILL = qs.has('still');
  const W = () => host.clientWidth || innerWidth, H = () => host.clientHeight || innerHeight;

  // ---------- renderer (Boulevard): WebGPU, or WebGL 2 from WebGPURenderer itself ----------
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: qs.has('webgl'), powerPreference: 'high-performance', trackTimestamp: AUDIT });
  const BASE_PR = Math.min(devicePixelRatio, PHONE ? 1.5 : 2);
  renderer.setPixelRatio(BASE_PR);
  renderer.setSize(W(), H());
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // renderer.lighting stays the default Lighting: on WebGPU the light rig (Task 4) sets it to ClusteredLighting, as
  // webgpu_lights_clustered_city does; the stage sets no other lighting system.
  renderer.domElement.style.touchAction = 'none';
  host.appendChild(renderer.domElement);
  await renderer.init();
  const isWebGPU = !!renderer.backend.isWebGPUBackend;
  // the HUD reads a whole frame's draws and triangles (SSR, AO, bloom passes included): reset once per frame below
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  // particles live in their own scene, composited over the finished image: drawn in the main pass, their transparent
  // pixels corrupted the normal / metal-rough targets and SSR painted reflections into them (Boulevard)
  const fxScene = new THREE.Scene();

  // ---------- camera and controls ----------
  const portrait = () => W() < H();
  const camera = new THREE.PerspectiveCamera(portrait() ? 58 : 45, W() / H(), 0.5, 12000);
  camera.position.set(24, 12, 32);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.1, maxPolarAngle: 1.47, minDistance: 2, maxDistance: 900, screenSpacePanning: false });
  controls.target.set(0, 2, 0); controls.update();

  // ---------- environment: sky, sun, moon, clouds, height fog, PMREM ----------
  const CSM = preset === 'high' && isWebGPU && qs.get('csm') !== '0';
  // clouds: volumetric (webgpu_volume_cloud) on High with WebGPU, the old flat ones on Phone and ?webgl; ?clouds=flat|volumetric forces
  const CLOUDS = cloudTier({ preset, isWebGPU, force: qs.get('clouds') });
  const env = createEnvironment({ renderer, scene, preset, csm: CSM, clouds: CLOUDS, initial: qs.has('hour') ? { hour: +qs.get('hour') } : {} });
  scene.userData.environment = { get: env.get, terms: env.terms, uniforms: env.uniforms }; // what components may read
  const uBloom = uniform(0.2);
  const applyNight = () => { uBloom.value = 0.04 + 0.16 * env.terms().night; };
  applyNight();
  // the document's environment, applied at most once a frame (the latest wins: review S-a) and as the whole truth
  // (a key the document lacks takes its default: review M2)
  const envApply = createCoalescer((e) => { env.replace(e); applyNight(); window.__SCENE_FEATURES__ = features(); });

  // ---------- post: a copy of Boulevard buildPipeline (SSGI, god rays, DoF, motion blur left out: REFERENCES.md) ----------
  let pipeline = null, pipelineName = '';
  const OFF = new Set(); // features the audit switches off while it measures them
  let QOFF = new Set(); // passes the fps gate has switched off (setQuality below; builder/perf-gate.js)
  const isOff = (f) => OFF.has(f) || QOFF.has(f);
  const HIGH = () => preset === 'high' && isWebGPU;
  // The scene colour, made safe for the post chain (12 Nov 2026, Encore GPU shots: black tiles spreading from two 16,000 lm
  // lamps). A highlight that overflows the half-float target is Inf; bloom's mips turn Inf into NaN (Inf - Inf, Inf x 0)
  // and TRAA's history keeps a NaN for good, as black blocks. Every channel is brought into 0..HDR_MAX before any pass
  // reads it: max(x, 0) first, which gives 0 for a NaN (the operand that is a number), then min. HDR_MAX is far above
  // anything the tone mapping can tell from white (the lamp lens glows at 60-240), so the look does not change.
  const sanitizeHDR = (c) => vec4(c.rgb.max(0).min(HDR_MAX), c.a);
  function buildPipeline() {
    pipeline?.dispose?.();
    pipeline = new THREE.RenderPipeline(renderer);
    const fx = pass(fxScene, camera).getTextureNode(); // premultiplied particles over the finished frame
    // additive sprites push alpha past 1: clamp it, or (1 - a) turns negative and paints false colours (worlds stage)
    const overFx = (c) => vec4(c.rgb.mul(fx.a.clamp(0, 1).oneMinus()).add(fx.rgb.max(0)), 1);
    if (HIGH()) {
      const sp = pass(scene, camera);
      sp.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec2(metalness, roughness), velocity })); // webgpu_postprocessing_ssr + _traa
      const colRaw = sp.getTextureNode('output'), col = sanitizeHDR(colRaw), dep = sp.getTextureNode('depth'), nor = sp.getTextureNode('normal'), vel = sp.getTextureNode('velocity'), mr = sp.getTextureNode('metalrough');
      sp.getTexture('normal').type = THREE.UnsignedByteType; sp.getTexture('metalrough').type = THREE.UnsignedByteType;
      const sceneNormal = sample((uv) => unpackRGBToNormal(nor.sample(uv)));
      let lit = col, debugSSR = null; const names = [];
      if (!isOff('ssr') && !qs.has('nossr')) { // screen-space reflections: wet paving, glass, water
        const r = ssr(colRaw, dep, sceneNormal, { metalnessNode: mr.r, roughnessNode: mr.g }); // SSRNode reads its camera from the pass's own texture node, so it takes the raw one; what it returns is sanitised below
        // the Boulevard world's SSR preset (shared/materials/water-ssr.js, scene quality pass 11 Nov): metres, 48 steps,
        // 0.6 m thickness; the water and wet sand write their own SSR weight into metalrough (Fresnel), the paving its
        // night metalness as before
        const s = applySSRPreset(r, 'high');
        lit = col.add(sanitizeHDR(r).rgb.mul(s.intensity)); names.push('SSR');
        debugSSR = r;
      }
      let composite = vec4(lit.rgb, col.a);
      if (!isOff('gtao')) { // webgpu_postprocessing_ao: half resolution, its noise resolved by TRAA
        const aoPass = gtao(dep, sceneNormal, camera); aoPass.resolutionScale = 0.5; aoPass.radius.value = 6; aoPass.thickness.value = 2;
        composite = vec4(lit.rgb.mul(aoPass.getTextureNode().r), col.a); names.push('GTAO');
      }
      if (CSM) names.push('CSM');
      const glow = isOff('bloom') ? composite : composite.add(bloom(composite, 1.0, 0.45, 0.85).mul(uBloom));
      if (!isOff('bloom')) names.push('bloom');
      const fin = isOff('traa') ? glow : traa(glow, dep, vel, camera);
      if (!isOff('traa')) names.push('TRAA');
      pipeline.outputNode = overFx(sanitizeHDR(fin)); // again after bloom and TRAA: nothing but finite colour reaches the canvas
      // pass diagnostics (threejs-image-pipeline: every pass has a disable path and an effect-only view): ?debug=ssr shows the
      // SSR contribution alone (x4), ?debug=mr the metal/rough MRT (red: SSR weight, green: roughness)
      const dbg = qs.get('debug');
      if (dbg === 'ssr' && debugSSR) pipeline.outputNode = vec4(debugSSR.rgb.mul(4), 1);
      else if (dbg === 'mr') pipeline.outputNode = vec4(mr.r, mr.g, 0, 1);
      pipelineName = names.join(' · ') + (dbg ? ` · debug ${dbg}` : '');
    } else {
      const sp = pass(scene, camera), col = sanitizeHDR(sp.getTextureNode());
      const fin = isOff('bloom') ? col : col.add(bloom(col, 1.0, 0.4, 0.85).mul(uBloom));
      const composed = overFx(sanitizeHDR(fin));
      // anti-aliasing without TRAA: FXAA in sRGB, after tone mapping, as webgpu_postprocessing_fxaa
      if (isOff('fxaa')) pipeline.outputNode = composed; else { pipeline.outputColorTransform = false; pipeline.outputNode = fxaa(renderOutput(composed)); }
      pipelineName = [isOff('bloom') ? '' : 'bloom', isOff('fxaa') ? '' : 'FXAA'].filter(Boolean).join(' · ');
    }
  }
  buildPipeline();

  // ---------- audit features (threejs-sota checklist): every key, 'on' | 'off' | 'n.a.' ----------
  const has = (test, root = scene) => { let found = false; root.traverseVisible((o) => { if (!found && test(o)) found = true; }); return found; };
  function features() {
    const hi = HIGH();
    const clustered = isWebGPU && renderer.lighting instanceof ClusteredLighting && has((o) => (o.isPointLight || o.isSpotLight) && o.intensity > 0);
    return {
      ssgi: on(false), ssr: on(hi && !isOff('ssr') && !qs.has('nossr')), gtao: on(hi && !isOff('gtao')), ssao: on(false, true),
      traa: on(hi && !isOff('traa')), taau: on(false), csm: on(CSM), shadow_soft: on(env.sun.castShadow && env.sun.intensity > 0), bloom: on(!isOff('bloom')), dof: on(false),
      motion_blur: on(false), godrays: on(false), lensflare: on(false), height_fog: on(!!scene.fogNode && env.get().fog > 0), volumetric_fog: on(false), volumetric_cloud: on(env.clouds.kind === 'volumetric' && env.get().clouds > 0),
      sky: on(true), ocean: on(has((o) => o.userData?.water), !has((o) => o.userData?.water)), caustics: on(false, !has((o) => o.userData?.water)), clustered_lights: on(clustered),
      light_probes: on(false), vxgi: on(false), gaussian_splat: on(false), path_tracer: on(false), pmrem_env: on(!!scene.environment),
      compute_particles: on(has((o) => o.isSprite && o.userData?.vfx?.compute, fxScene)), instancing: on(has((o) => o.isInstancedMesh || o.isBatchedMesh)),
    };
  }
  const audit = await installAudit({ features, revision: THREE.REVISION, mount: host, enabled: AUDIT, measure: async (f, avg) => {
    if (f === 'shadow_soft') { env.sun.castShadow = false; const ms = await avg(); env.sun.castShadow = true; return ms; }
    OFF.add(f); buildPipeline(); const ms = await avg(); OFF.delete(f); buildPipeline(); return ms;
  }, measurable: ['ssr', 'gtao', 'bloom', 'traa', 'shadow_soft'] });

  // ---------- frame loop ----------
  const callbacks = new Set();
  let last = performance.now(), t = 0, frames = 0, envFrames = 0, shot = false, disposed = false;
  let fps = 0, fpsFrames = 0, fpsT = 0, workMs = 0, frameInfo = { draws: 0, triangles: 0 };
  renderer.setAnimationLoop(() => {
    const n = performance.now(), dt = Math.min(0.1, (n - last) / 1000); last = n; t += dt;
    controls.update();
    envApply.tick();
    env.update(camera, controls.target);
    for (const cb of [...callbacks]) { try { cb(dt, t); } catch (e) { console.error('stage onFrame callback', e); } }
    renderer.info.reset();
    pipeline.render();
    workMs = performance.now() - n; // CPU time of this frame (the GPU runs later): the fps gate's headroom signal on a 60 Hz display
    const ri = renderer.info.render; frameInfo = { draws: ri.drawCalls ?? ri.calls, triangles: ri.triangles || 0 };
    frames++; if (frames === 8) window.__READY__ = true; // tests and the gate wait for this
    fpsFrames++; fpsT += dt;
    if (fpsT > 0.5) { fps = fpsFrames / fpsT; fpsFrames = 0; fpsT = 0; if (audit.AUDIT) audit.draw(renderer, fps); }
    if (env.ready()) envFrames++;
    if (STILL && !shot && envFrames >= (preset === 'high' ? 8 : 4)) { // ?still: stop on a settled frame, for the gate's shots
      shot = true; renderer.setAnimationLoop(null); audit.done(renderer, fps);
    }
  });

  const onResize = () => { camera.aspect = W() / H(); camera.fov = portrait() ? 58 : 45; camera.updateProjectionMatrix(); renderer.setSize(W(), H()); };
  addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null; ro?.observe(host);

  const stage = {
    THREE, renderer, scene, fxScene, camera, controls, preset, isWebGPU,
    /** The document's environment (lib/runtime/scene-view.mjs): coalesced to the next frame, then env.replace. */
    setEnvironment(e) { envApply.request(e); },
    /** Apply a pending environment and bake its light now (builder/creative-ui.js: the end of a time-of-day drag). */
    flushEnvironment() { envApply.flush(); env.flush(); },
    /** The environment's current terms: elevation, day, gold, night, exposure, lamps on, searchlights shown. */
    environmentTerms: () => { envApply.flush(); return env.terms(); },
    features,
    /** The fps gate's levers (builder/perf-gate.js, lib/perf/adaptive.mjs): the pixel ratio as a share of the preset's own,
     *  post passes off by name (ssr, gtao, bloom: one pipeline rebuild when the list changes), the sun's shadow, and the
     *  LOD distance bias the scene view reads (stage.lodBias). Only what differs is touched. */
    setQuality({ pixelScale = 1, off = [], shadows = true, lod = 1 } = {}) {
      const pr = Math.max(BASE_PR * pixelScale, Math.min(BASE_PR, 0.75));
      if (Math.abs(renderer.getPixelRatio() - pr) > 1e-3) renderer.setPixelRatio(pr);
      if (off.length !== QOFF.size || off.some((f) => !QOFF.has(f))) { QOFF = new Set(off); buildPipeline(); }
      if (env.sun.castShadow !== !!shadows) env.sun.castShadow = !!shadows;
      stage.lodBias = lod;
      window.__SCENE_FEATURES__ = features();
    },
    lodBias: 1,
    onFrame(cb) { callbacks.add(cb); return () => callbacks.delete(cb); },
    dispose() {
      if (disposed) return; disposed = true;
      renderer.setAnimationLoop(null); callbacks.clear(); removeEventListener('resize', onResize); ro?.disconnect();
      controls.dispose(); audit.dispose(); pipeline?.dispose?.(); env.dispose(); renderer.dispose(); renderer.domElement.remove();
    },
  };
  // read by builder/hud.js (not part of the Stage contract)
  // which clouds this stage shows (builder/vfx/clouds.js cloudTier): read by the cloud e2e, not part of the Stage contract
  Object.defineProperty(stage, 'cloudInfo', { enumerable: false, value: () => { const { kind, quality, reason, module } = env.clouds; return { kind, quality, reason, module }; } });
  Object.defineProperty(stage, 'hudInfo', { enumerable: false, value: () => ({ fps, ...frameInfo, pipeline: pipelineName, pixelRatio: renderer.getPixelRatio(), backend: isWebGPU ? 'WebGPU' : 'WebGL 2', revision: THREE.REVISION, preset }) });
  Object.defineProperty(stage, 'workMs', { enumerable: false, get: () => workMs });
  window.__SCENE_FEATURES__ = features();
  return stage;
}
