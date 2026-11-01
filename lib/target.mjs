// Damage against a chosen enemy: faction multipliers, armor and the damage bonuses that depend on them.
import { data, find, round } from "./data.mjs";

// Faction mods name the broad group, while the damage tables split it further.
const FACTION_GROUPS = {
  Grineer: "Grineer", "Kuva Grineer": "Grineer", Corpus: "Corpus", "Corpus Amalgam": "Corpus",
  Infested: "Infested", "Infested Deimos": "Infested", Orokin: "Orokin", Sentient: "Sentients", "The Murmur": "Murmur",
};

// The wiki's enemy armor formula, 90% x sqrt(armor / 2700). It differs from Warframe armor, and normal scaling never
// exceeds 2700.
export const armorReduction = (armor) => (armor <= 2700 ? 0.9 * Math.sqrt(armor / 2700) : armor / (armor + 300));

export function resolveTarget(target) {
  if (target === undefined) return undefined;
  if (!target || typeof target !== "object") throw new Error("target must be an object, such as {faction: \"Grineer\", armor: 500}.");
  const [faction, multipliers] = target.faction ? find(data.factions, target.faction, "faction") : [undefined, {}];
  const armor = target.armor ?? 0;
  if (typeof armor !== "number" || armor < 0) throw new Error("target.armor must be 0 or more.");
  return { faction, multipliers, armor, reduction: armorReduction(armor), group: FACTION_GROUPS[faction] };
}

const BYPASSES_ARMOR = new Set(["true", "cinematic"]);

export function targetDamage(byType, target) {
  const result = {};
  for (const [type, value] of Object.entries(byType)) {
    const armorFactor = BYPASSES_ARMOR.has(type) ? 1 : 1 - target.reduction;
    result[type] = value * (target.multipliers[type] ?? 1) * armorFactor;
  }
  return result;
}

export const targetSummary = (target) => ({
  ...(target.faction && { faction: target.faction }),
  armor: target.armor,
  armor_damage_reduction_pct: round(target.reduction * 100),
  ...(target.faction && { damage_multipliers: target.multipliers }),
});
