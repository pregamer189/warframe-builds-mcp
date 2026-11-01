// Mod ranks, drain and capacity, shared by weapons and frames.
import { data, find, hasName } from "./data.mjs";

const POLARITIES = ["madurai", "vazarin", "naramon", "zenurik", "unairu", "penjaga", "umbra", "universal", "none"];

export function slotPolarity(value) {
  if (value === undefined || value === null) return undefined;
  const polarity = String(value).toLowerCase();
  if (!POLARITIES.includes(polarity)) throw new Error(`Unknown polarity: ${value}. Polarities: ${POLARITIES.join(", ")}.`);
  return polarity;
}

const scaleEffects = (effects, scale) => Object.fromEntries(Object.entries(effects).map(([k, v]) => [k, v * scale]));

export function resolveMods(entries, table) {
  if (!Array.isArray(entries)) throw new Error("Mods must be a list of names or {name, rank, slot_polarity} objects.");
  return entries.map((entry) => {
    const spec = typeof entry === "string" ? { name: entry } : entry;
    if (!spec || typeof spec !== "object") throw new Error(`Each mod must be a name or an object, but got ${JSON.stringify(entry)}.`);
    for (const key of Object.keys(spec)) {
      if (!["name", "rank", "slot_polarity"].includes(key)) throw new Error(`Unknown mod field: ${key}. Fields: name, rank, slot_polarity.`);
    }
    const other = table === data.warframeMods ? data.weaponMods : data.warframeMods;
    if (typeof spec.name === "string" && !hasName(table, spec.name) && hasName(other, spec.name)) {
      const [otherName, otherMod] = find(other, spec.name, "mod");
      throw new Error(`${otherName} is a ${otherMod.slot} mod, so it does not go on this item.`);
    }
    const [name, mod] = find(table, spec.name, "mod");
    const rank = spec.rank ?? mod.maxRank;
    if (!Number.isInteger(rank) || rank < 0 || rank > mod.maxRank) throw new Error(`${name}: rank must be a whole number from 0 to ${mod.maxRank}.`);
    const scale = (rank + 1) / (mod.maxRank + 1);
    const effects = mod.effectsByRank?.[rank] ?? scaleEffects(mod.effects, scale);
    const conditional = (mod.conditional ?? []).map((c) => ({ ...c, effects: scaleEffects(c.effects, scale) }));
    return { name, mod, rank, effects, conditional, drain: mod.baseDrain + rank, slot: slotPolarity(spec.slot_polarity) };
  });
}

const hasPolarity = (slot) => slot && slot !== "none";
const matches = (m) => m.slot === "universal" || m.slot === m.mod.polarity;

// Matching polarity halves drain, a different polarity adds 25%, an empty slot changes nothing.
function slottedDrain(m) {
  if (!hasPolarity(m.slot)) return m.drain;
  return Math.round(matches(m) ? m.drain / 2 : m.drain * 1.25);
}

// Auras and stances add capacity instead: a matching polarity doubles it and a different one removes 25%.
function bonusCapacity(mod) {
  if (!hasPolarity(mod.slot)) return mod.drain;
  return matches(mod) ? mod.drain * 2 : Math.round(mod.drain * 0.75);
}

// The wiki and WFCD differ on case in some mod names, such as "Bane of Grineer".
const conflicts = (a, b) => [a.mod.incompatible, b.mod.incompatible].some((list, i) => {
  const other = (i === 0 ? b : a).name.toLowerCase();
  return list?.some((name) => name.toLowerCase() === other);
});

export function capacityReport(mods, { reactor, aura, secondAura, level = 30 }) {
  const warnings = [];
  mods.forEach((m, i) => {
    const conflict = mods.slice(0, i).find((other) => other.name === m.name || conflicts(m, other));
    if (conflict) warnings.push(`${m.name} conflicts with ${conflict.name}: they cannot be equipped together.`);
    if (m.mod.unverified) warnings.push(`${m.name} values could not be verified and may be the weaker Flawed version.`);
    if (m.mod.pvpOnly) warnings.push(`${m.name} only works in Conclave (PvP).`);
  });
  // Capacity equals the item's rank, doubled by a Reactor or Catalyst.
  const capacity = level * (reactor ? 2 : 1) + (aura ? bonusCapacity(aura) : 0) + (secondAura ? bonusCapacity(secondAura) : 0);
  const drains = mods.map((m) => ({ mod: m.name, rank: m.rank, drain: slottedDrain(m) }));
  const used = drains.reduce((sum, d) => sum + d.drain, 0);
  if (used > capacity) warnings.push(`Over capacity by ${used - capacity}. Add polarities, lower ranks or drop a mod.`);
  return { capacity, used, remaining: capacity - used, drains, warnings };
}

// Adds up effects from any number of sources, each as {effects}.
export function totalEffects(sources) {
  const totals = {};
  for (const { effects } of sources) {
    for (const [stat, value] of Object.entries(effects)) totals[stat] = (totals[stat] ?? 0) + value;
  }
  return totals;
}

// With conditionals on, every triggered effect counts at full stacks. Off, they are listed instead of hidden.
export function conditionalEffects(sources, enabled) {
  if (!enabled) return [];
  return sources.flatMap((source) => source.conditional.map((c) => ({
    source: source.name, text: c.text, effects: scaleEffects(c.effects, c.stacks),
  })));
}

const setBonuses = (mods) => {
  const counts = new Map();
  for (const m of mods) {
    if (m.mod.set) counts.set(m.mod.set, { count: (counts.get(m.mod.set)?.count ?? 0) + 1, bonus: m.mod.setBonus });
  }
  return [...counts].map(([set, { count, bonus }]) => ({
    mod: `${set} set (${count} equipped)`,
    at_max_rank: bonus?.[Math.min(count, bonus.length) - 1]?.replace(/<[^>]+>/g, "") ?? "Set bonus not listed.",
  }));
};

// Effects the calculator cannot model, so results never hide them.
export function notCalculated(mods, { conditionalsOn }) {
  return [
    ...mods.flatMap((m) => (m.mod.other ?? []).map((effect) => ({ mod: m.name, at_max_rank: effect }))),
    ...(conditionalsOn ? [] : mods.flatMap((m) => m.conditional.map((c) => ({ mod: m.name, at_max_rank: c.text })))),
    ...setBonuses(mods),
  ];
}

// Resolves arcanes for weapons or frames, scaling their effects by rank.
export function resolveArcanes(entries, table, side) {
  if (!Array.isArray(entries)) throw new Error("Arcanes must be a list of names or {name, rank} objects.");
  return entries.map((entry) => {
    const spec = typeof entry === "string" ? { name: entry } : entry;
    const [name, arcane] = find(table, spec?.name, "arcane");
    const rank = spec.rank ?? arcane.maxRank;
    if (!Number.isInteger(rank) || rank < 0 || rank > arcane.maxRank) throw new Error(`${name}: rank must be a whole number from 0 to ${arcane.maxRank}.`);
    const scale = (rank + 1) / (arcane.maxRank + 1);
    return {
      name,
      arcane,
      rank,
      effects: scaleEffects(arcane[`${side}Effects`] ?? {}, scale),
      conditional: (arcane[`${side}Conditional`] ?? []).map((c) => ({ ...c, effects: scaleEffects(c.effects, scale) })),
    };
  });
}

// Checks a build's level: 30 unless the item can go higher, as Kuva weapons and Necramechs reach 40. Stats are for rank
// 30 and up, so lower ranks aren't accepted.
export function buildLevel(level, maxRank = 30) {
  if (level === undefined) return 30;
  if (!Number.isInteger(level) || level < 30 || level > maxRank) throw new Error(maxRank > 30 ? `level must be a whole number from 30 to ${maxRank} for this item.` : "level must be 30 for this item, the only rank it reaches.");
  return level;
}

export function checkNumbers(values, label, allowed, names) {
  for (const [key, value] of Object.entries(values)) {
    if (allowed && !allowed(key)) throw new Error(`Unknown ${label}: ${key}.${names ? ` Use: ${names.join(", ")}.` : ""}`);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} ${key} must be a number.`);
  }
}

// Puts mods in matching polarity slots, largest drain first, then uses any Forma on the largest that are left. Other
// mods take the blank slots, then any polarized slots left over, where they cost 25% more.
export function assignSlots(mods, polarities, { slots = 8, forma = 0 } = {}) {
  const open = [...polarities];
  const assigned = new Map();
  const added = [];
  const byDrain = [...mods].sort((a, b) => b.drain - a.drain);
  for (const m of byDrain) {
    const slot = open.indexOf(m.mod.polarity);
    if (slot >= 0) assigned.set(m.name, open.splice(slot, 1)[0]);
  }
  for (const m of byDrain) {
    if (assigned.has(m.name) || added.length >= forma || !m.mod.polarity || m.drain < 2) continue;
    assigned.set(m.name, m.mod.polarity);
    added.push(m.mod.polarity);
  }
  let blank = Math.max(slots - polarities.length - added.length, 0);
  for (const m of byDrain) {
    if (assigned.has(m.name)) continue;
    assigned.set(m.name, blank-- > 0 ? "none" : open.shift() ?? "none");
  }
  return { assigned, added };
}
