// Loads the generated game data, and finds entries by forgiving name lookups.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the player's profile and any newer game data live. Nothing else is written outside the install.
export const HOME = process.env.WARFRAME_BUILDS_HOME || join(homedir(), ".warframe-builds");
export const DATA_FORMAT = 2;

// Guards against a damaged or incompatible download being used in place of the bundled data.
export function usableData(candidate) {
  const table = (name, least, valid) => {
    const entries = Object.values(candidate?.[name] ?? {});
    return entries.length >= least && entries.every(valid);
  };
  const isObject = (value) => value !== null && typeof value === "object";
  const isMod = (mod) => isObject(mod?.effects);
  return candidate?.meta?.format === DATA_FORMAT && /^\d{4}-\d{2}-\d{2}$/.test(candidate.meta.imported ?? "")
    && table("warframes", 100, (frame) => typeof frame?.health === "number" && Array.isArray(frame.abilities))
    && table("weapons", 650, (weapon) => Array.isArray(weapon?.modes) && weapon.modes.length > 0)
    && table("warframeMods", 400, isMod) && table("weaponMods", 500, isMod)
    && table("arcanes", 100, (arcane) => Array.isArray(arcane?.text))
    && table("enemies", 500, (enemy) => typeof enemy?.armor === "number" && typeof enemy.baseLevel === "number")
    && table("companions", 10, isObject) && table("archwings", 1, isObject) && table("necramechs", 1, isObject)
    && table("factions", 5, isObject) && table("stances", 10, isObject) && table("heavyMultipliers", 5, (n) => typeof n === "number")
    && isObject(candidate.modular?.zaw) && isObject(candidate.modular?.kitgun);
}

function loadData() {
  const bundled = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
  try {
    const cached = JSON.parse(readFileSync(join(HOME, "data.json"), "utf8"));
    if (usableData(cached) && cached.meta.imported > bundled.meta.imported) return cached;
  } catch {
    // No download yet, or a damaged one: the bundled data always works.
  }
  return bundled;
}

export const data = loadData();
export const DATA_VERSION = `imported ${data.meta.imported}`;

export const round = (n) => Math.round(n * 100) / 100;

// "Hells Chamber" and "hell's chamber" should both find Hell's Chamber.
export const normalize = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

const indexes = new WeakMap();
function indexOf(table) {
  if (!indexes.has(table)) {
    indexes.set(table, new Map(Object.keys(table).map((key) => [normalize(key), key])));
  }
  return indexes.get(table);
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function closeNames(table, name) {
  const wanted = normalize(name);
  const words = String(name).toLowerCase().split(/\s+/).filter(Boolean);
  return Object.keys(table)
    .map((key) => {
      const text = key.toLowerCase();
      const shared = words.filter((word) => text.includes(word)).length;
      return { key, score: editDistance(wanted, normalize(key)) - shared * 4 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map(({ key }) => key);
}

// Names players shorten so often that a lookup should understand them.
const ALIASES = { co: "Condition Overload", br: "Blood Rush", ww: "Weeping Wounds", pp: "Pressure Point", gc: "Galvanized Chamber", ga: "Galvanized Aptitude" };

// A name counts as partial when it starts at a word, so "Bramma" finds Kuva Bramma but "ramma" does not.
function partialMatches(table, wanted) {
  if (wanted.length < 3) return [];
  return Object.keys(table).filter((key) => {
    const words = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.some((_, i) => words.slice(i).join("").startsWith(wanted));
  });
}

export const hasName = (table, name) => indexOf(table).has(normalize(name));

export function find(table, name, kind) {
  if (typeof name !== "string" || !name.trim()) throw new Error(`Expected a ${kind} name, but got ${JSON.stringify(name)}.`);
  if (Object.hasOwn(table, name)) return [name, table[name]];
  const wanted = normalize(name);
  const key = indexOf(table).get(wanted);
  if (key) return [key, table[key]];
  const alias = Object.hasOwn(ALIASES, wanted) ? ALIASES[wanted] : undefined;
  if (alias && Object.hasOwn(table, alias)) return [alias, table[alias]];
  const partial = partialMatches(table, wanted);
  if (partial.length === 1) return [partial[0], table[partial[0]]];
  if (partial.length > 1) throw new Error(`"${name}" matches several: ${partial.slice(0, 8).join(", ")}${partial.length > 8 ? ", ..." : ""}. Pick one.`);
  throw new Error(`Unknown ${kind}: ${name}. Did you mean: ${closeNames(table, name).join(", ")}?`);
}
