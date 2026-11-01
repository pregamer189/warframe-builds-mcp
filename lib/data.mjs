// Loads the generated game data, and finds entries by forgiving name lookups.
import { readFileSync } from "node:fs";

export const data = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
export const DATA_VERSION = `imported ${data.meta.imported}`;

export const round = (n) => Math.round(n * 100) / 100;

// "Hells Chamber" and "hell's chamber" should both find Hell's Chamber.
const normalize = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

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

export function find(table, name, kind) {
  if (typeof name !== "string" || !name.trim()) throw new Error(`Expected a ${kind} name, but got ${JSON.stringify(name)}.`);
  if (Object.hasOwn(table, name)) return [name, table[name]];
  const key = indexOf(table).get(normalize(name));
  if (!key) throw new Error(`Unknown ${kind}: ${name}. Did you mean: ${closeNames(table, name).join(", ")}?`);
  return [key, table[key]];
}
