#!/usr/bin/env node
// Warframe build calculator as a zero-dependency MCP server (newline-delimited JSON-RPC on stdio).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const data = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const BASE_CAPACITY = 30; // rank 30 frame or weapon, doubled by a Reactor/Catalyst
const COMPOSITES = {
  "cold+heat": "blast", "electricity+toxin": "corrosive", "heat+toxin": "gas",
  "cold+electricity": "magnetic", "electricity+heat": "radiation", "cold+toxin": "viral",
};
const ELEMENTS = ["heat", "cold", "electricity", "toxin"];

const find = (table, name, kind) => {
  const key = Object.keys(table).find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (!key) throw new Error(`Unknown ${kind}: ${name}. Add it to data.json or check the spelling.`);
  return [key, table[key]];
};
const round = (n) => Math.round(n * 100) / 100;

function resolveMods(entries, table) {
  return entries.map((entry) => {
    const spec = typeof entry === "string" ? { name: entry } : entry;
    const [name, mod] = find(table, spec.name, "mod");
    const rank = spec.rank ?? mod.maxRank;
    if (rank < 0 || rank > mod.maxRank) throw new Error(`${name}: rank must be 0-${mod.maxRank}`);
    const scale = (rank + 1) / (mod.maxRank + 1);
    const effects = Object.fromEntries(Object.entries(mod.effects).map(([k, v]) => [k, v * scale]));
    return { name, mod, rank, effects, baseDrain: mod.drain - (mod.maxRank - rank), slot: spec.slot_polarity };
  });
}

// Matching polarity halves drain, a different polarity adds 25%, an empty slot changes nothing.
function slottedDrain(m) {
  if (!m.slot) return m.baseDrain;
  return Math.round(m.slot === m.mod.polarity ? m.baseDrain / 2 : m.baseDrain * 1.25);
}

function capacityReport(mods, { reactor, aura }) {
  const warnings = [];
  const seen = new Set();
  for (const m of mods) {
    const id = m.mod.family ?? m.name;
    if (seen.has(id)) warnings.push(`${m.name} conflicts with another equipped mod (same mod or variant).`);
    seen.add(id);
  }
  let capacity = BASE_CAPACITY * (reactor ? 2 : 1);
  if (aura) {
    const a = aura.slot === undefined ? aura.baseDrain
      : aura.slot === aura.mod.polarity ? aura.baseDrain * 2 : Math.round(aura.baseDrain * 0.75);
    capacity += a;
  }
  const drains = mods.map((m) => ({ mod: m.name, rank: m.rank, drain: slottedDrain(m) }));
  const used = drains.reduce((sum, d) => sum + d.drain, 0);
  if (used > capacity) warnings.push(`Over capacity by ${used - capacity}. Add polarities, lower ranks or drop a mod.`);
  return { capacity, used, remaining: capacity - used, drains, warnings };
}

function warframeBuild({ warframe, mods = [], aura, exilus, reactor = true, base_stats }) {
  const [name, stored] = find(data.warframes, warframe, "warframe");
  const base = { ...stored, ...base_stats };
  const regular = resolveMods(mods, data.warframeMods);
  if (regular.length > 8) throw new Error("A Warframe has 8 regular mod slots.");
  for (const m of regular) if (m.mod.aura) throw new Error(`${m.name} is an aura: pass it as "aura".`);
  const auraMod = aura ? resolveMods([aura], data.warframeMods)[0] : undefined;
  const exilusMod = exilus ? resolveMods([exilus], data.warframeMods)[0] : undefined;
  const equipped = exilusMod ? [...regular, exilusMod] : regular;

  const sum = (stat) => equipped.reduce((total, m) => total + (m.effects[stat] ?? 0), 0);
  const scaled = (stat) => round(base[stat] * (1 + sum(stat) / 100));
  const efficiency = Math.min(100 + sum("efficiency"), 175);
  const health = scaled("health");
  const armor = scaled("armor");
  return {
    warframe: name,
    stats: { health, shields: scaled("shields"), armor, energy: scaled("energy") },
    abilities: {
      strength: round(100 + sum("strength")),
      duration: round(Math.max(100 + sum("duration"), 12.5)),
      range: round(Math.max(100 + sum("range"), 34)),
      efficiency: round(efficiency),
      ability_cost_multiplier: round(2 - efficiency / 100),
    },
    damage_reduction_pct: round((armor / (armor + 300)) * 100),
    effective_health: round(health / (300 / (armor + 300))),
    mod_capacity: capacityReport(equipped, { reactor, aura: auraMod }),
    data_warning: data._note,
  };
}

function combineElements(order) {
  const singles = [];
  for (const { element, value } of order) {
    const existing = singles.find((s) => s.element === element);
    if (existing) existing.value += value;
    else singles.push({ element, value });
  }
  const result = {};
  for (let i = 0; i < singles.length; i += 2) {
    const [a, b] = [singles[i], singles[i + 1]];
    if (!b) result[a.element] = a.value;
    else result[COMPOSITES[[a.element, b.element].sort().join("+")]] = a.value + b.value;
  }
  return result;
}

function weaponBuild({ weapon, mods = [], catalyst = true, base_stats }) {
  const [name, stored] = find(data.weapons, weapon, "weapon");
  const base = { ...stored, ...base_stats };
  const resolved = resolveMods(mods, data.weaponMods);
  if (resolved.length > 8) throw new Error("A weapon has 8 regular mod slots.");
  const sum = (stat) => resolved.reduce((total, m) => total + (m.effects[stat] ?? 0), 0) / 100;

  const elements = combineElements(resolved.flatMap((m) =>
    ELEMENTS.filter((e) => m.effects[e]).map((e) => ({ element: e, value: m.effects[e] }))));
  const elementalBonus = Object.values(elements).reduce((total, v) => total + v, 0) / 100;

  const moddedBase = base.damage * (1 + sum("damage"));
  const perShot = moddedBase * (1 + elementalBonus);
  const multishot = 1 + sum("multishot");
  const critChance = (base.critChance / 100) * (1 + sum("critChance"));
  const critDamage = base.critDamage * (1 + sum("critDamage"));
  const fireRate = base.fireRate * (1 + sum("fireRate"));
  const magazine = Math.round(base.magazine * (1 + sum("magazine")));
  const avgCrit = 1 + critChance * (critDamage - 1);
  const burst = perShot * multishot * avgCrit * fireRate;
  const firingTime = magazine / fireRate;

  const warnings = resolved.filter((m) => m.mod.for !== base.type)
    .map((m) => `${m.name} is a ${m.mod.for} mod, but ${name} is a ${base.type}.`);
  const capacity = capacityReport(resolved, { reactor: catalyst });
  capacity.warnings.push(...warnings);

  return {
    weapon: name,
    damage_per_shot: round(perShot),
    elements_pct: elements,
    multishot: round(multishot),
    crit_chance_pct: round(critChance * 100),
    crit_multiplier: round(critDamage),
    average_crit_multiplier: round(avgCrit),
    fire_rate: round(fireRate),
    magazine,
    burst_dps: round(burst),
    sustained_dps: round(burst * (firingTime / (firingTime + base.reload))),
    assumptions: "Before enemy armor, faction damage, status ticks and conditional bonuses.",
    mod_capacity: capacity,
    data_warning: data._note,
  };
}

function searchMods({ query = "", category = "all" }) {
  const tables = { warframe: data.warframeMods, weapon: data.weaponMods };
  const q = query.toLowerCase();
  return Object.entries(tables)
    .filter(([key]) => category === "all" || category === key)
    .flatMap(([key, table]) => Object.entries(table)
      .filter(([name, mod]) => `${name} ${Object.keys(mod.effects).join(" ")} ${mod.for ?? ""}`.toLowerCase().includes(q))
      .map(([name, mod]) => ({ name, category: key, ...mod })));
}

const modList = {
  type: "array",
  description: "Mod names, or {name, rank, slot_polarity} objects. Rank defaults to max.",
  items: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: { name: { type: "string" }, rank: { type: "number" }, slot_polarity: { type: "string", description: "madurai, vazarin, naramon, ..." } },
        required: ["name"],
      },
    ],
  },
};
const statOverride = { type: "object", description: "Overrides for stored base stats, for when data.json is out of date." };

const TOOLS = [
  {
    name: "list_warframes",
    description: "List the Warframes in the local dataset with their rank 30 base stats.",
    inputSchema: { type: "object", properties: {} },
    run: () => data.warframes,
  },
  {
    name: "list_weapons",
    description: "List the weapons in the local dataset with their base stats.",
    inputSchema: { type: "object", properties: {} },
    run: () => data.weapons,
  },
  {
    name: "search_mods",
    description: "Search mods by name, effect (for example strength or multishot) or weapon type.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, category: { type: "string", enum: ["all", "warframe", "weapon"] } },
    },
    run: searchMods,
  },
  {
    name: "warframe_build",
    description: "Calculate a Warframe build: final stats, ability stats, armor mitigation and mod capacity.",
    inputSchema: {
      type: "object",
      properties: {
        warframe: { type: "string" },
        mods: modList,
        aura: { description: "Aura mod name or {name, rank, slot_polarity}. Adds capacity." },
        exilus: { description: "Exilus mod name or {name, rank, slot_polarity}." },
        reactor: { type: "boolean", description: "Orokin Reactor installed. Default true." },
        base_stats: statOverride,
      },
      required: ["warframe"],
    },
    run: warframeBuild,
  },
  {
    name: "weapon_build",
    description: "Calculate a rifle, shotgun or pistol build: elements, crit, burst and sustained DPS, and mod capacity. Melee is not supported.",
    inputSchema: {
      type: "object",
      properties: {
        weapon: { type: "string" },
        mods: modList,
        catalyst: { type: "boolean", description: "Orokin Catalyst installed. Default true." },
        base_stats: statOverride,
      },
      required: ["weapon"],
    },
    run: weaponBuild,
  },
];

function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "warframe-builder", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
      try {
        return { content: [{ type: "text", text: JSON.stringify(tool.run(params.arguments ?? {}), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (request.id === undefined) return; // notifications get no reply
  try {
    send({ id: request.id, result: handle(request) });
  } catch (error) {
    send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
