// stage-kit: the Big Beast concert stage's look (Kr4T/3DPLAT claude/music-video-scenes 75b3604:
// apps/music-video/models/big-beast-stage/materials.js bigBeastMaterials, scenes/stage.js loadStage for the LED wall and
// the glass cubes, scenes/led.js ledShow mode 0 / ledGrid / hsv), as ONE material. r187 examples: webgpu_loader_gltf (a
// glTF's material replaced by a node material), webgpu_tsl_editor-style procedural emission (the LED field), and
// webgpu_postprocessing_bloom_emissive (emissive parts carry the bloom). The model (components/concert-stage/stage.glb,
// joined by tools/glb-join.mjs) carries COLOR_0 = (AO, curvature, thickness, part / 10) with the parts in PARTS order;
// the music-video app made one material per part (11 draws), here each term is picked per vertex, so the piece is one
// draw. Changed for the builder: the song's uniforms (pulse, screens, palette, ledHue, t) become a slow pulse from the
// TSL clock, `show` (the screens' level) and `accent` (the cyan of the frames, strips and cubes); the wall shows led.js's
// slow colour field on its pixel grid (no IMAG feed or rendered r187 content: those need the music-video app's second
// camera); the emission follows the stage's environment (x 0.35 by day, full at night).
export const PARTS = Object.freeze(['cube_frame', 'stage_deck', 'fixture_body', 'led_cube', 'led_wall', 'led_strip', 'tray_light', 'speaker', 'stage_skirt', 'tray', 'wall_back']);

export function create(params, { THREE, TSL, preset, environment = null }) {
  const { attribute, vec2, vec3, float, mix, fract, floor, abs, clamp, length, step, smoothstep, sin, uv, positionWorld, hash, color, mx_noise_float, mx_fractal_noise_float } = TSL;
  const time = TSL.time; // the TSL clock: the piece is `animated` (the wall's field, the slow pulse)
  const p = positionWorld, baked = attribute('color', 'vec4'), ao = baked.x, curv = baked.y, part = baked.w.mul(PARTS.length - 1);
  const is = (name) => smoothstep(0.45, 0.35, abs(part.sub(PARTS.indexOf(name)))); // 1 on that part's vertices
  // pick({ part: node }, fallback): the node of the vertex's part
  const pick = (table, fallback) => Object.entries(table).reduce((acc, [k, v]) => mix(acc, v, is(k)), fallback);
  const accent = typeof params.accent === 'string' ? color(params.accent) : params.accent;
  const night = environment?.night ?? float(1);
  const screens = (typeof params.show === 'number' ? float(params.show) : params.show).mul(night.mul(0.65).add(0.35));
  const pulse = sin(time.mul(2.1)).mul(0.5).add(0.5).pow(3).mul(0.5); // a slow beat in place of the song's
  const edge = smoothstep(0.55, 0.85, curv); // convex edges: worn, brighter, smoother

  // ---- the dark parts (materials.js) ----
  const hole = step(length(fract(uv().mul(vec2(12, 12))).sub(0.5)), float(0.28)); // the trays' perforation
  const anod = vec3(0.07, 0.075, 0.08).mul(mx_noise_float(p.mul(3)).mul(0.08).add(0.92));
  const trayCol = mix(mix(anod, vec3(0.2, 0.21, 0.22), edge.mul(0.6)), vec3(0.004), hole);
  const scuff = mx_fractal_noise_float(vec3(p.x.mul(0.6), p.z.mul(0.6), 0.2), 3, 2, 0.5);
  const grille = mx_noise_float(p.mul(60)).mul(0.5).add(0.5);
  const skirtCol = vec3(0.012).mul(mx_noise_float(vec3(p.x.mul(9), p.y.mul(0.6), p.z.mul(9))).mul(0.3).add(1));

  // ---- the LED wall (stage.js led_wall with led.js's slow field, mode 0, on the wall's 2048 x 436 grid) ----
  const hsv = (h, s, v) => clamp(abs(fract(vec3(h, h, h).add(vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1), 0, 1).sub(1).mul(s).add(1).mul(v);
  const grid = vec2(2048, 436), q = uv(), px = fract(q.mul(grid));
  const pix = smoothstep(0.0, 0.2, px.x).mul(smoothstep(0.0, 0.2, px.y)).mul(0.6).add(0.4); // the LED pitch
  const qc = floor(q.mul(grid)).add(0.5).div(grid), hue = sin(time.mul(0.05)).mul(0.03); // led.js lets the hue run with the song; here it sways a little round the stage's own colours
  const c1 = mix(hsv(hue.add(0.52), float(0.85), float(1)), accent, 0.5), c2 = hsv(hue.add(0.78), float(0.9), float(1)); // the accent's cyan and a violet
  const wave = sin(qc.x.mul(4).add(time.mul(0.4)).add(sin(qc.y.mul(3).sub(time.mul(0.3))))).mul(0.5).add(0.5);
  const field = mix(c1, c2, wave).mul(wave.mul(wave).mul(0.5).add(0.1)); // darker between the bands, so the cubes read against it
  const wall = field.mul(pix).mul(screens.mul(0.9).add(0.1)).mul(1.3);

  // ---- the glass cubes (stage.js led_cube): dark glass, a lit 4 x 4 mullion grid, a few panes lit ----
  const cq = uv().mul(4), cell = floor(cq), f = fract(cq);
  const mull = smoothstep(0.03, 0.0, f.x).add(smoothstep(0.97, 1.0, f.x)).add(smoothstep(0.03, 0.0, f.y)).add(smoothstep(0.97, 1.0, f.y)).min(1);
  const pane = hash(cell.add(floor(p.xz.mul(0.31)).mul(7.1)).x.add(cell.y.mul(13.7)).add(floor(p.y.mul(0.31)).mul(3.3)));
  const warm = vec3(1.0, 0.82, 0.58); // the show's warm white (materials.js tray_light), on a share of the panes: the cubes read as lit rooms, not teal boxes
  const inner = accent.mul(uv().y.oneMinus().pow(2).mul(0.1).add(0.01)).add(accent.mul(smoothstep(0.88, 0.96, pane)).mul(0.3)).add(warm.mul(smoothstep(0.3, 0.22, pane)).mul(0.45).mul(screens.sub(1).max(0).mul(2)));
  const cube = inner.mul(screens.mul(0.7).add(0.3)).mul(pulse.mul(0.3).add(0.85)).add(accent.mul(mull).mul(pulse.mul(0.4).add(1.0)).mul(0.9).mul(screens.min(1)));

  const deckWash = screens.sub(1).max(0).mul(scuff.mul(0.3).add(0.7)).mul(pulse.mul(0.3).add(0.8)).mul(0.5);
  const m = preset === 'high' ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  m.colorNode = pick({
    cube_frame: vec3(0.05), stage_deck: mix(vec3(0.018), vec3(0.04), scuff.mul(0.5).add(0.5)), fixture_body: mix(vec3(0.03), vec3(0.09), edge.mul(0.5)),
    led_cube: vec3(0.004, 0.01, 0.012), led_wall: vec3(0.01), led_strip: vec3(0.01), tray_light: vec3(0.02),
    speaker: vec3(0.02).mul(grille.mul(0.5).add(0.75)), stage_skirt: skirtCol, tray: trayCol,
  }, vec3(0.025));
  m.roughnessNode = pick({
    cube_frame: float(0.35), stage_deck: float(0.7).add(scuff.mul(0.15)), fixture_body: float(0.45), led_cube: float(0.08), led_wall: float(0.25), led_strip: float(0.3),
    tray_light: float(0.4), speaker: float(0.85), stage_skirt: float(0.9), tray: mix(mix(float(0.42), float(0.3), edge), float(0.95), hole),
  }, float(0.6));
  m.metalnessNode = pick({ cube_frame: float(0.8), fixture_body: float(0.6), speaker: float(0.1), tray: float(0.6), stage_deck: float(0), led_cube: float(0), led_wall: float(0), led_strip: float(0), tray_light: float(0), stage_skirt: float(0) }, float(0.6));
  m.aoNode = pick({ led_cube: float(1), led_wall: float(1), led_strip: float(1), tray_light: float(1) }, ao); // the LED parts carry no baked colour
  m.emissiveNode = pick({
    cube_frame: accent.mul(pulse.mul(0.5).add(1.1)).mul(screens.mul(0.7).add(0.3)).mul(1.6),
    tray_light: vec3(1.0, 0.86, 0.66).mul(pulse.mul(0.6).add(0.8)).mul(screens.mul(0.6).add(0.4)).mul(2.2),
    // the deck and its skirt under the show's light: a warm wash that falls off from the stage's middle (only above show 1: the lights turned up)
    stage_deck: warm.mul(deckWash), stage_skirt: accent.mul(deckWash).mul(0.5),
    led_strip: accent.mul(2.0).mul(pulse.mul(1.5).add(1.2)).mul(screens.mul(0.8).add(0.2)),
    led_wall: wall, led_cube: cube,
  }, vec3(0));
  if (m.isMeshPhysicalNodeMaterial) { m.clearcoatNode = is('led_cube').mul(0.7); m.clearcoatRoughnessNode = float(0.05); }
  m.name = 'stage-kit';
  return m;
}
