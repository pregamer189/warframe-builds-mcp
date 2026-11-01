#!/usr/bin/env node
// Warframe build calculator as a zero-dependency MCP server (newline-delimited JSON-RPC on stdio).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_VERSION, data } from "./lib/data.mjs";
import { warframeBuild } from "./lib/frames.mjs";
import { suggestWarframeBuild, suggestWeaponBuild } from "./lib/suggest.mjs";
import { weaponBuild } from "./lib/weapons.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const LIMITS = [
  "Results are theoretical averages from community-maintained data, and were not checked in-game.",
  "Excludes weak points, shields, armor stripped by status, and most ability buffs unless passed through extra_effects.",
  "Set bonuses and effects the calculator cannot model are listed in not_calculated.",
];

function modMatches(mod, category) {
  if (category === "all") return true;
  if (category === "aura") return Boolean(mod.aura);
  if (category === "exilus") return Boolean(mod.exilus);
  if (category === "stance") return Boolean(mod.stance);
  return mod.slot === category;
}

function searchMods({ query = "", category = "all", limit = 20, include_pvp = false }) {
  const q = query.toLowerCase();
  const text = (name, mod) => [
    name, Object.keys(mod.effects).join(" "), mod.compat, (mod.other ?? []).join(" "), (mod.conditional ?? []).map((c) => c.text).join(" "),
  ].join(" ").toLowerCase();
  const matches = Object.entries({ ...data.warframeMods, ...data.weaponMods })
    .filter(([, mod]) => modMatches(mod, category) && (include_pvp || !mod.pvpOnly))
    .filter(([name, mod]) => text(name, mod).includes(q))
    .sort(([a], [b]) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b));
  return {
    total: matches.length,
    mods: matches.slice(0, limit).map(([name, { effectsByRank, setBonus, ...mod }]) => ({ name, ...mod })),
  };
}

function searchArcanes({ query = "", type, limit = 20 }) {
  const q = query.toLowerCase();
  const matches = Object.entries(data.arcanes)
    .filter(([, arcane]) => !type || arcane.type === type.toLowerCase())
    .filter(([name, arcane]) => `${name} ${arcane.text.join(" ")}`.toLowerCase().includes(q))
    .sort(([a], [b]) => a.localeCompare(b));
  return { total: matches.length, arcanes: matches.slice(0, limit).map(([name, arcane]) => ({ name, ...arcane })) };
}

function listEntries(table, { query = "", type, limit = 25 }) {
  const q = query.toLowerCase();
  const matches = Object.entries(table)
    .filter(([name]) => name.toLowerCase().includes(q))
    .filter(([, entry]) => !type || [entry.type, entry.slot].some((value) => value?.toLowerCase() === type.toLowerCase()));
  return { total: matches.length, results: Object.fromEntries(matches.slice(0, limit)) };
}

const FRAME_TABLES = () => ({ warframe: data.warframes, companion: data.companions, archwing: data.archwings, necramech: data.necramechs });

function listModularParts({ kind }) {
  const { zaw, kitgun } = data.modular;
  if (kind === "zaw") return { strikes: zaw.strikes, grips: zaw.grips, links: zaw.links };
  return {
    secondary: { chambers: Object.keys(kitgun.secondary.chambers), grips: kitgun.secondary.grips, loaders: kitgun.secondary.loaders },
    primary: { chambers: Object.keys(kitgun.primary.chambers), grips: kitgun.primary.grips, loaders: kitgun.primary.loaders },
  };
}

function dataInfo() {
  const count = (table) => Object.keys(table).length;
  const pvp = Object.values({ ...data.warframeMods, ...data.weaponMods }).filter((mod) => mod.pvpOnly).length;
  return {
    server_version: version,
    data: DATA_VERSION,
    sources: data.meta.sources,
    note: data.meta.note,
    coverage: {
      warframes: count(data.warframes), companions: count(data.companions), archwings: count(data.archwings), necramechs: count(data.necramechs),
      weapons: count(data.weapons), mods: count(data.warframeMods) + count(data.weaponMods), pvp_only_mods: pvp, arcanes: count(data.arcanes),
      stances_with_timing: count(data.stances), factions: Object.keys(data.factions),
      zaw_strikes: count(data.modular.zaw.strikes), kitgun_chambers: count(data.modular.kitgun.primary.chambers),
    },
    limits: LIMITS,
  };
}

const modList = {
  type: "array",
  description: "Mod names, or {name, rank, slot_polarity} objects. Rank defaults to max. Use slot_polarity \"none\" for an empty slot.",
  items: {
    anyOf: [
      { type: "string" },
      {
        type: "object",
        properties: { name: { type: "string" }, rank: { type: "number" }, slot_polarity: { type: "string", description: "madurai, vazarin, naramon, zenurik, unairu, penjaga, umbra, universal or none." } },
        required: ["name"],
      },
    ],
  },
};
const modNames = { type: "array", items: { type: "string" } };
const queryProps = { query: { type: "string", description: "Part of a name." }, limit: { type: "number" } };
const modSpec = (label) => ({ type: ["string", "object"], description: `${label} name or {name, rank, slot_polarity}.` });
const arcaneList = { type: "array", description: "Arcane names or {name, rank} objects. Their triggered effects count when conditionals is true.", items: { type: ["string", "object"] } };
const conditionalsProp = { type: "boolean", description: "Count triggered effects, such as Galvanized mods and arcanes, at full stacks. Gives a peak figure. Default false." };
const extraEffects = { type: "object", description: "Extra percentage bonuses for buffs this tool cannot see, by effect name, such as {damage: 50, critChance: 25}." };
const targetProp = { type: "object", description: "The enemy: {faction, armor}. Applies faction damage multipliers, armor reduction and faction mods. See data_info for factions.", properties: { faction: { type: "string" }, armor: { type: "number" } } };
const weaponSource = {
  weapon: { type: "string", description: "Weapon name. Use this, zaw or kitgun." },
  zaw: { type: "object", description: "A Zaw from parts: {strike, grip, link}. See list_modular_parts.", properties: { strike: { type: "string" }, grip: { type: "string" }, link: { type: "string" } }, required: ["strike", "grip", "link"] },
  kitgun: { type: "object", description: "A Kitgun from parts: {chamber, grip, loader}. See list_modular_parts.", properties: { chamber: { type: "string" }, grip: { type: "string" }, loader: { type: "string" } }, required: ["chamber", "grip", "loader"] },
};
const meleeProps = {
  stance: { ...modSpec("Melee only. Stance mod"), description: "Melee only. Stance mod name or {name, rank, slot_polarity}. Adds capacity and gives per-combo DPS. Defaults to the weapon's stance polarity." },
  combo_multiplier: { type: "number", description: "Melee only. Combo multiplier from 1 to 12. Scales heavy attacks, Blood Rush and Weeping Wounds." },
};
const statusTypes = { type: "number", description: "Status types on the enemy, for mods such as Condition Overload. Default 0." };
const rivenProp = { type: "object", description: "A Riven with your rolled stats: {effects, polarity, drain, slot_polarity}, such as {effects: {critChance: 120, multishot: 90}, polarity: \"madurai\", drain: 18}. Fills a regular slot.", properties: { effects: { type: "object" }, polarity: { type: "string" }, drain: { type: "number" }, slot_polarity: { type: "string" } }, required: ["effects"] };
const levelProp = { type: "number", description: "The item's rank, which sets its capacity. Default 30. Kuva and Tenet-style weapons and Necramechs can reach 40." };
const statGoals = "strength, duration, range, efficiency, health, shields, armor, energy or effective_health";

const TOOLS = [
  {
    name: "list_warframes",
    description: "Find Warframes, companions, Archwings or Necramechs by name, with stats, polarities and abilities.",
    inputSchema: { type: "object", properties: { ...queryProps, kind: { type: "string", enum: ["warframe", "companion", "archwing", "necramech"], description: "Default warframe." } } },
    run: ({ kind = "warframe", ...args }) => listEntries(FRAME_TABLES()[kind], args),
  },
  {
    name: "list_weapons",
    description: "Find primary, secondary, melee, Exalted, Archwing and companion weapons by name or type, with attack modes and stats.",
    inputSchema: {
      type: "object",
      properties: { ...queryProps, type: { type: "string", description: "A class such as Rifle, Shotgun, Bow, Nikana or Exalted Weapon, or a slot: primary, shotgun, secondary, melee, archgun, archmelee or claws." } },
    },
    run: (args) => listEntries(data.weapons, args),
  },
  {
    name: "list_modular_parts",
    description: "List the parts for building a Zaw or Kitgun with weapon_build.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["zaw", "kitgun"] } }, required: ["kind"] },
    run: listModularParts,
  },
  {
    name: "search_mods",
    description: "Search mods by name, effect (for example strength or multishot) or effect text. Leaves out PvP-only mods unless asked.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string", enum: ["all", "warframe", "aura", "exilus", "primary", "shotgun", "secondary", "melee", "stance", "archgun", "archmelee", "claws", "companion", "archwing", "necramech"] },
        include_pvp: { type: "boolean", description: "Include Conclave-only mods. Default false." },
        limit: { type: "number" },
      },
    },
    run: searchMods,
  },
  {
    name: "search_arcanes",
    description: "Search arcanes by name or effect text.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, type: { type: "string", description: "warframe, primary, shotgun, bow, secondary, melee, zaw, kitgun, operator or amp." }, limit: { type: "number" } } },
    run: searchArcanes,
  },
  {
    name: "warframe_build",
    description: "Calculate a Warframe, companion, Archwing or Necramech build: final stats, ability stats, armor mitigation and mod capacity.",
    inputSchema: {
      type: "object",
      properties: {
        warframe: { type: "string", description: "Name of a Warframe, companion, Archwing or Necramech." },
        mods: modList,
        aura: modSpec("Warframes only. Aura mod"),
        second_aura: modSpec("Jade only. Second aura mod"),
        exilus: modSpec("Exilus mod"),
        reactor: { type: "boolean", description: "Orokin Reactor installed. Default true." },
        level: levelProp,
        archon_shards: { type: "array", description: "Up to 5 shards, as a stat name or {stat, tauforged}: strength, duration, health, shields, armor or energy.", items: { type: ["string", "object"] } },
        arcanes: arcaneList,
        conditionals: conditionalsProp,
        extra_effects: extraEffects,
        base_stats: { type: "object", description: "Overrides for health, shields, armor or energy." },
      },
      required: ["warframe"],
    },
    run: warframeBuild,
  },
  {
    name: "weapon_build",
    description: "Calculate a weapon, Zaw or Kitgun build: damage by type, crit, status, damage over time, DPS and mod capacity. Melee results add range, heavy attacks and per-combo stance DPS. Pass target for damage against an enemy.",
    inputSchema: {
      type: "object",
      properties: {
        ...weaponSource,
        mods: modList,
        riven: rivenProp,
        exilus: modSpec("Exilus mod"),
        ...meleeProps,
        arcanes: arcaneList,
        conditionals: conditionalsProp,
        status_types_on_target: statusTypes,
        target: targetProp,
        extra_effects: extraEffects,
        attack: { type: "string", description: "Attack mode from list_weapons, such as Incarnon Form. Defaults to the first." },
        catalyst: { type: "boolean", description: "Orokin Catalyst installed. Default true." },
        level: levelProp,
        base_stats: { type: "object", description: "Overrides: damage (by type), critChance, critDamage, statusChance, fireRate, pellets, magazine, reload, ammoCost, heavyAttack, range, windUp." },
      },
    },
    run: weaponBuild,
  },
  {
    name: "suggest_weapon_build",
    description: "Suggest the mods that give a weapon, Zaw or Kitgun the most damage, within its capacity, polarities and mod conflicts. Pass target to pick for a specific enemy instead of raw damage.",
    inputSchema: {
      type: "object",
      properties: {
        ...weaponSource,
        goal: { type: "string", enum: ["burst_dps", "sustained_dps", "heavy_attack", "status_dps"], description: "Defaults to sustained_dps for guns and burst_dps for melee. heavy_attack is melee only." },
        target: targetProp,
        mods: { ...modNames, description: "Mods that must be in the build." },
        exclude: { ...modNames, description: "Mods not to use, such as ones you do not own." },
        polarities: { ...modNames, description: "The weapon's current slot polarities, if you have added Forma. Defaults to the weapon's own." },
        forma: { type: "number", description: "Extra Forma you are willing to add. The result lists the polarities to add. Default 0." },
        use_exilus: { type: "boolean", description: "The weapon has an Exilus adapter. Default false." },
        riven: rivenProp,
        arcanes: arcaneList,
        conditionals: conditionalsProp,
        status_types_on_target: statusTypes,
        extra_effects: extraEffects,
        stance: { type: "string", description: "Melee only. Defaults to a fitting stance, chosen only for its capacity." },
        combo_multiplier: { type: "number", description: "Melee only. Combo multiplier from 1 to 12. Default 12." },
        attack: { type: "string", description: "Attack mode from list_weapons. Defaults to the first." },
        catalyst: { type: "boolean", description: "Orokin Catalyst installed. Default true." },
        level: levelProp,
      },
    },
    run: suggestWeaponBuild,
  },
  {
    name: "suggest_warframe_build",
    description: `Suggest mods for a Warframe, companion, Archwing or Necramech towards a goal or targets, within capacity, polarities and conflicts. Stats: ${statGoals}.`,
    inputSchema: {
      type: "object",
      properties: {
        warframe: { type: "string" },
        goal: { type: ["string", "object"], description: `One stat, or weights such as {strength: 2, efficiency: 1}. Stats: ${statGoals}.` },
        targets: { type: "object", description: "Minimums to reach first, such as {efficiency: 175, strength: 145}. Results list any it could not reach." },
        mods: { ...modNames, description: "Mods that must be in the build." },
        exclude: { ...modNames, description: "Mods not to use, such as ones you do not own." },
        polarities: { ...modNames, description: "The frame's current slot polarities, if you have added Forma. Defaults to its own." },
        forma: { type: "number", description: "Extra Forma you are willing to add. The result lists the polarities to add. Default 0." },
        aura: modSpec("Aura mod"),
        second_aura: modSpec("Jade only. Second aura mod"),
        exilus: modSpec("Exilus mod"),
        use_exilus: { type: "boolean", description: "Pick an Exilus mod if none is named. Default true." },
        reactor: { type: "boolean", description: "Orokin Reactor installed. Default true." },
        level: levelProp,
        archon_shards: { type: "array", items: { type: ["string", "object"] }, description: "Shards to include, as a stat name or {stat, tauforged}." },
        arcanes: arcaneList,
        conditionals: conditionalsProp,
        extra_effects: extraEffects,
        base_stats: { type: "object" },
      },
      required: ["warframe"],
    },
    run: suggestWarframeBuild,
  },
  {
    name: "data_info",
    description: "Show the server version, when the game data was imported, what it covers and its limits.",
    inputSchema: { type: "object", properties: {} },
    run: dataInfo,
  },
];

const typeMatches = (value, type) => {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
};

// Catches misspelled arguments and wrong types before they silently change a result.
function validate(schema, args) {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new Error(`Missing required argument: ${key}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop) throw new Error(`Unknown argument: ${key}. Arguments: ${Object.keys(schema.properties ?? {}).join(", ")}.`);
    if (prop.type && ![prop.type].flat().some((type) => typeMatches(value, type))) {
      throw new Error(`Argument ${key} must be of type ${[prop.type].flat().join(" or ")}.`);
    }
    if (prop.enum && !prop.enum.includes(value)) throw new Error(`Argument ${key} must be one of: ${prop.enum.join(", ")}.`);
    if (prop.type === "object" && prop.properties) validate(prop, value);
  }
}

function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "warframe-builder", version },
        instructions: "Calculates and suggests Warframe builds. Look names up with the list and search tools if unsure, as lookups forgive case and punctuation. Tell the user about any not_calculated effects and warnings in a result, and that figures are theoretical.",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ run, ...tool }) => ({
          ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
      try {
        const args = params.arguments ?? {};
        if (!typeMatches(args, "object")) throw new Error("Arguments must be an object.");
        validate(tool.inputSchema, args);
        return { content: [{ type: "text", text: JSON.stringify(tool.run(args), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0); // the client went away
  throw error;
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string") {
    send({ id: request?.id ?? null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  if (request.id === undefined) return; // notifications get no reply
  try {
    send({ id: request.id, result: handle(request) });
  } catch (error) {
    send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
