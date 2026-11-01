#!/usr/bin/env node
// Warframe build calculator as a zero-dependency MCP server (newline-delimited JSON-RPC on stdio).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const data = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));
const DATA_VERSION = `imported ${data.meta.imported}`;
const BASE_CAPACITY = 30; // rank 30 frame or weapon, doubled by a Reactor/Catalyst
const COMPOSITES = {
  "cold+heat": "blast", "electricity+toxin": "corrosive", "heat+toxin": "gas",
  "cold+electricity": "magnetic", "electricity+heat": "radiation", "cold+toxin": "viral",
};
const ELEMENTS = ["heat", "cold", "electricity", "toxin"];
const PHYSICAL = ["impact", "puncture", "slash"];
const COMBINED = Object.values(COMPOSITES);

const find = (table, name, kind) => {
  if (Object.hasOwn(table, name)) return [name, table[name]];
  const key = Object.keys(table).find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (!key) {
    const words = String(name).toLowerCase().split(/\s+/);
    const close = Object.keys(table).filter((k) => words.some((w) => k.toLowerCase().includes(w))).slice(0, 5);
    throw new Error(`Unknown ${kind}: ${name}.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""}`);
  }
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
    const effects = mod.effectsByRank?.[rank]
      ?? Object.fromEntries(Object.entries(mod.effects).map(([k, v]) => [k, v * scale]));
    return { name, mod, rank, effects, drain: mod.baseDrain + rank, slot: spec.slot_polarity };
  });
}

const hasPolarity = (slot) => slot && slot !== "none";

// Matching polarity halves drain, a different polarity adds 25%, an empty slot changes nothing.
function slottedDrain(m) {
  if (!hasPolarity(m.slot)) return m.drain;
  return Math.round(m.slot === m.mod.polarity ? m.drain / 2 : m.drain * 1.25);
}

// Auras add capacity instead: a matching polarity doubles it and a different one removes 25%.
function auraCapacity(aura) {
  if (!hasPolarity(aura.slot)) return aura.drain;
  return aura.slot === aura.mod.polarity ? aura.drain * 2 : Math.round(aura.drain * 0.75);
}

function capacityReport(mods, { reactor, aura }) {
  const warnings = [];
  mods.forEach((m, i) => {
    const conflict = mods.slice(0, i).find((other) => other.name === m.name
      || m.mod.incompatible?.includes(other.name) || other.mod.incompatible?.includes(m.name));
    if (conflict) warnings.push(`${m.name} conflicts with ${conflict.name}: they cannot be equipped together.`);
    if (m.mod.unverified) warnings.push(`${m.name} values could not be verified and may be the weaker Flawed version.`);
    if (m.mod.pvpOnly) warnings.push(`${m.name} only works in Conclave (PvP).`);
  });
  const capacity = BASE_CAPACITY * (reactor ? 2 : 1) + (aura ? auraCapacity(aura) : 0);
  const drains = mods.map((m) => ({ mod: m.name, rank: m.rank, drain: slottedDrain(m) }));
  const used = drains.reduce((sum, d) => sum + d.drain, 0);
  if (used > capacity) warnings.push(`Over capacity by ${used - capacity}. Add polarities, lower ranks or drop a mod.`);
  return { capacity, used, remaining: capacity - used, drains, warnings };
}

// Effects the calculator cannot model (conditional or utility text), so results never hide them.
const notCalculated = (mods) => mods.flatMap((m) => (m.mod.other ?? []).map((effect) => ({ mod: m.name, at_max_rank: effect })));

function warframeBuild({ warframe, mods = [], aura, exilus, reactor = true, base_stats }) {
  const [name, stored] = find(data.warframes, warframe, "warframe");
  const base = { ...stored, ...base_stats };
  const regular = resolveMods(mods, data.warframeMods);
  if (regular.length > 8) throw new Error("A Warframe has 8 regular mod slots.");
  for (const m of regular) if (m.mod.aura) throw new Error(`${m.name} is an aura: pass it as "aura".`);

  let auraMod;
  if (aura) {
    [auraMod] = resolveMods([aura], data.warframeMods);
    if (!auraMod.mod.aura) throw new Error(`${auraMod.name} is not an aura mod.`);
    auraMod.slot ??= stored.auraPolarity; // the frame's own aura slot, unless told otherwise
  }
  const exilusMod = exilus ? resolveMods([exilus], data.warframeMods)[0] : undefined;
  const equipped = exilusMod ? [...regular, exilusMod] : regular;

  const sum = (stat) => equipped.reduce((total, m) => total + (m.effects[stat] ?? 0), 0);
  // Percentage mods apply to the rank 30 stat, after rank bonuses.
  const scaled = (stat) => round(base[stat] * (1 + sum(stat) / 100));
  const efficiency = Math.min(100 + sum("efficiency"), 175);
  const health = scaled("health");
  const shields = scaled("shields");
  const armor = scaled("armor");

  const capacity = capacityReport(equipped, { reactor, aura: auraMod });
  const frameName = name.replace(/ (Prime|Umbra)$/, "");
  for (const m of equipped) {
    if (!["WARFRAME", "AURA"].includes(m.mod.compat) && m.mod.compat !== frameName) {
      capacity.warnings.push(`${m.name} only fits ${m.mod.compat}.`);
    }
  }
  if (exilusMod && !exilusMod.mod.exilus) capacity.warnings.push(`${exilusMod.name} is not an Exilus mod.`);

  return {
    warframe: name,
    stats: { health, shields, armor, energy: scaled("energy") },
    abilities: {
      strength: round(100 + sum("strength")),
      duration: round(Math.max(100 + sum("duration"), 12.5)),
      range: round(Math.max(100 + sum("range"), 34)),
      efficiency: round(efficiency),
      ability_cost_multiplier: round(2 - efficiency / 100),
    },
    damage_reduction_pct: round((armor / (armor + 300)) * 100),
    // The wiki's formula: armor mitigates health only, and shields count double.
    effective_health: round((health * (armor + 300)) / 300 + shields / 0.5),
    mod_capacity: capacity,
    not_calculated: notCalculated(auraMod ? [...equipped, auraMod] : equipped),
    assumptions: "Rank 30. Excludes arcanes, archon shards, set bonuses, passives and overshields.",
    data: DATA_VERSION,
  };
}

// Single elements combine in mod order, with the weapon's innate elements last.
function combineElements(singles) {
  const merged = [];
  for (const { element, value } of singles) {
    const existing = merged.find((s) => s.element === element);
    if (existing) existing.value += value;
    else merged.push({ element, value });
  }
  const result = {};
  for (let i = 0; i < merged.length; i += 2) {
    const [a, b] = [merged[i], merged[i + 1]];
    if (!b) result[a.element] = a.value;
    else result[COMPOSITES[[a.element, b.element].sort().join("+")]] = a.value + b.value;
  }
  return result;
}

const weaponClass = (text) => text.toLowerCase().replace(/^staves$/, "staff").replace(/s$/, "");

function meleeFits(compat, name, weapon) {
  if (compat === "Melee" || weapon.type === "Melee") return true; // "Melee" as a type means the class is unknown
  if (compat === "Thrown Melee") return weapon.modes.some((m) => /throw/i.test(m.name));
  return weaponClass(compat) === weaponClass(weapon.type) || name.toLowerCase().includes(compat.toLowerCase());
}

function weaponCompatibility(m, name, weapon) {
  if (m.mod.slot !== weapon.slot && !m.mod.stance) return `${m.name} is a ${m.mod.slot} mod, but ${name} takes ${weapon.slot} mods.`;
  const tags = weapon.tags ?? [];
  if (m.mod.blockedTags?.some((tag) => tags.includes(tag))) return `${m.name} cannot be used on ${name}.`;
  const needs = m.mod.requiredTags;
  if (needs?.includes("SEMI_AUTO")) {
    if (!tags.includes("SEMI_AUTO") && !/(^|\/ )Semi/.test(weapon.trigger ?? "")) return `${m.name} only fits Semi-Auto weapons.`;
  } else if (needs && weapon.tags && !needs.some((tag) => tags.includes(tag))) {
    return `${m.name} only fits weapons tagged ${needs.join(" or ")}.`;
  }
  const compat = m.mod.compat;
  if (weapon.slot === "melee") return meleeFits(compat, name, weapon) ? undefined : `${m.name} only fits ${compat}.`;
  if (["PRIMARY", "Rifle", "Shotgun", "Pistol"].includes(compat)) return undefined;
  const byType = { "Assault Rifle": "Rifle", Sniper: "Sniper", Bow: "Bow", Thrown: "Throwing" };
  const fits = byType[compat] ? weapon.type === byType[compat] : name.toLowerCase().includes(compat.toLowerCase());
  return fits ? undefined : `${m.name} only fits ${compat}.`;
}

function weaponBuild({ weapon, mods = [], exilus, stance, combo_multiplier, attack, catalyst = true, base_stats }) {
  const [name, record] = find(data.weapons, weapon, "weapon");
  const mode = attack
    ? record.modes.find((m) => m.name.toLowerCase() === String(attack).toLowerCase())
    : record.modes[0];
  if (!mode) throw new Error(`${name} has no attack "${attack}". Modes: ${record.modes.map((m) => m.name).join(", ")}`);
  const melee = record.slot === "melee";
  if (!melee && (stance || combo_multiplier !== undefined)) throw new Error(`${name} is not melee: stance and combo_multiplier only apply to melee weapons.`);
  const combo = combo_multiplier ?? 1;
  if (combo < 1 || combo > 12) throw new Error("combo_multiplier must be 1-12.");
  const stats = {
    ...mode, pellets: record.pellets, magazine: record.magazine, reload: record.reload,
    heavyAttack: record.heavyAttack, range: record.range, windUp: record.windUp, ...base_stats,
  };

  const regular = resolveMods(mods, data.weaponMods);
  if (regular.length > 8) throw new Error("A weapon has 8 regular mod slots.");
  for (const m of regular) if (m.mod.stance) throw new Error(`${m.name} is a stance: pass it as "stance".`);
  let stanceMod;
  if (stance) {
    [stanceMod] = resolveMods([stance], data.weaponMods);
    if (!stanceMod.mod.stance) throw new Error(`${stanceMod.name} is not a stance mod.`);
    stanceMod.slot ??= record.stancePolarity; // the weapon's own stance slot, unless told otherwise
  }
  const exilusMod = exilus ? resolveMods([exilus], data.weaponMods)[0] : undefined;
  const equipped = exilusMod ? [...regular, exilusMod] : regular;
  const sum = (stat) => equipped.reduce((total, m) => total + (m.effects[stat] ?? 0), 0) / 100;

  // Elemental and physical bonuses scale from base damage after +damage mods.
  const damageMult = Math.max(1 + sum("damage"), 0);
  const moddedTotal = Object.values(stats.damage).reduce((total, v) => total + v, 0) * damageMult;
  const byType = {};
  for (const type of PHYSICAL) {
    const base = stats.damage[type] ?? 0;
    if (base) byType[type] = base * damageMult * Math.max(1 + sum(type), 0);
  }
  const singles = [
    ...equipped.flatMap((m) => Object.keys(m.effects).filter((e) => ELEMENTS.includes(e))
      .map((element) => ({ element, value: (moddedTotal * m.effects[element]) / 100 }))),
    ...ELEMENTS.filter((e) => stats.damage[e]).map((element) => ({ element, value: stats.damage[element] * damageMult })),
  ];
  const addDamage = (type, value) => { byType[type] = (byType[type] ?? 0) + value; };
  for (const [type, value] of Object.entries(combineElements(singles))) addDamage(type, value);
  for (const type of COMBINED) {
    if (sum(type)) addDamage(type, moddedTotal * sum(type));
  }
  // Innate composites and types no mod can change, such as Void, only scale with +damage.
  for (const [type, base] of Object.entries(stats.damage)) {
    if (!PHYSICAL.includes(type) && !ELEMENTS.includes(type)) addDamage(type, base * damageMult);
  }

  const perPellet = Object.values(byType).reduce((total, v) => total + v, 0);
  const shots = stats.pellets * (1 + sum("multishot"));
  // Blood Rush and Weeping Wounds add their bonus once per combo multiplier above 1x.
  const comboCrit = sum("comboCritChance") * (combo - 1);
  const critChance = (stats.critChance / 100) * (1 + sum("critChance") + comboCrit);
  const critDamage = stats.critDamage * (1 + sum("critDamage"));
  // Cannonade mods fix the rate of fire.
  const fireLocked = equipped.some((m) => m.mod.fireRateLocked);
  const fireBonus = fireLocked ? 0 : record.type === "Bow" ? sum("fireRateBow") : sum("fireRate");
  const fireRate = stats.fireRate * Math.max(1 + fireBonus, 0.01);
  const magazine = Math.round(stats.magazine * (1 + sum("magazine")));
  const reload = stats.reload / Math.max(1 + sum("reload"), 0.01);
  const avgCrit = 1 + critChance * (critDamage - 1);
  const burst = perPellet * shots * avgCrit * fireRate;
  const ammoCost = stats.ammoCost ?? 1;
  const attacksPerMagazine = ammoCost > 0 ? magazine / ammoCost : 0;
  const firingTime = fireRate > 0 ? attacksPerMagazine / fireRate : 0;
  // Attacks that use no ammo and weapons with no magazine, such as Grimoire, never stop to reload.
  const sustained = firingTime > 0 ? burst * (firingTime / (firingTime + reload)) : burst;

  const heavy = () => {
    // The class's heavy attack multiplier is stored as damage, and the combo multiplies it directly.
    const heavyMult = stats.heavyAttack / Object.values(stats.damage).reduce((total, v) => total + v, 0);
    // Killing Blow's bonus only applies here, and adds to the other +damage mods.
    const heavyBonus = damageMult > 0 ? (damageMult + sum("heavyDamage")) / damageMult : 1;
    const damage = perPellet * heavyMult * heavyBonus * combo;
    const heavyCrit = (stats.critChance / 100) * (1 + sum("critChance") + sum("heavyCritChance") + comboCrit);
    return {
      damage: round(damage),
      crit_chance_pct: round(heavyCrit * 100),
      average_damage_with_crits: round(damage * (1 + heavyCrit * (critDamage - 1))),
      wind_up_seconds: stats.windUp,
      ...(record.heavyUnconfirmed && !base_stats?.heavyAttack && { unconfirmed: `The ${record.heavyUnconfirmed}, so treat this as approximate.` }),
    };
  };

  const capacity = capacityReport(equipped, { reactor: catalyst, aura: stanceMod });
  for (const m of stanceMod ? [...equipped, stanceMod] : equipped) {
    const warning = weaponCompatibility(m, name, record);
    if (warning) capacity.warnings.push(warning);
  }
  if (exilusMod && !exilusMod.mod.exilus) capacity.warnings.push(`${exilusMod.name} is not an Exilus mod.`);

  return {
    weapon: name,
    type: record.type,
    attack: mode.name,
    other_attacks: record.modes.filter((m) => m !== mode).map((m) => m.name),
    damage_per_shot: round(perPellet),
    damage_by_type: Object.fromEntries(Object.entries(byType).map(([type, v]) => [type, round(v)])),
    pellets_or_multishot: round(shots),
    damage_per_trigger: round(perPellet * shots),
    crit_chance_pct: round(critChance * 100),
    crit_multiplier: round(critDamage),
    average_crit_multiplier: round(avgCrit),
    status_chance_pct: round(stats.statusChance * (1 + sum("statusChance") + sum("comboStatusChance") * (combo - 1))),
    ...(melee
      ? {
        combo_multiplier: combo,
        attack_speed: round(fireRate),
        range_m: round(stats.range + sum("meleeRange") * 100),
        initial_combo: round(sum("initialCombo") * 100),
        heavy_attack: stats.heavyAttack ? heavy() : null,
        burst_dps: round(burst),
      }
      : {
        fire_rate: round(fireRate),
        magazine,
        attacks_per_magazine: attacksPerMagazine > 0 ? round(attacksPerMagazine) : null,
        reload_seconds: round(reload),
        burst_dps: round(burst),
        sustained_dps: round(sustained),
      }),
    mod_capacity: capacity,
    not_calculated: notCalculated(equipped),
    assumptions: melee
      ? "One attack mode only, counting attack speed as hits per second: real DPS depends on the stance's hit counts and multipliers. Heavy attacks exclude Bleed, and Glaive-style heavy explosions are not modeled. Before enemy armor, faction damage, status ticks, arcanes and conditional bonuses."
      : "One attack mode only. Before enemy armor, faction damage, status ticks, charge time, arcanes and conditional bonuses.",
    data: DATA_VERSION,
  };
}

// Stats each goal can gain from. Status, utility and conditional effects never raise these numbers.
const DAMAGE_EFFECTS = [
  "damage", "multishot", "critChance", "critDamage", "fireRate", "fireRateBow", "comboCritChance", ...PHYSICAL, ...ELEMENTS, ...COMBINED,
];
const GOAL_EFFECTS = {
  burst_dps: DAMAGE_EFFECTS,
  sustained_dps: [...DAMAGE_EFFECTS, "magazine", "reload"],
  heavy_attack: DAMAGE_EFFECTS.filter((e) => e !== "fireRate").concat("heavyCritChance", "heavyDamage"),
};
const BEAM_WIDTH = 200;
const GOAL_SCORES = {
  burst_dps: (build) => build.burst_dps,
  sustained_dps: (build) => build.sustained_dps,
  heavy_attack: (build) => build.heavy_attack?.average_damage_with_crits ?? 0,
};

// Puts mods in their matching polarity slots, largest drain first. Other mods take the blank slots, then any
// polarized slots left over, where they cost 25% more.
function assignSlots(mods, polarities, slots = 8) {
  const open = [...polarities];
  const assigned = new Map();
  const byDrain = [...mods].sort((a, b) => b.drain - a.drain);
  for (const m of byDrain) {
    const slot = open.indexOf(m.mod.polarity);
    if (slot >= 0) assigned.set(m.name, open.splice(slot, 1)[0]);
  }
  let blank = slots - polarities.length;
  for (const m of byDrain) {
    if (assigned.has(m.name)) continue;
    assigned.set(m.name, blank-- > 0 ? "none" : open.shift());
  }
  return assigned;
}

function suggestWeaponBuild({
  weapon, goal, mods: required = [], exclude = [], polarities, stance, combo_multiplier, attack, catalyst = true,
}) {
  const [name, record] = find(data.weapons, weapon, "weapon");
  const melee = record.slot === "melee";
  const chosenGoal = goal ?? (melee ? "burst_dps" : "sustained_dps");
  if (!GOAL_SCORES[chosenGoal]) throw new Error(`Unknown goal: ${chosenGoal}. Goals: ${Object.keys(GOAL_SCORES).join(", ")}`);
  if (melee && chosenGoal === "sustained_dps") throw new Error("Melee weapons have no magazine: use burst_dps or heavy_attack.");
  if (!melee && chosenGoal === "heavy_attack") throw new Error(`${name} is not melee: use burst_dps or sustained_dps.`);

  // Melee builds assume a held combo, since Blood Rush and heavy attacks are built around one.
  const combo = melee ? combo_multiplier ?? 12 : undefined;
  // A stance's moves change real damage, so it is only chosen for capacity here unless one is named.
  const chosenStance = !melee ? undefined : stance ?? Object.entries(data.weaponMods)
    .filter(([, mod]) => mod.stance && !mod.pvpOnly && meleeFits(mod.compat, name, record))
    .sort(([, a], [, b]) => Number(b.polarity === record.stancePolarity) - Number(a.polarity === record.stancePolarity))[0]?.[0];
  const slotPolarities = polarities ?? record.polarities;
  const resolve = (names) => resolveMods(names, data.weaponMods);
  const buildOf = (names) => {
    const assigned = assignSlots(resolve(names), slotPolarities);
    return weaponBuild({
      weapon: name, attack, catalyst, stance: chosenStance, combo_multiplier: combo,
      mods: names.map((mod) => ({ name: mod, slot_polarity: assigned.get(resolve([mod])[0].name) })),
    });
  };
  const score = GOAL_SCORES[chosenGoal];
  const fits = (build) => build.mod_capacity.warnings.length === 0;

  const requiredNames = resolve(required).map((m) => m.name);
  const excluded = new Set(resolve(exclude).map((m) => m.name));
  const candidates = Object.entries(data.weaponMods)
    .filter(([modName, mod]) => !mod.pvpOnly && !mod.stance && !mod.unverified && !excluded.has(modName) && !requiredNames.includes(modName))
    .filter(([, mod]) => Object.keys(mod.effects).some((effect) => GOAL_EFFECTS[chosenGoal].includes(effect)))
    .filter(([modName, mod]) => !weaponCompatibility({ name: modName, mod }, name, record))
    // On a tie, the first wins: a mod with no side effects, then the cheaper one, so Serration beats Heavy Caliber.
    .sort(([, a], [, b]) => (a.other?.length ?? 0) - (b.other?.length ?? 0) || a.baseDrain + a.maxRank - b.baseDrain - b.maxRank)
    .map(([modName]) => modName);

  const start = buildOf(requiredNames);
  if (!fits(start)) throw new Error(`The required mods do not fit: ${start.mod_capacity.warnings.join(" ")}`);
  const stateOf = (names) => {
    const build = buildOf(names);
    return fits(build) ? { names, value: score(build), used: build.mod_capacity.used } : undefined;
  };

  // Beam search: each round extends the best builds by one mod. Half the beam is ranked by damage and half by damage
  // per capacity, or one costly mod crowds out the two cheap ones that would beat it.
  let best = { names: requiredNames, value: score(start) };
  let beam = [best];
  for (let size = requiredNames.length; size < 8 && beam.length; size++) {
    const seen = new Map();
    for (const state of beam) {
      for (const mod of candidates) {
        if (state.names.includes(mod)) continue;
        const names = [...state.names, mod];
        const key = [...names].sort().join("|");
        if (seen.has(key)) continue;
        const next = stateOf(names);
        if (next) seen.set(key, next);
      }
    }
    const states = [...seen.values()];
    const top = (rank) => [...states].sort((a, b) => rank(b) - rank(a)).slice(0, BEAM_WIDTH / 2);
    beam = [...new Set([...top((x) => x.value), ...top((x) => x.value / Math.max(x.used, 1))])];
    for (const state of beam) if (state.value > best.value) best = state;
  }

  // Then single swaps until nothing improves.
  for (let improved = true; improved;) {
    improved = false;
    for (const [i, old] of best.names.entries()) {
      if (requiredNames.includes(old)) continue;
      for (const mod of candidates) {
        if (best.names.includes(mod)) continue;
        const next = stateOf(best.names.map((other, j) => (j === i ? mod : other)));
        if (next && next.value > best.value + 1e-9) {
          best = next;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  const chosen = best.names;

  const assigned = assignSlots(resolve(chosen), slotPolarities);
  return {
    goal: chosenGoal,
    weapon: name,
    mods: chosen.map((mod) => ({ name: mod, slot_polarity: assigned.get(mod) })),
    ...(chosenStance && { stance: chosenStance }),
    build: buildOf(chosen),
    assumptions: "Assumes you own every mod at max rank, so use exclude for ones you do not have. Picks for raw damage, not armor or faction matchups, and ignores status effects, conditional bonuses, Rivens, Exilus and arcanes. The search is heuristic, so a better build can exist.",
  };
}

function modMatches(mod, category) {
  if (category === "all") return true;
  if (category === "aura") return Boolean(mod.aura);
  if (category === "exilus") return Boolean(mod.exilus);
  return mod.slot === category;
}

function searchMods({ query = "", category = "all", limit = 20 }) {
  const q = query.toLowerCase();
  const matches = Object.entries({ ...data.warframeMods, ...data.weaponMods })
    .filter(([, mod]) => modMatches(mod, category))
    .filter(([name, mod]) => `${name} ${Object.keys(mod.effects).join(" ")} ${mod.compat} ${(mod.other ?? []).join(" ")}`.toLowerCase().includes(q))
    .sort(([a], [b]) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b));
  return {
    total: matches.length,
    mods: matches.slice(0, limit).map(([name, { effectsByRank, ...mod }]) => ({ name, ...mod })),
  };
}

function listEntries(table, { query = "", type, limit = 25 }) {
  const q = query.toLowerCase();
  const matches = Object.entries(table)
    .filter(([name]) => name.toLowerCase().includes(q))
    .filter(([, entry]) => !type || [entry.type, entry.slot].some((value) => value?.toLowerCase() === type.toLowerCase()));
  return { total: matches.length, results: Object.fromEntries(matches.slice(0, limit)) };
}

const modList = {
  type: "array",
  description: "Mod names, or {name, rank, slot_polarity} objects. Rank defaults to max. Use slot_polarity \"none\" for an empty slot.",
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
const modNames = { type: "array", items: { type: "string" } };
const queryProps = { query: { type: "string", description: "Part of a name." }, limit: { type: "number" } };

const TOOLS = [
  {
    name: "list_warframes",
    description: "Find Warframes by name, with rank 30 and rank 0 stats, polarities and abilities.",
    inputSchema: { type: "object", properties: queryProps },
    run: (args) => listEntries(data.warframes, args),
  },
  {
    name: "list_weapons",
    description: "Find primary, secondary and melee weapons by name or type, with attack modes and stats.",
    inputSchema: {
      type: "object",
      properties: { ...queryProps, type: { type: "string", description: "Rifle, Shotgun, Bow, Sniper, Launcher, Pistol, Dual Pistols, Throwing, a melee class such as Nikana, or melee for all of them." } },
    },
    run: (args) => listEntries(data.weapons, args),
  },
  {
    name: "search_mods",
    description: "Search Warframe, primary, shotgun, secondary, melee and stance mods by name, effect (for example strength or multishot) or effect text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string", enum: ["all", "warframe", "aura", "exilus", "primary", "shotgun", "secondary", "melee", "stance"] },
        limit: { type: "number" },
      },
    },
    run: searchMods,
  },
  {
    name: "warframe_build",
    description: "Calculate a rank 30 Warframe build: final stats, ability stats, armor mitigation and mod capacity.",
    inputSchema: {
      type: "object",
      properties: {
        warframe: { type: "string" },
        mods: modList,
        aura: { description: "Aura mod name or {name, rank, slot_polarity}. Adds capacity. Defaults to the frame's aura polarity." },
        exilus: { description: "Exilus mod name or {name, rank, slot_polarity}." },
        reactor: { type: "boolean", description: "Orokin Reactor installed. Default true." },
        base_stats: { type: "object", description: "Overrides for rank 30 health, shields, armor or energy." },
      },
      required: ["warframe"],
    },
    run: warframeBuild,
  },
  {
    name: "weapon_build",
    description: "Calculate a primary, secondary or melee weapon build: damage by type, crit, status, DPS and mod capacity. Melee results also give range and heavy attack damage.",
    inputSchema: {
      type: "object",
      properties: {
        weapon: { type: "string" },
        mods: modList,
        exilus: { description: "Exilus mod name or {name, rank, slot_polarity}." },
        stance: { description: "Melee only. Stance mod name or {name, rank, slot_polarity}. Adds capacity. Defaults to the weapon's stance polarity." },
        combo_multiplier: { type: "number", description: "Melee only. Combo multiplier from 1 to 12. Default 1. Scales heavy attacks, Blood Rush and Weeping Wounds." },
        attack: { type: "string", description: "Attack mode from list_weapons, such as Incarnon Form. Defaults to the first." },
        catalyst: { type: "boolean", description: "Orokin Catalyst installed. Default true." },
        base_stats: { type: "object", description: "Overrides: damage (by type), critChance, critDamage, statusChance, fireRate, pellets, magazine, reload, heavyAttack, range, windUp." },
      },
      required: ["weapon"],
    },
    run: weaponBuild,
  },
];

TOOLS.push({
  name: "suggest_weapon_build",
  description: "Suggest the mods that give a weapon the most damage, within its capacity, polarities and mod conflicts. Returns the mods with the slot polarity for each, and the full build result.",
  inputSchema: {
    type: "object",
    properties: {
      weapon: { type: "string" },
      goal: { type: "string", enum: Object.keys(GOAL_SCORES), description: "Defaults to sustained_dps for guns and burst_dps for melee. heavy_attack is melee only." },
      mods: { ...modNames, description: "Mods that must be in the build." },
      exclude: { ...modNames, description: "Mods not to use, such as ones you do not own." },
      polarities: { ...modNames, description: "The weapon's slot polarities, if you have added Forma. Defaults to the weapon's own." },
      stance: { type: "string", description: "Melee only. Defaults to a fitting stance, chosen only for its capacity." },
      combo_multiplier: { type: "number", description: "Melee only. Combo multiplier from 1 to 12. Default 12." },
      attack: { type: "string", description: "Attack mode from list_weapons. Defaults to the first." },
      catalyst: { type: "boolean", description: "Orokin Catalyst installed. Default true." },
    },
    required: ["weapon"],
  },
  run: suggestWeaponBuild,
});

function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "warframe-builder", version: "0.4.0" },
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
