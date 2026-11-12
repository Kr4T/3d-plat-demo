// waves.mjs: the `waves` world behaviour (behaviours/waves/behaviour.json): a waves game in Play, on the rules of
// lib/combat/waves.mjs (3 waves, the caps, 6 m, mercy, win, lose, score).
//   enemies   sand ghosts: the djinn at a man's height (1.8 m), sand-tinted through its own tint param, each trailing sand
//             (fx-sand's trail, the shared pool: one draw for all of them) when the page has fx-sand; `enemy` can be the
//             nemesis instead (plain copies). Drawn by the
//             scene view as extra instances (view.setExtras, as the walk draws a player that is not in the scene): a pool of
//             `cap` made when Play starts, hidden until sent. Each carries Health and Hit reaction (the same modules, attached
//             here since they are not in the document), so the hero's combo hits them like any target.
//   their AI  small: glide to the player (swarm), come round his side (flank) or hold back (retreat), keep apart; within
//             reach, a 0.45 s wind-up then a hit through combatWorld.land (hit-stop 60 ms, a shake). They glide: the static
//             pieces have no walk of their own. Height: the player's (flat arenas).
//             They go round the scene's solid pieces: each piece with a footprint between 0.6 and 6 m across its half-width
//             is a circle they slide along (a fountain, a bench, the horse); bigger pieces (a stage) are not circles.
//   player    the walk's player item; his Health if he carries it, else one made here (`playerHealth`). His death loses.
//   screen    a 3-2-1 before wave 1, the hero's health bar (top), the waves line (wave, time, hits), the end panel (won or lost, score, best), and on a loss the enemy's
//             caption "Again?"; Enter, Space, R or a tap starts again at once (nothing is reloaded)
//   director  window.__director (builder/director/boot.js) when the scene has it: connect({ getState, apply, zones }),
//             prepare() at 70 % of a wave, decide() at its end (its own rules answer when the model is late); its spawn
//             count and zone shape the next wave, its tactic the enemies. A sandstorm is only recorded (no storm effect yet).
//             Without a director the waves run on their defaults.
//   the gap   no dead air between waves: at a wave's end the nemesis's written line is shown at once (the director's bank,
//             lib/director/banter.mjs, chosen by what just happened: a triple kill, a flawless wave, a hit from behind, low
//             health; else a plain taunt), the camera turns to the scene's nemesis for a beat when there is one, and a sand
//             swirl is asked for at the arena's edge (ctx.swirl({ on, at, radius, wave }) and the event waves_swirl: a hook
//             for the fx-sand trail, which is not on this branch). The next wave starts when the decision is in, after a
//             2 s beat, and at the 5 s deadline whatever the model does.
import { combatWorld } from '../combat/world.mjs';
import { createWaves, capFor, spawnAt, createBest } from '../combat/waves.mjs';
import { label, meter, endPanel, caption, T } from '../combat/hud.mjs';
import { EVENT_LINES, LINES } from '../director/banter.mjs';
import { directorBadge } from '../combat/game-mode.mjs';
import { scaleOf } from '../runtime/scene-view.mjs';
import * as healthB from './health.mjs';
import * as reactionB from './hit_reaction.mjs';

export const ZONES = ['north', 'east', 'south', 'west']; // the sides enemies come from when the scene has no spawn pieces
export const SPAWN_UID = /^spawn-([a-z][a-z0-9_]{0,31})$/; // a spawn piece: uid spawn-<zone>, the zone named as the AI director names it
const TEXT = {
  wave: { en: 'Wave', ar: 'الموجة' }, hits: { en: 'hits taken', ar: 'ضربات' }, next: { en: 'Next wave in', ar: 'الموجة التالية بعد' },
  won: { en: 'You held the stage', ar: 'صمدتَ على المسرح' }, lost: { en: 'You fell', ar: 'سقطتَ' }, again: { en: 'Again', ar: 'مرة أخرى' },
  askAgain: { en: 'Again?', ar: 'مرة أخرى؟' }, score: { en: 'Score', ar: 'النتيجة' }, best: { en: 'Best', ar: 'الأفضل' }, newBest: { en: 'New best', ar: 'رقم جديد' },
  needPlayer: { en: 'Waves needs a character with Player in the scene.', ar: 'الموجات تحتاج شخصية تحمل اللاعب في المشهد.' },
  speaker: { en: 'Nemesis', ar: 'الخصم' },
};
const REACH = 1.4, WINDUP = 0.45, COOLDOWN = 1.6, APART = 0.9;
// the sand ghost: the djinn's own params. On the real GPU at dusk the first tint (#d8b98c: the tint multiplies, so it only
// darkened the cloth) read as a dark brown figure: now a near-white warm tint, the material's glow (a soft rim of its own
// colour) and a thicker, paler trail
export const GHOST = { height: 1.8, tint: '#fff2d6', glow: 0.7 };
export const TRAIL = { ghost: { rate: 2.2, colour: '#f6e3b8', size: 1.35 }, swirl: { rate: 3, colour: '#f6e3b8', size: 1.3 } };

export function attach(ctx, item, params = {}) {
  const w = combatWorld(ctx);
  let p = { ...params }, game = null, pool = [], wasPlaying = false, ready = false, opening = null, session = 0;
  let obstacles = [];
  // the scene's solid pieces as circles [x, z, r] for the ghosts to go round (read once when Play opens: pieces do not move in Play)
  const readObstacles = () => (ctx.items?.() || []).flatMap((x) => {
    if (!x.transform?.p || x.uid === playerUid || SPAWN_UID.test(x.uid || '') || (x.behaviours || []).some((b) => b.type === 'solid' && b.params?.enabled === false)) return [];
    const d = ctx.registry?.get?.(x.component), fp = d?.footprint?.outline; if (!Array.isArray(fp) || !fp.length || !((d.footprint.height?.[1] ?? 1) > 0.2)) return [];
    const r = Math.max(...fp.map((q) => Math.hypot(q[0], q[1]))) * scaleOf(d, x.params || {}) * (x.transform.s || 1);
    if (['lighting', 'vegetation'].includes(d.category)) return []; // a lamp's or a palm's footprint is its arm or its crown, not what stands on the ground
    return r >= 0.6 && r <= 6 ? [{ uid: x.uid, x: x.transform.p[0], z: x.transform.p[2], r }] : [];
  });
  let badge = null;
  let count = 0, big = null, bar = null, trailMod = null, swirls = [], swirling = false;
  // fx-sand's trail behaviour (lib/behaviours/trail.mjs), only on a page that has fx-sand (ctx.fx); ctx.loadBehaviour replaces it in tests
  const loadTrail = () => { if (!ctx.fx) return Promise.resolve(null); return (trailMod ||= Promise.resolve(ctx.loadBehaviour ? ctx.loadBehaviour('trail') : import('./trail.mjs')).catch((e) => { console.warn('waves: trail', e.message); return null; })); };
  // every emitter is made once, when Play opens, and parked (rate 0) until wanted: the shared trail pool (fx-sand disposes it
  // when its last emitter goes) lives for the whole run, never rebuilt between waves; all go when Play ends
  const PARKED = { rate: 0, colour: TRAIL.ghost.colour, size: 1 };
  const openTrails = (mine) => loadTrail().then((m) => {
    if (!m || mine !== session) return;
    try {
      for (const e of pool) { e.trail = m.attach(ctx, e.item, PARKED); if (e.alive && !e.dying) e.trailIn = 2; }
      swirls = (ctx.items?.() || []).filter((x) => SPAWN_UID.test(x.uid || '') && !(x.behaviours || []).some((b) => b.type === 'trail')).map((it) => m.attach(ctx, it, swirling ? TRAIL.swirl : PARKED));
    } catch (e) { console.warn('waves: trail', e.message); }
  });
  const setTrail = (h, params) => { try { h?.onParams?.(params); } catch (e) { console.warn('waves: trail', e.message); } };
  let taunt = null, beat = null, zones = ZONES, points = null;
  // spawn zones: the scene's spawn pieces (uid spawn-<zone>) are where the enemies come from, and their names the director's zones
  const readZones = () => { const sp = (ctx.items?.() || []).map((x) => ({ m: SPAWN_UID.exec(x.uid || ''), p: x.transform?.p })).filter((x) => x.m && x.p); points = sp.length ? sp.map((x) => [x.p[0], x.p[2]]) : null; zones = sp.length >= 2 ? sp.map((x) => x.m[1]) : ZONES; };
  let playerUid = null, player = null, ownPlayerHealth = false, line = null, panel = null, unCaption = null, offs = [], storm = 0, connected = null, lastDecide = null;
  const best = createBest((() => { try { return globalThis.localStorage || null; } catch { return null; } })());
  const phone = () => ctx.stage?.preset === 'phone';
  const docNow = () => ctx.doc?.() || { format: 'uew-scene@1', areas: [], instances: ctx.items?.() || [] };
  const enemyDef = () => (ctx.registry?.list?.() || []).find((d) => d.id === p.enemy && !d.superseded_by) || null;
  const xz = (uid) => { const q = w.positionOf(uid); return [q[0], q[2], q[1]]; };

  async function open(mine) {
    playerUid = ctx.walk?.playerUid || null;
    const pItem = playerUid ? ctx.find?.(playerUid) : null, def = enemyDef();
    if (!pItem || !def) { w.notice(TEXT.needPlayer); return; }
    const cap = capFor(phone()); readZones(); obstacles = readObstacles();
    const items = Array.from({ length: cap }, (_, i) => ({ uid: `wave-enemy-${i + 1}`, component: `${def.id}@${def.version}`, transform: { p: [0, -60, 0], yaw: 0, s: 1 }, params: def.id === 'djinn' ? Object.fromEntries(Object.entries(GHOST).filter(([k]) => def.params.some((q) => q.name === k))) : {}, links: [], behaviours: [] }));
    ctx.view.setExtras(items); await ctx.view.sync(docNow());
    if (mine !== session) return;
    // a sync may have made new anchors: the actors (the armed hero) go back on theirs
    const actors = await w.actors().catch(() => null); for (const a of actors?.list?.() || []) actors.attach(a);
    pool = items.map((it, i) => { ctx.view.hide(it.uid, true); return { uid: it.uid, item: it, health: healthB.attach(ctx, it, { hp: p.enemyHealth, max: p.enemyHealth, regen: 0, dissolve: true }), reaction: reactionB.attach(ctx, it, { knockback: 3, stagger: 0 }), alive: false, dying: false, cool: 0, wind: 0, side: i % 2 ? 1 : -1, trail: null, life: 0 }; });
    const had = ctx.behaviours?.get?.(playerUid, 'health')?.handle;
    ownPlayerHealth = !had; player = had || healthB.attach(ctx, pItem, { hp: p.playerHealth, max: p.playerHealth, regen: 0, dissolve: false });
    offs = [
      w.events.on('kill', (e) => { const en = pool.find((x) => x.uid === e.uid); if (en?.alive && !en.dying) { en.dying = true; en.trailIn = 0; setTrail(en.trail, PARKED); game.kill(); w.events.emit('ghost_killed', { uid: e.uid }); } else if (e.uid === playerUid) lose(); }),
      w.events.on('hit', (e) => { if (e.uid === playerUid) game.playerHit(); }),
    ];
    game = createWaves({ waves: p.waves, first: p.first, more: p.more, breakSeconds: p.rest ?? 5, beat: Math.min(2, p.rest ?? 5), cap });
    line = label(ctx, 'wavesHud', 'top:calc(88px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);white-space:nowrap');
    // the screen: the hero's health (top, at the start of the line: left, or right in a right-to-left page), the waves line
    bar = meter(ctx, 'heroHealth', 'top:calc(68px + env(safe-area-inset-top));inset-inline-start:calc(16px + env(safe-area-inset-left));width:min(38vw,180px)');
    big = label(ctx, 'wavesCount', 'top:38%;left:50%;transform:translate(-50%,-50%);font-size:84px;font-weight:800');
    // who decides between the waves, said honestly under the waves line (lib/combat/game-mode.mjs directorBadge)
    badge = label(ctx, 'directorBadge', 'top:calc(112px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);white-space:nowrap;font-size:12px;font-weight:600;opacity:.85');
    connect(); ready = true; count = Math.max(0, +p.countdown || 0); openTrails(mine);
    if (count <= 0) for (const a of game.start()) act(a);
  }
  function close() {
    session++; ready = false; opening = null;
    for (const off of offs) off(); offs = [];
    for (const e of pool) { e.health.dispose(); e.reaction.dispose(); e.trail?.dispose?.(); e.trail = null; e.life++; }
    for (const h of swirls) h.dispose?.(); swirls = []; swirling = false;
    pool = []; if (ownPlayerHealth) player?.dispose?.(); player = null;
    line?.remove(); line = null; badge?.remove(); badge = null; bar?.remove(); bar = null; big?.remove(); big = null; count = 0; panel?.remove(); panel = null; unCaption?.(); unCaption = null; game = null;
    if (ctx.view?.setExtras) { ctx.view.setExtras([]); Promise.resolve(ctx.view.sync(docNow())).then(() => { for (const b of ctx.behaviours?.list?.('equippable') || []) b.handle?.onParams?.(b.params); }).catch((e) => console.error('waves', e)); }
  }
  // ---------- the director ----------
  function connect() {
    const d = globalThis.__director; if (!d?.connect || connected === d) return;
    try { d.connect({ getState, apply, zones }); connected = d; } catch (e) { console.warn('waves: director', e.message); }
  }
  function getState() {
    const s = game?.state(), q = playerUid ? xz(playerUid) : [0, 0], h = player?.health;
    return { ...w.events.state, player: { x: q[0], z: q[1], hp: h?.hp ?? 0, hpMax: h?.max ?? 1, zone: zones[0] }, enemies: { count: s?.alive ?? 0 }, hour: docNow().environment?.hour ?? 17, tactic: s?.tactic || 'swarm', storm: storm > 0, wave: s?.wave ?? 0 };
  }
  function apply(a) {
    if (!game || !a) return;
    if (a.type === 'spawn_ghosts') game.direct({ type: 'spawn_ghosts', zone: Math.max(0, zones.indexOf(a.zone)), count: a.count });
    else if (a.type === 'set_tactic') game.direct(a);
    else if (a.type === 'sandstorm') storm = (player?.health?.fraction ?? 1) < 0.25 ? 0 : +a.seconds || 0; // mercy: no storm under a quarter health
  }
  // ---------- what the rules say happened ----------
  function act(a) {
    if (a.type === 'spawn') spawn(a.zone);
    else if (a.type === 'prepare') { connect(); try { connected?.prepare?.(); } catch (e) { console.warn('waves: prepare', e.message); } }
    else if (a.type === 'wave_end') {
      if (a.flawless) w.events.emit('flawless_wave', { wave: a.wave });
      if (a.wave >= game.state().waves) w.events.emit('set_cleared', {});
      else {
        cover(a);
        const g = game, wave = a.wave, done = () => { if (game === g && g.state().wave === wave) g.decided(); };
        connect();
        // with no director the defaults are the decision; a decision that never comes leaves the deadline; one that throws is the defaults
        try { if (connected?.decide) lastDecide = Promise.resolve(connected.decide()).then(done, (e) => { console.warn('waves: decide', e.message); done(); }); else done(); } catch (e) { console.warn('waves: decide', e.message); done(); }
      }
    } else if (a.type === 'wave_start') { uncover(a);
    } else if (a.type === 'won') finish(true, a.score);
    w.events.emit(`waves_${a.type}`, a);
  }
  // ---------- the gap between waves ----------
  function cover(a) {
    const recent = w.events.recent(20).map((e) => e.type).reverse(), low = (player?.health?.fraction ?? 1) < 0.25;
    const key = low ? 'low_health' : a.flawless ? 'flawless_wave' : recent.find((t) => t !== 'flawless_wave' && EVENT_LINES[t]);
    const l = (key && EVENT_LINES[key]) || LINES?.nemesis?.taunt?.[(a.wave - 1) % (LINES?.nemesis?.taunt?.length || 1)] || null;
    taunt = l ? T({ en: l.en, ar: l.ar }) : null;
    unCaption?.(); unCaption = taunt ? caption(ctx, T(TEXT.speaker), taunt) : null;
    const q = xz(playerUid);
    try { ctx.swirl?.({ on: true, at: [q[0], q[2], q[1]], radius: 10, wave: a.wave }); } catch (e) { console.error('swirl', e); }
    w.events.emit('waves_swirl', { on: true, wave: a.wave });
    // the swirl itself: sand streaming from the spawn pieces at the arena's edge while the gap lasts (fx-sand's trail)
    swirling = true; for (const h of swirls) setTrail(h, TRAIL.swirl);
    // a short camera beat towards the scene's nemesis, if he stands in it; given back after 1.4 s unless the player moved it
    const nem = (ctx.items?.() || []).find((x) => typeof x.component === 'string' && x.component.startsWith('nemesis@') && x.uid !== playerUid);
    if (nem?.transform?.p && ctx.walk?.look) { const was = ctx.walk.look(), yaw = Math.atan2(q[0] - nem.transform.p[0], q[1] - nem.transform.p[2]); ctx.walk.look({ yaw }); beat = { was, yaw, left: 1.4 }; }
  }
  function uncover(a) {
    if (taunt) { unCaption?.(); unCaption = null; taunt = null; }
    swirling = false; for (const h of swirls) setTrail(h, PARKED);
    try { ctx.swirl?.({ on: false, wave: a.wave }); } catch (e) { console.error('swirl', e); }
    w.events.emit('waves_swirl', { on: false, wave: a.wave });
  }
  function spawn(zone) {
    const e = pool.find((x) => !x.alive); if (!e) { game.kill(); return; }
    const q = xz(playerUid), at = spawnAt({ player: [q[0], q[1]], points, zone });
    e.alive = true; e.dying = false; e.cool = 0.6; e.wind = 0; e.reaction.reset(); // no push left over from where it died
    // its trail of sand starts two frames on: fx-sand's emitter draws from where the anchor was the frame before (a jump is a
    // 3 m streak), so it first sees the ghost standing at the spawn point with the trail still off
    e.trailIn = 2;
    e.health.health.reset({ hp: p.enemyHealth });
    ctx.view.hide(e.uid, false); ctx.view.place(e.uid, [at[0], q[2], at[1]], Math.atan2(q[0] - at[0], q[1] - at[1]));
  }
  function lose() { if (!game) return; for (const a of game.playerDied()) { w.events.emit('waves_lost', a); finish(false, a.score); } }
  function finish(won, score) {
    const s = game.state(), b = won ? best.offer(score) : { best: best.get(), isNew: false };
    const lines = [`${T(TEXT.score)}: ${score}  (${s.time.toFixed(1)} s + ${s.hitsTaken} × 5)`, b.best === null ? '' : `${T(b.isNew ? TEXT.newBest : TEXT.best)}: ${b.best}`].filter(Boolean);
    if (!won) unCaption = caption(ctx, T(TEXT.speaker), T(TEXT.askAgain));
    panel?.remove(); panel = endPanel(ctx, { title: T(won ? TEXT.won : TEXT.lost), lines, again: T(TEXT.again), onAgain: () => handle.restart() });
  }
  function moveEnemies(dt) {
    const s = game.state(), q = xz(playerUid), fighting = s.phase === 'fighting' || s.phase === 'break';
    const live = pool.filter((e) => e.alive);
    for (const e of live) {
      e.health.update(dt); e.reaction.update(dt);
      if (e.trailIn > 0 && --e.trailIn === 0 && !e.dying) setTrail(e.trail, TRAIL.ghost);
      if (e.dying) { if (!e.health.state().sinking) { e.alive = false; e.dying = false; e.reaction.reset(); if (!ctx.view.isHidden(e.uid)) ctx.view.hide(e.uid, true); } continue; }
      if (!fighting || e.reaction.body()) continue; // pushed back: the knock-back body moves it
      const at = xz(e.uid); let dx = q[0] - at[0], dz = q[1] - at[1]; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      let mx = 0, mz = 0;
      if (s.tactic === 'retreat') { if (d < 7) { mx = -dx; mz = -dz; } }
      else if (d > REACH * 0.85) { mx = dx; mz = dz; if (s.tactic === 'flank' && d > 3) { const a = e.side * 0.9, c = Math.cos(a), sn = Math.sin(a); mx = dx * c - dz * sn; mz = dx * sn + dz * c; } }
      for (const o of live) { if (o === e || o.dying) continue; const b = xz(o.uid), ox = at[0] - b[0], oz = at[1] - b[1], od = Math.hypot(ox, oz); if (od < APART && od > 1e-3) { mx += (ox / od) * 0.8; mz += (oz / od) * 0.8; } }
      const step = p.enemySpeed * dt * w.timeScale();
      let nx = at[0] + mx * step, nz = at[1] + mz * step;
      // round the solid pieces: a step that would end inside a piece's circle ends on it, a little to one side, so it slides along
      for (const o of obstacles) { const ox = nx - o.x, oz = nz - o.z, od = Math.hypot(ox, oz), R = o.r + 0.45; if (od < R) { const k = od > 1e-3 ? 1 / od : 0, tx = k ? ox * k : 1, tz = k ? oz * k : 0; nx = o.x + tx * R - tz * e.side * step * 0.8; nz = o.z + tz * R + tx * e.side * step * 0.8; } }
      ctx.view.place(e.uid, [nx, q[2], nz], Math.atan2(dx, dz));
      e.cool -= dt;
      if (e.wind > 0) { e.wind -= dt; if (e.wind <= 0) { if (d < REACH + 0.3 && s.phase === 'fighting') w.land({ from: e.uid, uid: playerUid, point: [q[0], q[2] + 1.1, q[1]], damage: p.enemyDamage, hitStopMs: 60, shake: 0.07 }); e.cool = COOLDOWN; } }
      else if (d < REACH && e.cool <= 0) e.wind = WINDUP;
    }
  }
  const handle = {
    uid: item.uid, get zones() { return [...zones]; },
    state: () => (game ? { ...game.state(), ready, countdown: Math.max(0, Math.ceil(count)), enemies: pool.filter((e) => e.alive && !e.dying).map((e) => e.uid), player: playerUid, playerHp: player?.health?.hp ?? null, best: best.get(), over: !!panel, taunt, director: directorBadge(globalThis.__director || null), obstacles: obstacles.map((o) => ({ ...o })), trails: pool.filter((e) => e.trail && e.alive && !e.dying).length, swirls: swirling ? swirls.length : 0, directed: !!connected, storm: storm > 0 } : { phase: 'idle', ready: false }),
    getState, apply,
    /** Start again at once: wave 1, full health, no enemies; nothing is loaded. */
    restart() {
      if (!game) return;
      panel?.remove(); panel = null; unCaption?.(); unCaption = null; storm = 0; taunt = null; beat = null;
      swirling = false; for (const h of swirls) setTrail(h, PARKED);
      for (const e of pool) { if (e.alive || !ctx.view.isHidden(e.uid)) { e.alive = false; e.dying = false; ctx.view.hide(e.uid, true); } setTrail(e.trail, PARKED); e.reaction.reset(); e.health.health.reset({ hp: p.enemyHealth }); }
      player.health.reset({ hp: player.health.max });
      count = 0; big?.set('');
      for (const a of game.restart()) act(a);
    },
    update(dt) {
      const playing = w.playing();
      if (playing && !wasPlaying) { const mine = ++session; opening = open(mine).catch((e) => { console.error('waves', e); w.notice({ en: `Waves: ${e.message}`, ar: `الموجات: ${e.message}` }); }); }
      if (!playing && wasPlaying) close();
      wasPlaying = playing;
      if (!playing || !ready || !game) return;
      if (globalThis.__director && connected !== globalThis.__director) connect(); // the director boots after the page: it may arrive once Play runs
      if (ownPlayerHealth) player.update(dt);
      if (storm > 0) storm -= dt;
      if (beat && (beat.left -= dt) <= 0) { const now = ctx.walk.look(); if (Math.abs(now.yaw - beat.yaw) < 1e-3) ctx.walk.look({ yaw: beat.was.yaw }); beat = null; }
      { const b = directorBadge(globalThis.__director || null); badge?.set(b ? T(b) : ''); if (badge?.el && b) badge.el.dataset.kind = b.kind; }
      bar?.set(player.health.fraction, `${Math.round(player.health.hp)} / ${player.health.max}`);
      if (count > 0) { count -= dt; big?.set(count > 0 ? String(Math.ceil(count)) : ''); line?.set(`${T(TEXT.wave)} 1 / ${game.state().waves}`); if (count > 0) return; for (const a of game.start()) act(a); }
      for (const a of game.update(dt, { hp: player.health.fraction })) act(a);
      moveEnemies(dt);
      const s = game.state();
      line?.set(s.phase === 'break' ? `${T(TEXT.next)} ${Math.ceil(s.breakLeft)}` : `${T(TEXT.wave)} ${s.wave} / ${s.waves} · ${s.time.toFixed(0)} s · ${T(TEXT.hits)} ${s.hitsTaken}`);
    },
    onParams(next) { p = { ...next }; },
    dispose() { if (wasPlaying || ready) close(); wasPlaying = false; },
    get opening() { return opening; }, get lastDecide() { return lastDecide; },
  };
  return handle;
}
