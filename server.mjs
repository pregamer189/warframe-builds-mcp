#!/usr/bin/env node
// Warframe builder companion as a zero-dependency MCP server (newline-delimited JSON-RPC on stdio).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_VERSION, HOME, data, normalize, round } from "./lib/data.mjs";
import { alecaframeAccount } from "./lib/alecaframe.mjs";
import { warframeBuild } from "./lib/frames.mjs";
import { marketPrice, sellAdvice } from "./lib/market.mjs";
import { deleteBuild, getProfile, loadProfile, saveBuild, suggestionLimits, updateProfile } from "./lib/profile.mjs";
import { suggestWarframeBuild, suggestWeaponBuild } from "./lib/suggest.mjs";
import { exploreSynergies } from "./lib/synergy.mjs";
import { armorAtLevel } from "./lib/target.mjs";
import { checkForUpdates, latestKnownVersion, newerVersion, stopUpdates } from "./lib/update.mjs";
import { weaponBuild } from "./lib/weapons.mjs";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
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

// Searches ignore punctuation as well as case, so "hells chamber" finds Hell's Chamber.
const looseText = (text) => String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ");
const nameHas = (name, query) => normalize(name).includes(normalize(query));

function searchMods({ query = "", category = "all", limit = 20, include_pvp = false }) {
  const q = looseText(query);
  const text = (name, mod) => [
    name, Object.keys(mod.effects).join(" "), mod.compat, (mod.other ?? []).join(" "), (mod.conditional ?? []).map((c) => c.text).join(" "),
  ].join(" ").toLowerCase();
  const matches = Object.entries({ ...data.warframeMods, ...data.weaponMods })
    .filter(([, mod]) => modMatches(mod, category) && (include_pvp || !mod.pvpOnly))
    .filter(([name, mod]) => looseText(text(name, mod)).includes(q))
    .sort(([a], [b]) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b));
  return {
    total: matches.length,
    mods: matches.slice(0, limit).map(([name, { effectsByRank, setBonus, ...mod }]) => ({ name, ...mod })),
  };
}

function searchArcanes({ query = "", type, limit = 20 }) {
  const q = looseText(query);
  const matches = Object.entries(data.arcanes)
    .filter(([, arcane]) => !type || arcane.type === type.toLowerCase())
    .filter(([name, arcane]) => looseText(`${name} ${arcane.text.join(" ")}`).includes(q))
    .sort(([a], [b]) => a.localeCompare(b));
  return { total: matches.length, arcanes: matches.slice(0, limit).map(([name, arcane]) => ({ name, ...arcane })) };
}

// Long lists stay short, as every line costs the player usage. A close match or detail: true returns everything.
const FULL_DETAIL_MATCHES = 3;

const weaponSummary = ({ type, slot, trigger, mastery, modes }) => ({ type, slot, trigger, mastery, attacks: modes.map((m) => m.name) });
const frameSummary = ({ abilityText, passive, ...frame }) => frame;

function listEntries(table, { query = "", type, limit = 25, detail = false }, summary) {
  const matches = Object.entries(table)
    .filter(([name]) => nameHas(name, query))
    .filter(([, entry]) => !type || [entry.type, entry.slot].some((value) => value?.toLowerCase() === type.toLowerCase()));
  const full = detail || matches.length <= FULL_DETAIL_MATCHES;
  return { total: matches.length, results: Object.fromEntries(matches.slice(0, limit).map(([name, entry]) => [name, full ? entry : summary(entry)])) };
}

function listEnemies({ query = "", faction, level, steel_path = false, limit = 25 }) {
  const q = query.toLowerCase();
  const matches = Object.entries(data.enemies)
    .filter(([name]) => nameHas(name, query))
    .filter(([, enemy]) => !faction || enemy.faction?.toLowerCase().includes(faction.toLowerCase()))
    .sort(([x], [y]) => Number(y.toLowerCase() === q) - Number(x.toLowerCase() === q));
  return {
    total: matches.length,
    results: Object.fromEntries(matches.slice(0, limit).map(([name, enemy]) => {
      const at = (level ?? enemy.spawnLevel ?? enemy.baseLevel) + (steel_path ? 100 : 0);
      return [name, { ...enemy, ...((level !== undefined || steel_path) && { level: at, armor_at_level: round(armorAtLevel(enemy.armor, enemy.baseLevel, at)) }) }];
    })),
  };
}

// Suggestions and ideas respect the player's profile, unless they ask to see everything.
const withProfile = (run, table) => ({ use_profile = true, ...args }) => {
  if (!use_profile) return run(args);
  const profile = loadProfile();
  const limits = suggestionLimits(profile, table());
  const applied = limits.exclude.length || limits.only_mods;
  const result = run({ ...args, exclude: [...(args.exclude ?? []), ...limits.exclude], ...(limits.only_mods && !args.only_mods && { only_mods: limits.only_mods }) });
  return { ...result, ...(applied && { profile_applied: { mode: profile.mods_mode, mods_marked_missing: limits.exclude.length, ...(limits.only_mods && { mods_owned: limits.only_mods.length }) } }) };
};
const ALL_MODS = () => ({ ...data.warframeMods, ...data.weaponMods });

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
  const latest = latestKnownVersion();
  const count = (table) => Object.keys(table).length;
  const pvp = Object.values({ ...data.warframeMods, ...data.weaponMods }).filter((mod) => mod.pvpOnly).length;
  return {
    server_version: version,
    ...(latest && newerVersion(latest, version) && { newer_version_available: latest, update_how: "See INSTALL.md in the project on GitHub." }),
    profile_folder: HOME,
    data: DATA_VERSION,
    sources: data.meta.sources,
    note: data.meta.note,
    coverage: {
      warframes: count(data.warframes), companions: count(data.companions), archwings: count(data.archwings), necramechs: count(data.necramechs),
      weapons: count(data.weapons), mods: count(data.warframeMods) + count(data.weaponMods), pvp_only_mods: pvp, arcanes: count(data.arcanes),
      stances_with_timing: count(data.stances), enemies: count(data.enemies), factions: Object.keys(data.factions),
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
const extraEffects = { type: "object", description: "Extra percentage bonuses for buffs this tool cannot see, by effect name. Weapons: {damage: 50, critChance: 25}. Frames: {strength: 25, armor: 100}." };
const targetProp = {
  type: ["string", "object"],
  description: "The enemy, as a name or faction such as \"Heavy Gunner\" or \"Grineer\", or {enemy, level, steel_path, faction, armor}. An enemy with a level scales its armor. steel_path adds 100 levels to that level, so leave it out if the level you have already includes them. armor_strip is the percentage of armor removed. Applies faction damage multipliers, armor reduction and faction mods. See list_enemies.",
};
const useProfile = { type: "boolean", description: "Respect the saved profile's missing and owned mods. Default true." };
const detailProp = { type: "boolean", description: "Return full stats for every result. Lists are short summaries otherwise, except for 3 matches or fewer." };
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
    inputSchema: { type: "object", properties: { ...queryProps, detail: detailProp, kind: { type: "string", enum: ["warframe", "companion", "archwing", "necramech"], description: "Default warframe." } } },
    run: ({ kind = "warframe", ...args }) => listEntries(FRAME_TABLES()[kind], args, frameSummary),
  },
  {
    name: "list_weapons",
    description: "Find primary, secondary, melee, Exalted, Archwing and companion weapons by name or type, with attack modes and stats.",
    inputSchema: {
      type: "object",
      properties: { ...queryProps, detail: detailProp, type: { type: "string", description: "A class such as Rifle, Shotgun, Bow, Nikana or Exalted Weapon, or a slot: primary, shotgun, secondary, melee, archgun, archmelee or claws." } },
    },
    run: (args) => listEntries(data.weapons, args, weaponSummary),
  },
  {
    name: "list_enemies",
    description: "Find enemies by name or faction, with armor, health and base level. Pass level or steel_path to see their armor there.",
    inputSchema: {
      type: "object",
      properties: { ...queryProps, faction: { type: "string" }, level: { type: "number" }, steel_path: { type: "boolean", description: "Adds 100 levels. Default false." } },
    },
    run: listEnemies,
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
        goal: { type: "string", description: "burst_dps, sustained_dps, heavy_attack or status_dps. Defaults to sustained_dps for guns and burst_dps for melee. heavy_attack is melee only." },
        only_mods: { ...modNames, description: "Only use these mods, such as the ones you own." },
        use_profile: useProfile,
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
    run: withProfile(suggestWeaponBuild, () => data.weaponMods),
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
        only_mods: { ...modNames, description: "Only use these mods, such as the ones you own." },
        use_profile: useProfile,
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
    run: withProfile(suggestWarframeBuild, () => data.warframeMods),
  },
  {
    name: "explore_synergies",
    description: "Start here for a themed or unusual build, such as a Saryn spore nuker or a tanky Mesa. Returns ability text, augments, and the mods and arcanes whose wording fits, so you can reason about combinations the calculators cannot model. Works for anything in the game data, including new items.",
    inputSchema: {
      type: "object",
      properties: {
        warframe: { type: "string", description: "A Warframe, companion, Archwing or Necramech. Use this, weapon, zaw or kitgun." },
        ...weaponSource,
        attack: { type: "string", description: "Attack mode from list_weapons. Defaults to the first." },
        theme: { type: "string", description: "What the build is for, in plain words: tank, nuke, status, crit, energy, support, speed, stealth, control, melee, ammo, aoe, or any word from the game's text." },
        limit: { type: "number", description: "Most mods and most arcanes to return, up to 60. Default 12." },
        use_profile: useProfile,
      },
    },
    run: withProfile(exploreSynergies, ALL_MODS),
  },
  {
    name: "get_profile",
    description: "Show the player's saved profile: owned and missing mods, owned items, spare items to sell, Rivens, saved builds and notes. It is stored only on this computer.",
    inputSchema: { type: "object", properties: {} },
    run: getProfile,
  },
  {
    name: "update_profile",
    description: "Change the player's saved profile. Tell the player what you changed. Use mods_mode owned_only only once owned_mods is complete, because suggestions then use nothing else.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        mods_mode: { type: "string", enum: ["assume_all", "owned_only"], description: "assume_all: has every mod except missing_mods. owned_only: has only owned_mods." },
        add_owned_mods: modNames, remove_owned_mods: modNames, add_missing_mods: modNames, remove_missing_mods: modNames,
        add_owned_items: { ...modNames, description: "Warframes and weapons the player has." },
        remove_owned_items: modNames,
        spare_items: { type: "object", description: "Spare tradable items to sell, as {name: count}. A count of 0 removes one. Used by sell_advice." },
        rivens: { type: "object", description: "Rivens by weapon, as {weapon: {effects, polarity, drain}}. null removes one. Pass one to weapon tools as riven." },
        notes: { type: "string", description: "Replaces the player's free-form notes, such as playstyle or goals." },
        alecaframe_public_token: { type: "string", description: "A public token from AlecaFrame's Stats tab. An empty value removes it. It is kept in the profile file and never shown again." },
      },
    },
    run: updateProfile,
  },
  {
    name: "save_build",
    description: "Save a build the player likes, after checking it works, so it can be loaded later and sell_advice can warn before its mods are sold.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        tool: { type: "string", enum: ["weapon_build", "warframe_build"] },
        arguments: { type: "object", description: "The arguments for that tool." },
        notes: { type: "string", description: "What the build is for and how to play it." },
      },
      required: ["name", "tool", "arguments"],
    },
    run: (args) => {
      validate(TOOLS.find((tool) => tool.name === args.tool)?.inputSchema ?? {}, args.arguments ?? {});
      return saveBuild(args);
    },
  },
  {
    name: "delete_saved_build",
    description: "Delete a saved build from the profile. Only do this when the player asks.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: deleteBuild,
  },
  {
    name: "market_price",
    description: "Look up an item's live price and recent sales on warframe.market, in platinum. Sets have names such as Saryn Prime Set.",
    annotations: { openWorldHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: { item: { type: "string" }, rank: { type: "number", description: "Rank to price, for mods and arcanes. Default 0, as ranks are never mixed." }, subtype: { type: "string", description: "A variant such as a relic's radiant. Defaults to the first listed." } }, required: ["item"] },
    run: marketPrice,
  },
  {
    name: "sell_advice",
    description: "Rank items to sell by recent price and demand on warframe.market, and warn about mods saved builds use. Checks the profile's spare_items unless you pass items. Advice for trading in the game.",
    annotations: { openWorldHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", description: "Up to 25 names or {name, count, rank, subtype} objects. Mods and arcanes default to rank 0. Defaults to spare_items.", items: { type: ["string", "object"] } } },
    },
    run: sellAdvice,
  },
  {
    name: "alecaframe_account",
    description: "Read the player's AlecaFrame stats: platinum, ducats, endo and other currencies, mastery rank, recorded trades and relics. It has no owned mods or gear. Needs a public token from AlecaFrame's Stats tab.",
    annotations: { openWorldHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: { recent_trades: { type: "number", description: "Trades to list, up to 100. Default 10." } } },
    run: alecaframeAccount,
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
    const prop = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!prop) throw new Error(`Unknown argument: ${key}. Arguments: ${Object.keys(schema.properties ?? {}).join(", ")}.`);
    if (prop.type && ![prop.type].flat().some((type) => typeMatches(value, type))) {
      throw new Error(`Argument ${key} must be of type ${[prop.type].flat().join(" or ")}.`);
    }
    if (prop.enum && !prop.enum.includes(value)) throw new Error(`Argument ${key} must be one of: ${prop.enum.join(", ")}.`);
    if (prop.type === "object" && prop.properties) validate(prop, value);
  }
}

// Late enough that a client just checking the server pays nothing, and never keeps it running.
function scheduleUpdateCheck() {
  setTimeout(checkForUpdates, 3000).unref();
}

async function handle({ method, params }) {
  switch (method) {
    case "initialize":
      scheduleUpdateCheck();
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "warframe-builder", version },
        instructions: "A Warframe builder companion. For a themed or unusual build, start with explore_synergies, reason from the ability, mod and arcane text, then check each build with warframe_build or weapon_build. For the most damage or a stat goal, use the suggest tools. Check get_profile early, and use the player's Rivens and notes. Build lookups forgive case, punctuation and partial names, and suggest close matches for typos. Tell the user about any warnings and not_calculated effects in a result. Say which parts are calculated and which are theory from the text, because nothing is tested in-game.",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ run, annotations, ...tool }) => ({
          ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...annotations },
        })),
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
      try {
        const args = params.arguments ?? {};
        if (!typeMatches(args, "object")) throw new Error("Arguments must be an object.");
        validate(tool.inputSchema, args);
        return { content: [{ type: "text", text: JSON.stringify(await tool.run(args), null, 2) }] };
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

// Requests run one at a time, so replies keep their order and profile writes can't overlap.
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("close", () => queue.then(() => {
  stopUpdates();
  setTimeout(() => process.exit(0), 1000).unref(); // never outlive the client, whatever is still in flight
}));

input.on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
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
      send({ id: request.id, result: await handle(request) });
    } catch (error) {
      send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  });
});
