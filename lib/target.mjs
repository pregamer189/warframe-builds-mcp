// Damage against a chosen enemy: faction multipliers, armor and the damage bonuses that depend on them.
import { data, find, hasName, round } from "./data.mjs";

// Faction mods name the broad group, while the damage tables split it further.
const FACTION_GROUPS = {
  Grineer: "Grineer", "Kuva Grineer": "Grineer", Corpus: "Corpus", "Corpus Amalgam": "Corpus",
  Infested: "Infested", "Infested Deimos": "Infested", Orokin: "Orokin", Sentient: "Sentients", "The Murmur": "Murmur",
};

// The wiki's enemy armor formula, 90% x sqrt(armor / 2700). It differs from Warframe armor, and normal scaling never
// exceeds 2700.
export const armorReduction = (armor) => (armor <= 2700 ? 0.9 * Math.sqrt(armor / 2700) : armor / (armor + 300));

// The wiki's level scaling for armor: two curves blended between 70 and 80 levels above the enemy's base level, then a
// floor of 200 and a cap of 2700. The floor can't apply to an enemy with no armor, as there is nothing to scale.
export function armorAtLevel(baseArmor, baseLevel, level) {
  if (baseArmor <= 0) return 0;
  const over = Math.max(level - baseLevel, 0);
  const low = 1 + 0.005 * over ** 1.75;
  const high = 1 + 0.4 * over ** 0.75;
  const t = Math.min(Math.max((over - 70) / 10, 0), 1);
  const blend = t * t * (3 - 2 * t);
  return Math.min(Math.max(baseArmor * (low + (high - low) * blend), 200), 2700);
}

const STEEL_PATH_LEVELS = 100;
const TARGET_FIELDS = ["enemy", "faction", "armor", "level", "steel_path", "armor_strip"];

// A target can be plain text, as people say it, such as "Grineer" or "Heavy Gunner".
function targetSpec(target) {
  if (typeof target !== "string") return target;
  if (hasName(data.factions, target)) return { faction: target };
  if (hasName(data.enemies, target)) return { enemy: target };
  try {
    return { faction: find(data.factions, target, "faction")[0] };
  } catch {
    return { enemy: target };
  }
}

export function resolveTarget(rawTarget) {
  if (rawTarget === undefined) return undefined;
  const target = targetSpec(rawTarget);
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target must be text or an object, such as \"Grineer\" or {enemy: \"Heavy Gunner\", level: 150}.");
  for (const key of Object.keys(target)) {
    if (!TARGET_FIELDS.includes(key)) throw new Error(`Unknown target field: ${key}. Fields: ${TARGET_FIELDS.join(", ")}.`);
  }
  const { level, steel_path: steelPath = false } = target;
  if (level !== undefined && (typeof level !== "number" || !Number.isFinite(level) || level < 1)) throw new Error("target.level must be 1 or more.");
  if (typeof steelPath !== "boolean") throw new Error("target.steel_path must be true or false.");
  const [enemyName, enemy] = target.enemy ? find(data.enemies, target.enemy, "enemy") : [];
  // Steel Path adds levels but no armor of its own, and only a named enemy has a base armor to scale.
  const effectiveLevel = enemy ? (level ?? enemy.spawnLevel ?? enemy.baseLevel) + (steelPath ? STEEL_PATH_LEVELS : 0) : undefined;
  if (!enemy && target.armor === undefined && (level !== undefined || steelPath)) {
    throw new Error("Enemy level and Steel Path need a named enemy to scale, such as {enemy: \"Heavy Gunner\", level: 150}, or pass armor directly. See list_enemies.");
  }
  const factionName = target.faction ?? enemy?.faction;
  const [faction, multipliers] = factionName ? find(data.factions, factionName, "faction") : [undefined, {}];
  const fullArmor = target.armor ?? (enemy ? armorAtLevel(enemy.armor, enemy.baseLevel, effectiveLevel) : 0);
  if (typeof fullArmor !== "number" || fullArmor < 0) throw new Error("target.armor must be 0 or more.");
  const strip = target.armor_strip ?? 0;
  if (typeof strip !== "number" || strip < 0 || strip > 100) throw new Error("target.armor_strip must be a percentage from 0 to 100.");
  const armor = fullArmor * (1 - strip / 100);
  return { faction, multipliers, armor, strip, reduction: armorReduction(armor), group: FACTION_GROUPS[faction], enemy: enemyName, level: effectiveLevel, steelPath };
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
  ...(target.enemy && { enemy: target.enemy, level: target.level, steel_path: target.steelPath }),
  ...(target.faction && { faction: target.faction }),
  armor: round(target.armor),
  ...(target.strip && { armor_strip_pct: target.strip }),
  armor_damage_reduction_pct: round(target.reduction * 100),
  ...(target.faction && { damage_multipliers: target.multipliers }),
});
