// What a player recorded as changed in the game, applied on top of the game data so the numbers follow it. It's undone
// and reapplied before each tool call, so removing a record restores the original values.
import { data, find, round } from "./data.mjs";
import { loadProfile } from "./profile.mjs";

const originals = new Map();

function remember(table, name) {
  const key = `${Object.keys(data).find((tableName) => data[tableName] === table)}|${name}`;
  if (!originals.has(key)) originals.set(key, { table, name, value: Object.hasOwn(table, name) ? structuredClone(table[name]) : undefined });
}

// Restores in place, as name lookups keep hold of the same objects.
function restore() {
  for (const { table, name, value } of originals.values()) {
    if (value === undefined) delete table[name];
    else {
      for (const key of Object.keys(table[name])) delete table[name][key];
      Object.assign(table[name], value);
    }
  }
  originals.clear();
}

const itemTables = () => [data.weaponMods, data.warframeMods, data.arcanes];

function findItem(item) {
  const table = itemTables().find((candidate) => { try { find(candidate, item, "item"); return true; } catch { return false; } });
  if (!table) throw new Error(`change.item must be a mod or arcane, and I can't find "${item}". For a weapon's Condition Overload, use change.condition_overload.`);
  const [name, entry] = find(table, item, "item");
  return { table, name, entry };
}

const triggerLists = (entry) => [entry.conditional, entry.weaponConditional, entry.frameConditional].filter(Boolean);

// Checks a change and returns it with exact names, so a typo is caught when it's recorded.
export function checkChange(change) {
  const { item, stacks, effects, condition_overload: overload } = change;
  if (Boolean(item) === Boolean(overload)) throw new Error("A change needs item, for a mod or arcane, or condition_overload, for a weapon.");
  if (overload) {
    const [weapon, record] = find(data.weapons, overload.weapon, "weapon");
    if (!["adding", "multiplying", "none"].includes(overload.behavior)) throw new Error("condition_overload.behavior must be adding, multiplying or none.");
    if (overload.attack && !record.modes.some((mode) => mode.name === overload.attack)) throw new Error(`${weapon} has no attack "${overload.attack}". Modes: ${record.modes.map((mode) => mode.name).join(", ")}`);
    return { condition_overload: { ...overload, weapon } };
  }
  const { name, entry } = findItem(item);
  if (stacks !== undefined && (!Number.isInteger(stacks) || stacks < 1)) throw new Error("change.stacks must be a whole number of 1 or more.");
  if (stacks !== undefined && !triggerLists(entry).flat().length) throw new Error(`${name} has no stacking effect the calculator models, so change.stacks has nothing to change.`);
  if (stacks === undefined && !effects) throw new Error("A change to an item needs stacks or effects.");
  return { item: name, ...(stacks !== undefined && { stacks }), ...(effects && { effects }) };
}

function applyItem({ item, stacks, effects }) {
  const { table, name, entry } = findItem(item);
  remember(table, name);
  const triggers = triggerLists(entry).flat();
  if (stacks !== undefined) {
    const stacking = triggers.filter((c) => c.stacks > 1);
    for (const trigger of stacking.length ? stacking : triggers.slice(0, 1)) {
      trigger.stacks = stacks;
      const wasText = trigger.text;
      trigger.text = wasText.replace(/Stacks up to \d+x/, `Stacks up to ${stacks}x`);
      if (entry.text) entry.text = entry.text.map((line) => line.replace(wasText, trigger.text));
    }
  }
  for (const [stat, value] of Object.entries(effects ?? {})) {
    const trigger = triggers.find((c) => stat in c.effects);
    if (trigger) trigger.effects[stat] = value;
    else {
      const flat = table === data.arcanes ? (entry.weaponEffects ? "weaponEffects" : "frameEffects") : "effects";
      entry[flat] = { ...entry[flat], [stat]: value };
    }
  }
}

function applyOverload({ weapon, attack, behavior, share_pct: share = 100 }) {
  const table = data.conditionOverload;
  remember(table, weapon);
  table[weapon] ??= {};
  const modes = attack ? [attack] : data.weapons[weapon].modes.filter((mode) => !mode.aoe).map((mode) => mode.name);
  for (const mode of modes) table[weapon][mode] = { behavior, ratio: round(share) / 100, playerRecorded: true };
}

export function applyPlayerChanges() {
  restore();
  for (const { change } of loadProfile().mechanics ?? []) {
    if (!change) continue;
    try {
      if (change.condition_overload) applyOverload(change.condition_overload);
      else applyItem(change);
    } catch {
      // A record can outlive an item that was renamed, and it shouldn't stop every tool working.
    }
  }
}
