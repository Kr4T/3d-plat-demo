// requires.mjs: what the combat behaviours need from the item, beyond their targets (the behaviour core checks only targets,
// lib/behaviours/targets.mjs; behaviour.json has no field for this, so the rule lives here and is listed for the core in the
// PR). The builder's edit path (builder/main.js) refuses a patch that breaks it, with a notice in English and Arabic; the
// behaviours refuse again on attach (a patch from the chat or a saved scene).
//   equippable    a rigged character: its component's slots.rig (a skinned variant and a humanoid map)
//   combo_attack  the item carries player or equippable
export const NEEDS = {
  equippable: { rig: true },
  combo_attack: { carries: ['player', 'equippable'] },
};
export const MESSAGES = {
  rig: { en: 'Equippable needs a rigged character: this one has no skeleton yet (its component has no rig).', ar: 'قابل للتجهيز يحتاج شخصية مزوّدة بهيكل عظمي: هذه لا هيكل لها بعد (مكوّنها بلا هيكل).' },
  carries: { en: 'Combo attack needs Player or Equippable on the same character first.', ar: 'الهجوم المتتابع يحتاج «اللاعب» أو «قابل للتجهيز» على الشخصية نفسها أولًا.' },
};
const isRigged = (def) => !!(def?.slots?.rig && def.slots.rig.files?.lod0 && def.slots.rig.map);

/** The reason { en, ar } a behaviour cannot go on this item, or null. item: { component, behaviours }. */
export function needsError(registry, item, type) {
  const need = NEEDS[type]; if (!need) return null;
  const def = registry?.get?.(item?.component);
  if (need.rig && !isRigged(def)) return MESSAGES.rig;
  if (need.carries && !(item?.behaviours || []).some((b) => need.carries.includes(b.type))) return MESSAGES.carries;
  return null;
}

/** The first patch in a list that breaks a need, applied in order on a copy of the items it touches -> { en, ar } or null. */
export function patchesNeedError(registry, doc, patches) {
  const items = new Map([...(doc?.areas || []), ...(doc?.instances || [])].map((x) => [x.uid, { ...x, behaviours: [...(x.behaviours || [])] }]));
  for (const p of patches || []) {
    const it = items.get(p?.uid); if (!it) continue;
    if (p.op === 'set_behaviour') {
      if (!it.behaviours.some((b) => b.type === p.type)) { const e = needsError(registry, it, p.type); if (e) return e; }
      it.behaviours = [...it.behaviours.filter((b) => b.type !== p.type), { type: p.type, params: p.params || {} }];
    } else if (p.op === 'remove_behaviour') it.behaviours = it.behaviours.filter((b) => b.type !== p.type);
  }
  return null;
}
