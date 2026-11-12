// walk.js: the Walk mode (P, or the Walk switch). The imported hero (components/hero, PR #26) walks the scene being built:
// Rapier 0.21 (vendor/rapier3d-compat-0.21.0, loaded only when Walk starts: loadRapier) through lib/walk/session.mjs, the
// level made from the registry and the scene (lib/walk/level.mjs), a fixed 60 Hz step with the figure interpolated between
// steps (web-game-kit ref/loop-and-physics.md; r187 games_fps), a follow camera whose arm the level pulls in, keyboard
// (WASD / arrows: he runs, Shift sprints, Space jumps, Q dodges, E acts, Esc leaves; r187 misc_controls_pointerlock keys), the touch stick on the
// left half of the view (pointer: coarse; in sight at rest; a full push sprints), Jump and Dodge buttons at the bottom right
// (lib/combat/hud.mjs gameButtons, shared with the combat's attacks), a drag on the right half to look, a camera that swings behind a runner by itself, a mouse drag
// to look on desktop, the first gamepad. Ported from Kr4T/3dplat-builder claude/builder-characters 293efdf builder/walk.js
// (zones, act(), the touch stick; PROVENANCE.md), now on the session and the scene view's own player instance.
// r187 examples: physics_rapier_character_controller (the controller and its capsule), physics_rapier_basic and
// physics_rapier_terrain (the level), webgl_animation_walk (third-person follow).
//   const walk = createWalk({ stage, view, registry, doc: () => editor.doc(), host, editing });
//   await walk.start();   ...   walk.stop();
// The page owns the HUD (builder/creative-ui.js hides it while walking, as Play does). This module's one overlay is the
// touch stick, drawn with the HUD's tokens.
import { createWalkSession, playerItem, PLAYER_UID } from '../lib/walk/session.mjs';
import { keyAction, wishFrom } from '../lib/walk/input.mjs';
import { insideWater } from '../lib/walk/level.mjs';
import { DT, capsuleFor } from '../lib/walk/controller.mjs';
import { nearFigures } from '../lib/walk/near.mjs';
import { recentre } from '../lib/walk/locomotion.mjs';
import { gameButtons } from '../lib/combat/hud.mjs';

const RAPIER_URL = new URL('../vendor/rapier3d-compat-0.21.0/rapier.mjs', import.meta.url).href;
let rapierP = null;
/** Rapier, imported and its WASM started on the first call only (the page never loads it until Walk starts). */
export function loadRapier() {
  if (!rapierP) rapierP = import(RAPIER_URL).then(async (m) => { const R = m.default || m; await R.init(); return R; }).catch((e) => { rapierP = null; throw e; });
  return rapierP;
}

export function createWalk({ stage, view, registry, doc, host = stage.renderer.domElement.parentElement, editing = null, onExit = null, strings = null }) {
  const { camera, controls } = stage;
  const el = stage.renderer.domElement;
  let session = null, ref = null, running = false, starting = null, off = null, acc = 0, saved = null;
  let camYaw = 0, camPitch = 0.28, dist = 4.6;
  const keys = new Set();
  const touch = { id: null, x0: 0, y0: 0, x: 0, y: 0 }, drag = { id: null, x: 0, y: 0, moved: 0, touch: false };
  let stick = null, jumpQueued = false, dodgeQueued = false, actQueued = false, padAct = false, padDodge = false;
  let figures = [], figuresAt = -1, veiledNow = new Set(); // the other characters and animals, for the camera's veil (lib/walk/near.mjs)
  let tooClose = false, hidBefore = false; // the figure hidden because the camera is on top of him
  let sinceLook = Infinity, buttonsOff = []; // seconds since the player turned the camera himself (the recentring waits)
  const coarse = () => matchMedia('(pointer: coarse)').matches;
  const label = (key, en) => { try { return strings?.getKey?.(key) || en; } catch { return en; } };
  const zones = new Set(); let near = null; const nearCbs = new Set();
  const frameMs = []; let steps = 0;
  const contactCbs = new Set();

  const onKey = (e) => {
    if (!running) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type !== 'keydown') { keys.delete(e.code); return; }
    if (a === 'exit') { api.stop(); onExit?.(); return; }
    keys.add(e.code);
    if (a === 'jump') jumpQueued = true;
    if (a === 'dodge' && !e.repeat) dodgeQueued = true;
    if (a === 'act' && !e.repeat) actQueued = true;
  };
  const onDown = (e) => {
    if (!running) return;
    const r = el.getBoundingClientRect();
    if (e.pointerType === 'touch' && e.clientX - r.left < r.width / 2 && touch.id === null) {
      touch.id = e.pointerId; touch.x0 = e.clientX; touch.y0 = e.clientY; touch.x = touch.y = 0; showStick(e.clientX - r.left, e.clientY - r.top);
    } else { drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0; drag.touch = e.pointerType === 'touch'; }
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!running) return;
    if (e.pointerId === touch.id) {
      const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0, R = 56, l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
      touch.x = (dx * k) / R; touch.y = (-dy * k) / R; moveStick(dx * k, dy * k);
    } else if (e.pointerId === drag.id) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.hypot(dx, dy);
      camYaw -= dx * 0.006; camPitch = Math.min(1.1, Math.max(-0.35, camPitch + dy * 0.004)); sinceLook = 0;
      drag.x = e.clientX; drag.y = e.clientY;
    }
  };
  const onUp = (e) => {
    if (e.pointerId === touch.id) { touch.id = null; touch.x = touch.y = 0; restStick(); }
    if (e.pointerId === drag.id) drag.id = null; // (a tap here used to jump; the Jump button does, so a short look-around never jumps)
  };
  const onWheel = (e) => { if (running) { dist = Math.min(9, Math.max(2.2, dist * (1 + Math.sign(e.deltaY) * 0.1))); e.preventDefault(); } };
  const onBlur = () => { keys.clear(); };

  function showStick(x, y) {
    if (!stick) {
      stick = document.createElement('div'); stick.className = 'walk-stick'; stick.setAttribute('aria-hidden', 'true');
      Object.assign(stick.style, { position: 'absolute', width: '112px', height: '112px', marginLeft: '-56px', marginTop: '-56px', borderRadius: '50%', border: '1px solid var(--line, rgba(255,255,255,.35))', background: 'var(--panel, rgba(20,22,28,.35))', pointerEvents: 'none', zIndex: 5 });
      const knob = document.createElement('div');
      Object.assign(knob.style, { position: 'absolute', left: '36px', top: '36px', width: '40px', height: '40px', borderRadius: '50%', background: 'var(--accent, #e9c46a)', opacity: '.9' });
      stick.appendChild(knob); host.appendChild(stick);
    }
    stick.style.left = `${x}px`; stick.style.top = `${y}px`; stick.style.opacity = '1'; stick.hidden = false; moveStick(0, 0);
  }
  const moveStick = (dx, dy) => { if (stick) stick.firstChild.style.transform = `translate(${dx}px, ${dy}px)`; };
  const hideStick = () => { if (stick) stick.hidden = true; };
  // On a touch screen the stick is always there to be seen (Kereem on his phone, 12 Nov 2026: no controls in sight): at
  // rest it sits at its home by the left thumb, clear of the home bar; a touch anywhere on the left half moves it under
  // the thumb, and letting go sends it home.
  const stickHome = () => { const r = host.getBoundingClientRect(); return [Math.min(r.width / 2 - 70, 96), r.height - 124]; };
  const restStick = () => { if (running && coarse()) { showStick(...stickHome()); stick.style.opacity = '.7'; } else hideStick(); };

  function command() {
    let pad = null;
    const gp = navigator.getGamepads?.()[0] || null;
    if (gp) {
      const dz = (v) => (Math.abs(v) > 0.15 ? v : 0);
      pad = { x: dz(gp.axes[0] || 0), y: -dz(gp.axes[1] || 0), sprint: gp.buttons[7]?.value > 0.5 || gp.buttons[6]?.value > 0.5 || !!gp.buttons[10]?.pressed };
      if (dz(gp.axes[2] || 0) || dz(gp.axes[3] || 0)) sinceLook = 0;
      camYaw -= dz(gp.axes[2] || 0) * 0.05; camPitch = Math.min(1.1, Math.max(-0.35, camPitch + dz(gp.axes[3] || 0) * 0.03));
      if (gp.buttons[0]?.pressed) jumpQueued = true;
      if (gp.buttons[1]?.pressed && !padDodge) dodgeQueued = true; padDodge = !!gp.buttons[1]?.pressed;
      if (gp.buttons[2]?.pressed && !padAct) actQueued = true; padAct = !!gp.buttons[2]?.pressed;
    }
    const c = wishFrom({ keys, stick: touch.id !== null ? { x: touch.x, y: touch.y } : null, camYaw, pad });
    c.jump = jumpQueued; jumpQueued = false;
    c.dodge = dodgeQueued; dodgeQueued = false;
    return c;
  }
  /** The other characters and animals of the scene with their size; read again every 60 steps (the waves add enemies). */
  function readFigures() {
    figuresAt = steps; figures = [];
    for (const it of doc()?.instances || []) {
      if (it.uid === session.playerUid) continue;
      const def = registry.get(it.component); if (!def || (def.category !== 'character' && def.category !== 'animal')) continue;
      const c = capsuleFor(def, { ...Object.fromEntries((def.params || []).map((q) => [q.name, q.default])), ...(it.params || {}) }), k = it.transform?.s || 1;
      figures.push({ uid: it.uid, height: c.height * k, radius: Math.max(c.radius, 0.3) * k });
    }
  }
  function veilNear(camPos) {
    if (!view.veil) return;
    if (figuresAt < 0 || steps - figuresAt >= 60) readFigures();
    const live = [];
    for (const f of figures) { const o = view.objectOf?.(f.uid); if (o && (!view.isHidden?.(f.uid) || o.children.length)) live.push({ ...f, p: [o.position.x, o.position.y, o.position.z] }); }
    const next = nearFigures(camPos, live, { near: camera.near, was: veiledNow });
    if (view.veil(next)) veiledNow = new Set(next);
  }
  function zonesTick() {
    const s = session.walk.state;
    let best = null, bd = Infinity;
    for (const z of zones) { const d = Math.hypot(s.x - z.p[0], s.z - z.p[1]); if (d <= z.r && d < bd) { bd = d; best = z; } }
    if (best !== near) { near = best; for (const cb of nearCbs) cb(near ? { label: near.label, id: near.id } : null); }
    if (actQueued) { actQueued = false; if (near) { try { near.action(); } catch (e) { console.error('walk zone', e); } } }
  }
  function frame(dt) {
    if (!session) return;
    const t0 = performance.now();
    acc = Math.min(acc + dt, 0.25);
    let cmd = api.input || command();
    while (acc >= DT) { session.step(cmd); steps++; acc -= DT; cmd = { ...cmd, jump: false, dodge: false }; }
    // the action camera: it swings behind him by itself while he runs (lib/walk/locomotion.mjs recentre), unless the
    // player is turning it or has just done so
    sinceLook = drag.id !== null ? 0 : sinceLook + dt;
    { const s = session.walk.state; camYaw = recentre(camYaw, s.yaw, s.speed || 0, session.tuning, Math.min(dt, 0.1), sinceLook); }
    const a = acc / DT;
    session.place(a);
    const cam = session.camera({ yaw: camYaw, pitch: camPitch, dist, alpha: a });
    camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
    camera.updateMatrixWorld();
    api.lastCamera = cam;
    // a character or an animal the camera is on top of (an enemy walking through it) is not drawn while it is there
    veilNear(cam.pos);
    // the camera could not keep its distance (a corner under a low roof): the figure is not drawn while it is that near,
    // so the view is never the inside of his clothes
    if (!!cam.close !== tooClose) {
      tooClose = !!cam.close;
      const uid = session.playerUid, o = view.objectOf?.(uid);
      if (tooClose) { hidBefore = !!view.isHidden?.(uid); view.hide?.(uid, true); if (o) o.visible = false; }
      else { if (o) o.visible = true; if (!hidBefore) view.hide?.(uid, false); }
    }
    zonesTick();
    frameMs.push(performance.now() - t0); if (frameMs.length > 300) frameMs.shift();
  }

  /** Where the walk starts: under the orbit target, or the nearest dry place beside it (never in the water). */
  function spawnPoint() {
    const t = controls.target, lv = session?.level;
    let p = [t.x, null, t.z];
    if (lv && insideWater(lv, p[0], p[2], -1)) {
      for (let r = 2; r < 200; r += 2) { const hit = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [t.x + r * Math.cos((k * Math.PI) / 4), t.z + r * Math.sin((k * Math.PI) / 4)]).find(([x, z]) => !insideWater(lv, x, z, -1)); if (hit) { p = [hit[0], null, hit[1]]; break; } }
    }
    return { p, yaw: 0 };
  }

  const api = {
    /** Test hook: a fixed command ({ mx, mz, sprint, jump }) instead of the devices, or null. */
    input: null,
    lastCamera: null,
    /** Test hook: drops the player to height y (a fall through the level), to show the respawn. */
    fall(y) { if (session) { session.walk.state.y = y; session.walk.state.g = 0; } },
    get running() { return running; },
    state: () => (session ? { ...session.walk.state, capsule: { ...session.capsule } } : null),
    level: () => session?.level || null,
    stats: () => (session ? { steps, step: session.walk.stats(), frame: frameMs.length ? frameMs.reduce((x, y) => x + y, 0) / frameMs.length : 0 } : null),
    player: () => ref,
    /** The gait of the walk in progress (lib/walk/locomotion.mjs): { idle, run, sprint, phase, lean, bank, airborne, speed }, or null. */
    gait: () => session?.gait() ?? null,
    tuning: () => (session ? { ...session.tuning } : null),
    playerUid: PLAYER_UID,
    rapierLoaded: () => !!rapierP,
    /** Characters the player slot can take: every character component in the registry, the hero first. */
    choices: () => registry.list().filter((d) => d.category === 'character').map((d) => d.ref).sort((x, y) => (/^hero@/.test(y) ? 1 : 0) - (/^hero@/.test(x) ? 1 : 0)),
    /** behind: the camera starts behind the hero (game mode, PLAY); else where the orbit camera was (the Walk switch). */
    async start({ ref: r = null, params = {}, spawn = null, behind = false } = {}) {
      if (running) api.stop();
      if (starting) return starting;
      starting = (async () => {
        const R = await loadRapier();
        const choices = api.choices();
        // the item carrying the `player` behaviour (behaviours/player), else the placed hero, else the kit's hero
        const found = playerItem(doc(), registry);
        // (lib/walk/session.mjs playerItem: the `player` behaviour, else the placed hero, else the scene's spawn point)
        const player = r && choices.includes(r) && r !== found.ref ? { ref: r, params, item: null, tuning: found.tuning, spawn: found.item ? { p: [found.item.transform.p[0], null, found.item.transform.p[2]], yaw: found.item.transform.yaw || 0 } : found.spawn } : found;
        const placed = !!(spawn || player.item || player.spawn); // only with none of those does the walk start by the camera target
        ref = player.ref;
        if (!ref) throw new Error('no character component to walk with');
        editing?.suspend(true);
        session = createWalkSession(R, { view, registry, doc, player, spawn: spawn || (placed ? null : { p: [controls.target.x, null, controls.target.z], yaw: 0 }) });
        if (!placed) session.respawn(spawnPoint());
        dist = session.tuning.cameraDistance || dist;
        api.playerUid = session.playerUid;
        session.physics.onContact((c) => { for (const cb of [...contactCbs]) { try { cb(c); } catch (e) { console.error('walk contact', e); } } });
        await session.showPlayer();
        saved ||= { pos: camera.position.clone(), target: controls.target.clone(), enabled: controls.enabled }; // kept across setPlayer
        controls.enabled = false;
        camYaw = behind ? session.walk.state.yaw + Math.PI : Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
        addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true); addEventListener('blur', onBlur);
        el.addEventListener('pointerdown', onDown); addEventListener('pointermove', onMove); addEventListener('pointerup', onUp); addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        el.style.touchAction = 'none';
        running = true; acc = 0; sinceLook = Infinity;
        // the phone's controls, in sight from the start: the stick at rest, and Jump and Dodge in the page's one button
        // cluster (lib/combat/hud.mjs gameButtons, window.__game.buttons: the combat's Attack and Heavy are in the same
        // one, nearer the thumb: orders 0 and 1)
        if (coarse()) {
          restStick();
          const b = gameButtons({ stage });
          buttonsOff = [b.add({ id: 'jump', label: label('walk/jump', 'Jump'), size: 60, order: 2, onDown: () => { jumpQueued = true; } }),
            b.add({ id: 'dodge', label: label('walk/dodge', 'Dodge'), size: 60, order: 3, onDown: () => { dodgeQueued = true; } })];
          b.show(true);
        }
        off = stage.onFrame((dt) => frame(dt));
        return ref;
      })();
      try { return await starting; } catch (e) { api.stop(); throw e; } finally { starting = null; }
    },
    addZone(z) { const zone = { r: 4, label: '', ...z }; zones.add(zone); return () => { zones.delete(zone); if (near === zone) near = null; }; },
    near: () => (near ? { id: near.id, label: near.label } : null),
    onNear(cb) { nearCbs.add(cb); return () => nearCbs.delete(cb); },
    act() { actQueued = true; },
    jump() { jumpQueued = true; },
    dodge() { dodgeQueued = true; },
    /** The `player` behaviour's params changed (the tuning card while walking): speeds and the camera distance now. */
    retune(uid, params) { if (session && session.playerUid === uid && params) { session.retune(params); if (params.cameraDistance) dist = params.cameraDistance; } },
    /** ctx.physics of the behaviour contract: the Rapier world of the walk in progress (null-safe while not walking). */
    physics: {
      get world() { return session?.physics.world ?? null; },
      get rapier() { return session?.physics.rapier ?? null; },
      addCollider: (shape) => session?.physics.addCollider(shape) ?? null,
      raycast: (origin, dir, max) => session?.physics.raycast(origin, dir, max) ?? null,
      onContact: (cb) => { contactCbs.add(cb); return () => contactCbs.delete(cb); }, // kept across walks
      rebuild: () => session?.physics.rebuild(),
    },
    /** The follow camera's arm: { yaw, pitch, dist } (any left out stay); for the shot list and tests. */
    look({ yaw = camYaw, pitch = camPitch, dist: d = dist } = {}) { camYaw = yaw; camPitch = Math.min(1.1, Math.max(-0.35, pitch)); dist = Math.min(9, Math.max(1, d)); return { yaw: camYaw, pitch: camPitch, dist }; },
    /** Another character in the player slot, keeping the place. */
    async setPlayer(r, params = {}) {
      if (!running) return api.start({ ref: r, params });
      const s = session.walk.state, at = { p: [s.x, null, s.z], yaw: s.yaw };
      api.stop({ keepCamera: true });
      return api.start({ ref: r, params, spawn: at });
    },
    stop({ keepCamera = false } = {}) {
      const was = running || session;
      running = false; off?.(); off = null;
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true); removeEventListener('blur', onBlur);
      el.removeEventListener('pointerdown', onDown); removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel); el.style.touchAction = '';
      keys.clear(); touch.id = null; touch.x = touch.y = 0; drag.id = null; hideStick();
      if (buttonsOff.length) { for (const off of buttonsOff) { try { off?.(); } catch (e) { console.error('walk buttons', e); } } buttonsOff = []; const b = gameButtons({ stage }); if (!b.list().length) b.show(false); }
      jumpQueued = dodgeQueued = false;
      if (near) { near = null; for (const cb of nearCbs) cb(null); }
      view.veil?.([]); veiledNow = new Set(); figuresAt = -1;
      if (session && tooClose) { const o = view.objectOf?.(session.playerUid); if (o) o.visible = true; if (!hidBefore) view.hide?.(session.playerUid, false); } tooClose = false;
      if (session) { const s = session; session = null; s.hidePlayer().catch((e) => console.error('walk: hide player', e)).finally(() => s.dispose()); }
      if (saved && !keepCamera) { camera.position.copy(saved.pos); controls.target.copy(saved.target); controls.enabled = saved.enabled; controls.update(); saved = null; }
      if (was) editing?.suspend(false);
    },
  };
  return api;
}
