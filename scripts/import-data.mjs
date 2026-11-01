#!/usr/bin/env node
// Regenerates data.json from WFCD warframe-items, plus the Warframe wiki for rank 30 stats.
import { writeFileSync } from "node:fs";
import { parseLua, parseLuaAfter } from "./lua.mjs";

const WFCD = "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json";
const WIKI = "https://wiki.warframe.com/w/Module:Warframes/data?action=raw";
const WIKI_MODULE = (name) => `https://wiki.warframe.com/w/Module:${name}?action=raw`;
const WIKI_WEAPONS = (slot) => WIKI_MODULE(`Weapons/data/${slot}`);
const OUTPUT = new URL("../data.json", import.meta.url);

const MOD_SLOTS = {
  "Warframe Mod": "warframe", "Primary Mod": "primary", "Shotgun Mod": "shotgun", "Secondary Mod": "secondary",
  "Melee Mod": "melee", "Stance Mod": "stance", "Arch-Gun Mod": "archgun", "Arch-Melee Mod": "archmelee",
  "Archwing Mod": "archwing", "Necramech Mod": "necramech", "Companion Mod": "companion",
};
// Companion mods are mostly for the companion itself, but claw mods go on its weapon.
const FRAME_MOD_SLOTS = new Set(["warframe", "archwing", "necramech", "companion"]);
const WARFRAME_STATS = {
  Health: "health", "Shield Capacity": "shields", Armor: "armor", "Energy Max": "energy",
  "Ability Strength": "strength", "Ability Duration": "duration", "Ability Range": "range", "Ability Efficiency": "efficiency",
};
const WEAPON_STATS = {
  Damage: "damage", "Melee Damage": "damage", "Attack Speed": "fireRate", Multishot: "multishot", "Critical Chance": "critChance", "Critical Damage": "critDamage",
  "Fire Rate": "fireRate", "Magazine Capacity": "magazine", "Reload Speed": "reload", "Status Chance": "statusChance",
  Heat: "heat", Cold: "cold", Electricity: "electricity", Toxin: "toxin",
  Impact: "impact", Puncture: "puncture", Slash: "slash",
  Blast: "blast", Corrosive: "corrosive", Gas: "gas", Magnetic: "magnetic", Radiation: "radiation", Viral: "viral",
  "Critical Chance stacks with Combo Multiplier": "comboCritChance", "Status Chance per Combo Multiplier": "comboStatusChance",
  "Melee Damage on Heavy Attack": "heavyDamage", "Status Damage": "statusDamage",
  "Melee Damage per Status Type affecting the target": "damagePerStatus", "Direct Damage per Status Type affecting the target": "damagePerStatus",
  "Damage per Status Type affecting the target": "damagePerStatus",
};
const FLAT_WEAPON_STATS = { Range: "meleeRange", "Initial Combo": "initialCombo" };
// First heavy attack multiplier per class, from the wiki's Melee page.
const HEAVY_MULTIPLIERS = {
  "Assault Saw": 6, "Blade and Whip": 4, Claws: 5, Dagger: 5, "Dual Daggers": 5, "Dual Nikanas": 12, "Dual Swords": 5, Fist: 5,
  Glaive: 2, Gunblade: 5, Hammer: 6, "Heavy Blade": 6, "Heavy Scythe": 6, Machete: 6, Nikana: 5, Nunchaku: 5, Polearm: 6,
  Rapier: 4.5, Scythe: 6, Sparring: 12, Staff: 5, Sword: 5, "Sword and Shield": 5, Tonfa: 5, "Two-Handed Nikana": 6, Warfan: 5, Whip: 4.5,
};

const round = (n) => Math.round(n * 10000) / 10000;

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "warframe-builds-mcp data import" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// Reads only the Warframes table of the wiki's Lua module. Fields are one per line at a fixed indent.
function parseWikiWarframes(lua) {
  const start = lua.search(/^\tWarframes = \{/m);
  if (start < 0) throw new Error("Wiki module has no Warframes table");
  const table = lua.slice(start);
  const frames = {};
  for (const match of table.matchAll(/^\t\t(?:\["[^"]+"\]|\w+) = \{\n([\s\S]*?)\n\t\t\}/gm)) {
    const body = match[1];
    const name = body.match(/^\t\t\tName = "([^"]+)"/m)?.[1];
    if (!name) continue;
    const num = (key) => {
      const value = body.match(new RegExp(`^\\t\\t\\t${key} = ([\\d.]+)`, "m"));
      return value ? Number(value[1]) : undefined;
    };
    frames[name] = {
      health: num("HealthRank30"), shields: num("ShieldRank30"),
      energy: num("EnergyRank30"), armor: num("ArmorRank30"),
      passive: body.match(/^\t\t\tPassive = "((?:[^"\\]|\\.)*)"/m)?.[1],
    };
  }
  return frames;
}

function importWarframes(items, wiki) {
  const counts = { wiki: 0, baseFrame: 0, defaultRule: 0 };
  const frames = {};
  for (const w of items.filter((item) => item.productCategory === "Suits")) {
    const baseName = w.name.replace(/ (Prime|Umbra)$/, "");
    const overrides = wiki[w.name] ?? wiki[baseName];
    counts[wiki[w.name] ? "wiki" : overrides ? "baseFrame" : "defaultRule"]++;
    // The wiki's rule: +100 health, +100 shields and +50 energy at rank 30 unless overridden.
    frames[w.name] = {
      health: overrides?.health ?? w.health + 100,
      shields: overrides?.shields ?? w.shield + 100,
      armor: overrides?.armor ?? w.armor,
      energy: overrides?.energy ?? w.power + 50,
      rank0: { health: w.health, shields: w.shield, armor: w.armor, energy: w.power },
      // "aura" here marks a slot that takes any aura, which the wiki calls universal.
      auraPolarity: [w.aura].flat()[0] === "aura" ? "universal" : [w.aura].flat()[0],
      ...([w.aura].flat().length > 1 && { secondAuraPolarity: [w.aura].flat()[1] }),
      polarities: (w.polarities ?? []).filter((polarity) => polarity !== "aura"),
      mastery: w.masteryReq ?? 0,
      abilities: (w.abilities ?? []).map((a) => a.name),
      ...abilityText(w),
    };
  }
  return { frames, counts };
}

// Reads magazine, reload and per-attack ammo cost from the wiki's weapon tables, as WFCD's are missing or
// inconsistent for battery and burst weapons.
function parseWikiWeapons(lua) {
  const weapons = {};
  for (const row of Object.values(parseLuaAfter(lua, "return"))) {
    if (!row?.Name) continue;
    const attacks = {};
    for (const attack of row.Attacks ?? []) {
      if (attack.AttackName) {
        attacks[attack.AttackName] ??= {
          ammoCost: attack.AmmoCost, chargeTime: attack.ChargeTime, multishot: attack.Multishot, aoe: attack.ShotType === "AoE",
        };
      }
    }
    weapons[row.Name] = {
      row, magazine: row.Magazine, reload: row.Reload, attacks,
      trigger: row.Trigger, tags: row.CompatibilityTags ?? [],
      // Vinquibus lists "Aura" for a slot that takes anything, which others call universal.
      weaponClass: row.Class, stancePolarity: row.StancePolarity?.toLowerCase().replace(/^aura$/, "universal"),
      heavyAttack: row.HeavyAttack, range: row.MeleeRange, windUp: row.WindUp, maxRank: row.MaxRank,
    };
  }
  return weapons;
}

// Builds a weapon from a wiki row, for those WFCD does not list: Exalted, Archwing and companion weapons.
// "Aura" marks a slot type in these lists, not a polarity.
const POLARITY = (list) => (list ?? []).map((polarity) => polarity.toLowerCase()).filter((polarity) => polarity !== "aura");
function weaponFromWiki(entry, slot) {
  const { row } = entry;
  const attacks = (row.Attacks ?? []).filter((a) => Object.keys(a.Damage ?? {}).length);
  if (!attacks.length) return undefined;
  const isMelee = ["melee", "archmelee", "claws"].includes(slot);
  const modes = attacks.map((a) => ({
    name: a.AttackName ?? "Normal Attack",
    damage: Object.fromEntries(Object.entries(a.Damage).map(([type, value]) => [type.toLowerCase(), round(value)])),
    critChance: round((a.CritChance ?? 0) * 100),
    critDamage: a.CritMultiplier ?? 1,
    statusChance: round((a.StatusChance ?? 0) * 100),
    fireRate: a.ChargeTime && !a.FireRate ? round(1 / a.ChargeTime) : a.FireRate ?? 1,
    ammoCost: a.AmmoCost ?? 1,
    pellets: a.Multishot ?? 1,
    ...(a.ShotType === "AoE" && { aoe: true }),
  })).sort((a, b) => Number(/^(Partially|Uncharged|Single Pellet)/.test(a.name)) - Number(/^(Partially|Uncharged|Single Pellet)/.test(b.name)));
  return {
    type: row.Class ?? row.Slot,
    slot,
    pellets: attacks[0].Multishot ?? 1,
    magazine: row.Magazine ?? 0,
    reload: round(row.Reload ?? 0),
    mastery: row.Mastery ?? 0,
    ...(row.MaxRank > 30 && { maxRank: row.MaxRank }),
    polarities: POLARITY(row.Polarities),
    trigger: row.Trigger,
    ...(entry.tags.length && { tags: entry.tags }),
    ...(row.Class === "Exalted Weapon" && { exalted: true }),
    ...(["Robotic", "Hound", "Beast"].includes(row.Slot) && { companionWeapon: true }),
    ...(isMelee && {
      stancePolarity: entry.stancePolarity,
      ...(row.HeavyAttack && { heavyAttack: row.HeavyAttack }),
      range: row.MeleeRange,
      windUp: row.WindUp,
    }),
    modes,
  };
}

function wikiWeaponSlot(row) {
  const byClass = (weaponClass) => {
    if (/Shotgun/.test(weaponClass)) return "shotgun";
    if (/Rifle|Bow|Launcher|Speargun|Crossbow/.test(weaponClass)) return "primary";
    if (/Pistol/.test(weaponClass)) return "secondary";
    return "melee";
  };
  if (row.Slot === "Primary") return row.Class === "Shotgun" ? "shotgun" : "primary";
  if (row.Slot === "Secondary") return "secondary";
  if (row.Slot === "Melee") return "melee";
  if (row.Slot === "Archgun") return "archgun";
  if (row.Slot === "Archmelee") return "archmelee";
  if (row.Slot === "Beast") return "claws";
  if (row.Slot === "Robotic" || row.Slot === "Hound") return byClass(row.Class);
  return undefined; // atmosphere copies, vehicles, emplacements and gear are not modded as weapons
}

function importWikiOnlyWeapons(rows, weapons) {
  let added = 0;
  const known = new Set(Object.keys(weapons).map((name) => name.toLowerCase()));
  for (const [name, entry] of Object.entries(rows)) {
    if (known.has(name.toLowerCase())) continue;
    // WFCD lists hybrid weapons by one name, so "Vinquibus" already covers its gun form.
    if (name === "Vinquibus (Primary)") continue;
    const slot = wikiWeaponSlot(entry.row);
    const weapon = slot && weaponFromWiki(entry, slot);
    if (!weapon) continue;
    weapons[name] = weapon;
    added++;
  }
  // The wiki splits this one by form, which is more exact than WFCD's single entry.
  if (weapons["Dark Split-Sword (Dual Swords)"]) delete weapons["Dark Split-Sword"];
  return added;
}

// Reads mod conflicts and descriptions. Its BaseDrain and MaxRank are not used: rendered wiki pages and WFCD
// agree against them for mods like Hell's Chamber, where the module holds the Flawed version's numbers.
const tagList = (body, key) => [...(body.match(new RegExp(`^\\t\\t\\t${key} = \\{([^}]*)\\}`, "m"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((tag) => tag[1]);

function parseWikiMods(lua) {
  const byId = {};
  const byName = {};
  for (const match of lua.matchAll(/^\t\t(?:\["[^"]+"\]|\w+) = \{\n([\s\S]*?)\n\t\t\}/gm)) {
    const body = match[1];
    const name = body.match(/^\t\t\tName = "([^"]+)"/m)?.[1];
    if (!name) continue;
    const list = body.match(/^\t\t\tIncompatible = \{([^}]*)\}/m)?.[1] ?? "";
    const entry = {
      incompatible: [...list.matchAll(/"([^"]+)"/g)].map((item) => item[1]).filter((other) => other !== name),
      description: body.match(/^\t\t\tDescription = "([^\n]*)",?$/m)?.[1],
      requiredTags: tagList(body, "CompatibilityTags"),
      blockedTags: tagList(body, "IncompatibilityTags"),
    };
    const id = body.match(/^\t\t\tInternalName = "([^"]+)"/m)?.[1];
    if (id) byId[id] = entry;
    byName[name.toLowerCase()] ??= entry;
  }
  return { byId, byName };
}

// Reads a mod's real rank table from its wiki page, such as "Rank Effect Cost 0 +20% 10 1 +40% 11 ...".
// Only the first table counts: the page lists the Flawed version separately after it.
async function fetchRankTable(name) {
  const page = await fetchText(`https://wiki.warframe.com/w/${encodeURIComponent(name.replace(/ /g, "_"))}`);
  const text = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ").replace(/\s+/g, " ");
  const start = text.search(/Rank [A-Z][\w ]{0,30}? ?Cost 0 /);
  if (start < 0) return undefined;
  const table = text.slice(start).split(/ Flawed Rank | Drop Locations /)[0];
  const rows = [...table.matchAll(/(?:^|\s)(\d+) ([+-]?[\d.]+%|-) (\d+)(?=\s|$)/g)];
  if (rows.length < 2 || Number(rows[0][1]) !== 0) return undefined;
  const last = rows.at(-1);
  return { maxRank: Number(last[1]), baseDrain: Number(rows[0][3]), topEffect: last[2] };
}

function attackRate(attack, weapon, wikiAttack) {
  // Charge weapons such as Lanka have no attack speed, only a charge time.
  if (attack.speed === undefined) {
    return wikiAttack?.chargeTime ? round(1 / wikiAttack.chargeTime) : round(weapon.fireRate ?? 0);
  }
  // Attack speeds are rounded in the source, so prefer the precise top-level rate when they agree.
  return Math.abs(attack.speed - weapon.fireRate) < 0.01 ? round(weapon.fireRate) : attack.speed;
}

// The sources disagree on some heavy attacks and often differ from the class multiplier, mostly on multi-hit
// classes. Take a value that fits the multiplier, or flag the listed one as unconfirmed.
function heavyAttack(w, extra, attacks) {
  const listed = [extra?.heavyAttack, w.heavyAttackDamage].filter(Boolean);
  if (!listed.length) return {};
  const total = Object.values(attacks[0].damage).reduce((sum, value) => sum + value, 0);
  const multiplier = HEAVY_MULTIPLIERS[extra?.weaponClass];
  const fits = listed.find((value) => multiplier && Math.abs(value - total * multiplier) <= total * multiplier * 0.02);
  return fits
    ? { heavyAttack: fits }
    : { heavyAttack: listed[0], heavyUnconfirmed: multiplier ? `listed damage does not match this class's ${multiplier}x heavy attack multiplier` : "no class multiplier to check it against" };
}

function importWeapons(items, wiki) {
  const weapons = {};
  // WFCD writes a few names differently, such as Ax-52 for AX-52.
  const wikiNames = new Map(Object.keys(wiki).map((name) => [name.toLowerCase(), name]));
  for (const w of items) {
    // Some weapons list an attack with no damage ahead of their real one, which would default to 0 DPS.
    const attacks = (w.attacks ?? []).filter((a) => Object.keys(a.damage ?? {}).length);
    if (!attacks.length) continue;
    const melee = w.category === "Melee";
    const slot = melee ? "melee" : w.type === "Shotgun" ? "shotgun" : w.category === "Primary" ? "primary" : "secondary";
    const extra = wiki[wikiNames.get(w.name.toLowerCase())];
    weapons[extra?.row.Name ?? w.name] = {
      type: melee ? extra?.weaponClass ?? "Melee" : w.type,
      slot,
      pellets: w.multishot ?? 1,
      magazine: extra?.magazine ?? w.magazineSize ?? 0,
      reload: round(extra?.reload ?? w.reloadTime ?? 0),
      mastery: w.masteryReq ?? 0,
      polarities: POLARITY(w.polarities),
      exilusPolarity: w.exilusPolarity,
      trigger: extra?.trigger ?? w.trigger,
      ...(extra?.maxRank > 30 && { maxRank: extra.maxRank }),
      ...(extra?.tags.length && { tags: extra.tags }),
      ...(melee && {
        stancePolarity: extra?.stancePolarity ?? w.stancePolarity,
        ...heavyAttack(w, extra, attacks),
        range: extra?.range ?? w.range,
        windUp: extra?.windUp ?? w.windUp,
      }),
      // Partial charges are listed first on some weapons, but full charges are how they are used.
      modes: attacks.map((a) => ({
        name: a.name,
        damage: Object.fromEntries(Object.entries(a.damage ?? {}).map(([type, value]) => [type, round(value)])),
        critChance: a.crit_chance,
        critDamage: a.crit_mult,
        statusChance: a.status_chance,
        fireRate: attackRate(a, w, extra?.attacks[a.name]),
        ammoCost: extra?.attacks[a.name]?.ammoCost ?? 1,
        pellets: extra?.attacks[a.name]?.multishot ?? w.multishot ?? 1,
        ...((a.shot_type === "AoE" || extra?.attacks[a.name]?.aoe) && { aoe: true }),
      })).sort((a, b) => Number(/^(Partially|Uncharged|Single Pellet)/.test(a.name)) - Number(/^(Partially|Uncharged|Single Pellet)/.test(b.name))),
    };
  }
  return weapons;
}

// Reads effects that need a trigger, such as "On Kill: +40% Multishot for 20s. Stacks up to 2x."
function parseConditional(line, stats) {
  const match = line.match(/^((?:On|When|While|After) [^:]+):\s*(?:(\d+(?:\.\d+)?)% chance for )?([+-]?\d+(?:\.\d+)?)% (.+?)(?: when Aiming)?(?: to ([A-Z][^.]*?))?(?: for (\d+(?:\.\d+)?)s)?\.?(?: Stacks up to (\d+)x\.?)?$/);
  const stat = match && stats[match[4]];
  if (!stat) return undefined;
  return {
    trigger: match[1],
    ...(match[2] && { chance: Number(match[2]) }),
    effects: { [stat]: Number(match[3]) },
    ...(match[5] && { appliesTo: match[5] }),
    ...(match[6] && { seconds: Number(match[6]) }),
    stacks: Number(match[7] ?? 1),
    text: line,
  };
}

function parseLines(lines, stats) {
  const effects = {};
  const other = [];
  const conditional = [];
  for (const raw of lines) {
    const line = raw.replace(/<[^>]+>/g, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    const faction = stats === WEAPON_STATS && line.match(/^x(\d+(?:\.\d+)?) Damage to (.+)$/);
    if (faction) {
      effects[`faction:${faction[2]}`] = round((Number(faction[1]) - 1) * 100);
      continue;
    }
    // What an aura does for its own Warframe. Squadmates get the rest, which stays listed as text.
    const aura = stats === WARFRAME_STATS && line.match(/^(Squad (?:gains|receives)|You lose) \+?(\d+(?:\.\d+)?)% (Maximum Health|Maximum Shields?|Shield Capacity|Armor|Ability Strength|Ability Duration|Ability Range|Ability Efficiency|Energy Max|Maximum Energy)/);
    if (aura) {
      const stat = { "Maximum Health": "health", "Maximum Shield": "shields", "Maximum Shields": "shields", "Maximum Energy": "energy" }[aura[3]] ?? stats[aura[3]];
      effects[stat] = (effects[stat] ?? 0) + Number(aura[2]) * (aura[1] === "You lose" ? -1 : 1);
      if (aura[1] === "You lose") other.push(line);
      continue;
    }
    const triggered = parseConditional(line, stats);
    if (triggered) {
      conditional.push(triggered);
      continue;
    }
    if (/Multishot cannot be modified/.test(line)) effects.multishotLocked = 1;
    const flat = stats === WEAPON_STATS && line.match(/^([+-]?\d+(?:\.\d+)?) (.+)$/);
    if (flat && FLAT_WEAPON_STATS[flat[2]]) {
      effects[FLAT_WEAPON_STATS[flat[2]]] = (effects[FLAT_WEAPON_STATS[flat[2]]] ?? 0) + Number(flat[1]);
      continue;
    }
    const match = line.match(/^([+-]?\d+(?:\.\d+)?)% (.+?)(?: \(x(\d+(?:\.\d+)?) for (Bows|Heavy Attacks)\))?$/);
    const stat = match && stats[match[2]];
    if (!stat) {
      if (line) other.push(line);
      continue;
    }
    effects[stat] = (effects[stat] ?? 0) + Number(match[1]);
    if (match[4] === "Bows") effects.fireRateBow = Number(match[1]) * Number(match[3]);
    if (match[4] === "Heavy Attacks") effects.heavyCritChance = Number(match[1]) * (Number(match[3]) - 1);
  }
  return { effects, other, ...(conditional.length && { conditional }) };
}

// Names can have several variants: tutorial Beginner/Intermediate copies, unobtainable Expert copies, and a
// few internal duplicates. Prefer the plain mod, as "Hellfire" Expert (+165%) is not the Hellfire players own.
function pickVariant(variants, wikiMods) {
  let pool = variants.filter((m) => !/\/(Beginner|Intermediate)\//.test(m.uniqueName));
  if (pool.length === 0) pool = variants;
  if (pool.length > 1) {
    const plain = pool.filter((m) => !/\/Expert\//.test(m.uniqueName));
    if (plain.length) pool = plain;
  }
  if (pool.length > 1) {
    const standard = pool.filter((m) => /\/Mods\/(Warframe|Aura|Rifle|Shotgun|Pistol|Melee)\//.test(m.uniqueName));
    if (standard.length) pool = standard;
  }
  if (pool.length > 1) {
    // Pressure Point has an unlisted +200% copy in WFCD, so a variant the wiki knows wins.
    const known = pool.filter((m) => wikiMods.byId[m.uniqueName]);
    if (known.length) pool = known;
  }
  return pool[0];
}

async function importMods(items, wikiMods, weapons) {
  const weaponTags = new Set(["MODULAR_GUN", ...Object.values(weapons).flatMap((w) => w.tags ?? [])]);
  const sets = Object.fromEntries(items.filter((m) => m.type === "Mod Set Mod").map((m) => [m.uniqueName, m]));
  const groups = new Map();
  for (const m of items) {
    if (!MOD_SLOTS[m.type]) continue;
    const key = `${m.type}|${m.name}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  const warframeMods = {};
  const weaponMods = {};
  let nonLinear = 0;
  const flawedOnly = { repaired: [], unverified: [] };
  for (const variants of groups.values()) {
    const m = pickVariant(variants, wikiMods);
    const slot = m.type === "Companion Mod" && /Claws/.test(m.compatName ?? "") ? "claws" : MOD_SLOTS[m.type];
    const stats = FRAME_MOD_SLOTS.has(slot) ? WARFRAME_STATS : WEAPON_STATS;
    // A Beginner or Intermediate ID points at the wiki's Flawed row, so those go by name to reach the real mod.
    const flawedCopy = /\/(Beginner|Intermediate)\//.test(m.uniqueName);
    const wikiMod = (!flawedCopy && wikiMods.byId[m.uniqueName]) || wikiMods.byName[m.name.toLowerCase()];
    let levels = (m.levelStats ?? []).map((level) => parseLines(level.stats, stats));
    let maxRank = m.fusionLimit ?? 0;
    let baseDrain = Math.abs(m.baseDrain ?? 0);
    let unverified = false;

    // WFCD only has the weak tutorial copy of some real mods, such as Quick Thinking. Take the real
    // rank and drain from the wiki page, and the real effect from the wiki's description.
    if (flawedCopy) {
      const table = await fetchRankTable(m.name).catch(() => undefined);
      if (table && wikiMod?.description) {
        maxRank = table.maxRank;
        baseDrain = table.baseDrain;
        // Descriptions can be stale, so a single percentage takes its value from the rank table.
        const lines = wikiMod.description.split(/\\r|\\n/).filter(Boolean).map((line) => (
          (line.match(/%/g) ?? []).length === 1 ? line.replace(/[+-]?[\d.]+%/, table.topEffect) : line
        ));
        levels = [parseLines(lines, stats)];
        flawedOnly.repaired.push(m.name);
      } else {
        unverified = true;
        flawedOnly.unverified.push(m.name);
      }
    }
    const top = levels.at(-1) ?? { effects: {}, other: [] };
    const multishotLocked = Boolean(top.effects.multishotLocked);
    for (const level of levels) delete level.effects.multishotLocked;

    const entry = {
      slot,
      compat: m.compatName,
      rarity: m.rarity,
      polarity: m.polarity,
      baseDrain,
      maxRank,
      effects: top.effects,
    };
    if (top.other.length) entry.other = top.other;
    if (top.conditional) entry.conditional = top.conditional;
    if (m.modSet) {
      const set = sets[m.modSet];
      entry.set = m.modSet.split("/").at(-2);
      if (set?.stats) entry.setBonus = set.stats;
    }
    if (m.compatName === "AURA") entry.aura = true;
    if (slot === "stance") entry.stance = true;
    if (multishotLocked) entry.multishotLocked = true;
    if (/PvP/.test(m.uniqueName)) entry.pvpOnly = true;
    if (/Fire Rate cannot be modified/.test(wikiMod?.description ?? "")) entry.fireRateLocked = true;
    // Only tags a real weapon has matter here. SEMI_AUTO goes by each weapon's trigger, as few carry the tag.
    const required = (wikiMod?.requiredTags ?? []).filter((tag) => tag === "SEMI_AUTO" || weaponTags.has(tag));
    const blocked = (wikiMod?.blockedTags ?? []).filter((tag) => weaponTags.has(tag));
    if (required.length && slot !== "stance") entry.requiredTags = required;
    if (blocked.length) entry.blockedTags = blocked;
    if (m.isExilus || m.isUtility) entry.exilus = true;
    if (unverified) entry.unverified = true;
    if (wikiMod?.incompatible.length) entry.incompatible = wikiMod.incompatible;

    // Most mods scale linearly with rank. Keep exact per-rank values for the ones that do not.
    const scales = levels.every((level, rank) => Object.entries(top.effects).every(([stat, value]) => {
      if (levels.length === 1) return true;
      const expected = (value * (rank + 1)) / levels.length;
      return Math.abs((level.effects[stat] ?? 0) - expected) <= Math.max(0.6, Math.abs(expected) * 0.02);
    }));
    if (!scales) {
      entry.effectsByRank = levels.map((level) => level.effects);
      nonLinear++;
    }

    const table = FRAME_MOD_SLOTS.has(slot) ? warframeMods : weaponMods;
    if (table[m.name]) {
      // The same name exists for several weapon classes, so the later one gets a qualified key.
      table[`${m.name} (${slot})`] = entry;
    } else {
      table[m.name] = entry;
    }
  }
  return { warframeMods, weaponMods, nonLinear, flawedOnly };
}

function importOtherFrames(items, kind) {
  const frames = {};
  for (const f of items) {
    if (!f.health || f.productCategory === undefined && !f.type) continue;
    if (kind === "companion" && !/Sentinel|Kavat|Kubrow|Predasite|Vulpaphyla|Hound|Moa|Pets/.test(f.type ?? "")) continue;
    if (/\b(Resource|Parts?)\b/.test(f.type ?? "")) continue;
    frames[f.name] = {
      kind,
      type: f.type,
      // These are the stats the sources list. Unlike Warframes, they have no published rank 30 rule.
      health: f.health, shields: f.shield ?? 0, armor: f.armor ?? 0, energy: f.power ?? 0,
      polarities: (f.polarities ?? []).filter((polarity) => polarity !== "aura"),
      mastery: f.masteryReq ?? 0,
      abilities: (f.abilities ?? []).map((a) => a.name),
      ...abilityText(f),
    };
  }
  return frames;
}

function importArcanes(items) {
  const weaponTypes = { "Primary Arcane": "primary", "Shotgun Arcane": "shotgun", "Bow Arcane": "bow", "Secondary Arcane": "secondary", "Melee Arcane": "melee", "Zaw Arcane": "zaw", "Kitgun Arcane": "kitgun" };
  const arcanes = {};
  for (const a of items) {
    const levels = a.levelStats ?? [];
    if (!a.name || !levels.length || a.name === "Arcane") continue;
    // A trigger's line break is part of it, and sources repeat a stat as both a line and its own entry.
    const lines = [...new Set((levels.at(-1).stats ?? []).flatMap((line) => line.split(/(?<!:)\\n/)))];
    const forWeapon = parseLines(lines, WEAPON_STATS);
    const forFrame = parseLines(lines, WARFRAME_STATS);
    arcanes[a.name] = {
      type: weaponTypes[a.type] ?? (a.type ?? "Arcane").replace(/ Arcane$/, "").toLowerCase(),
      rarity: a.rarity,
      maxRank: levels.length - 1,
      text: lines.map((line) => line.replace(/<[^>]+>/g, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim()),
      ...(Object.keys(forWeapon.effects).length && { weaponEffects: forWeapon.effects }),
      ...(forWeapon.conditional && { weaponConditional: forWeapon.conditional }),
      ...(Object.keys(forFrame.effects).length && { frameEffects: forFrame.effects }),
      ...(forFrame.conditional && { frameConditional: forFrame.conditional }),
    };
  }
  return arcanes;
}

// Each combo's total damage multiplier and its length, which melee DPS needs. Only combos with a timed animation count.
function importStances(lua) {
  const stances = {};
  for (const [name, stance] of Object.entries(parseLuaAfter(lua, "local StanceData ="))) {
    if (!stance?.WeaponType || !stance.StanceName || stance.ConclaveOnly) continue;
    const combos = [];
    for (const key of ["Forward", "Neutral", "Block", "Forward Block"]) {
      const combo = stance[key];
      if (!combo?.Duration || !combo.Attacks) continue;
      let hits = 0;
      let multiplier = 0;
      for (const attack of combo.Attacks) {
        (attack.Dmg ?? []).forEach((dmg, i) => {
          const count = attack.Hits?.[i] ?? 1;
          hits += count;
          multiplier += (dmg / 100) * count;
        });
      }
      combos.push({ input: key, name: combo.Name, duration: combo.Duration, hits, multiplier: round(multiplier) });
    }
    if (combos.length) stances[name] = { weaponType: stance.WeaponType, combos };
  }
  return stances;
}

// Each faction's damage multipliers. Since Damage 3.0 these are a flat x1.5 or x0.5, with no enemy-specific types.
function importFactions(lua) {
  const { Health, Types } = parseLuaAfter(lua, "local DamageTypes =");
  const factions = {};
  for (const [name, info] of Object.entries(Health)) {
    if (info.Type !== "Health" || !info.Faction?.includes(name)) continue; // skips Damage 2.0 types and non-enemies
    if (["Tenno", "Overguard", "Object"].includes(name)) continue;
    factions[name] = {};
  }
  for (const [type, info] of Object.entries(Types)) {
    for (const faction of info.Positives ?? []) if (factions[faction]) factions[faction][type.toLowerCase()] = 1.5;
    for (const faction of info.Negatives ?? []) if (factions[faction]) factions[faction][type.toLowerCase()] = 0.5;
  }
  return factions;
}

function importModular(lua) {
  const { KitgunPrimary, KitgunSecondary, Zaw } = parseLuaAfter(lua, "return");
  const kitgun = (table) => ({
    chambers: Object.fromEntries(Object.entries(table.Chamber).map(([name, c]) => [name, {
      damage: c.Damage, fireRate: c.FireRate, magazine: c.Magazine, critChance: c.CritChance, critDamage: c.CritMultiplier,
      statusChance: c.StatusChance, trigger: c.Trigger, multishot: c.Multishot ?? 1, ammoCost: c.AmmoCost ?? 1, tags: c.CompatibilityTags ?? [],
    }])),
    grips: Object.keys(table.Grip),
    loaders: Object.fromEntries(Object.entries(table.Loader).map(([name, l]) => [name, {
      critChance: l.CritChance, critDamage: l.CritMultiplier, statusChance: l.StatusChance, magazine: l.Magazine, reload: l.Reload,
    }])),
  });
  return {
    kitgun: { primary: kitgun(KitgunPrimary), secondary: kitgun(KitgunSecondary) },
    zaw: {
      strikes: Object.fromEntries(Object.entries(Zaw.Strike).map(([name, z]) => [name, {
        damage: z.Damage, critChance: z.CritChance, critDamage: z.CritMultiplier, statusChance: z.StatusChance, speed: z.Speed,
        types: z.Type, twoHandedFactor: z.Multi?.TwoHanded?.Base ?? 1,
      }])),
      grips: Object.fromEntries(Object.entries(Zaw.Grip).map(([name, g]) => [name, { damage: g.Damage, speed: g.Speed, hands: g.Type }])),
      links: Object.fromEntries(Object.entries(Zaw.Link).map(([name, l]) => [name, {
        damage: l.Damage, speed: l.Speed, critChance: l.CritChance ?? 0, statusChance: l.StatusChance ?? 0,
      }])),
    },
  };
}

// Game text marks damage types with tags such as <DT_CORROSIVE_COLOR>, and scaling values with |DURATION|.
const cleanText = (text) => String(text ?? "").replace(/<DT_(\w+?)_COLOR>/g, "").replace(/<[^>]+>/g, "").replace(/\|\w+\|/g, "#").replace(/\s+/g, " ").trim();

function abilityText(frame) {
  return {
    ...(frame.passiveDescription && { passive: cleanText(frame.passiveDescription) }),
    ...(frame.abilities?.length && { abilityText: frame.abilities.map((a) => ({ name: a.name, text: cleanText(a.description) })) }),
  };
}

// Mods with no parsed stats can still say what they do, in their game description.
function addDescriptions(modTables, items) {
  const byName = new Map(items.map((item) => [item.name, item]));
  for (const table of modTables) {
    for (const [name, mod] of Object.entries(table)) {
      const text = cleanText(byName.get(name)?.description);
      if (text && !Object.keys(mod.effects).length && !mod.other?.length && !mod.conditional?.length) mod.other = [text];
    }
  }
}

const ENEMY_FACTIONS = { Infestation: "Infested", Infested: "Infested", Corrupted: "Orokin", Sentients: "Sentient", Murmur: "The Murmur" };

// The wiki keeps one enemy table per faction.
function importEnemies(sources, factions) {
  const enemies = {};
  for (const lua of sources) {
    for (const entry of Object.values(parseLua(lua, lua.indexOf("{")))) {
      const { General: general, Stats: stats } = entry;
      if (!general?.Name || !stats || typeof stats.BaseLevel !== "number" || enemies[general.Name]) continue;
      const faction = ENEMY_FACTIONS[general.Faction] ?? general.Faction;
      enemies[general.Name] = {
        ...(factions[faction] && { faction }),
        ...(general.Type && { type: general.Type }),
        armor: stats.Armor ?? 0, // the wiki leaves it out for unarmored enemies
        baseLevel: stats.BaseLevel,
        ...(typeof stats.SpawnLevel === "number" && { spawnLevel: stats.SpawnLevel }),
        ...(typeof stats.Health === "number" && { health: stats.Health }),
        ...(typeof stats.Shield === "number" && { shields: stats.Shield }),
      };
    }
  }
  return enemies;
}

// Runs a few at a time, as these all go to the wiki.
async function mapLimit(items, limit, run) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]);
    }
  }));
  return results;
}

// One retry after a pause, as the wiki can briefly refuse a burst of requests.
async function wikiPage(name) {
  const url = `https://wiki.warframe.com/w/${encodeURIComponent(name.replace(/ /g, "_"))}?action=raw`;
  for (const pause of [0, 3000, 10000]) {
    await new Promise((resolve) => { setTimeout(resolve, pause); });
    try {
      return await fetchText(url);
    } catch {
      // Tries again, or returns nothing below.
    }
  }
  return "";
}

// Wiki markup down to plain text, keeping only the top rank of values such as "6 / 8 / 8 / 10".
function wikiText(text) {
  return text
    .replace(/<br\s*\/?>/g, "; ").replace(/<[^>]+>/g, "")
    .replace(/\{\{(?:D|A|WF|M|Stat|Weapon|E|Tooltip)\|([^|}]+)[^}]*\}\}/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/'{2,}/g, "")
    .replace(/&infin;/g, "unlimited").replace(/&[a-z]+;/g, " ")
    .replace(/(?:[+-]?[\d.]+%?(?:\s?(?:m|s))?\s*\/\s*)+([+-]?[\d.]+)/g, "$1")
    .replace(/\s+/g, " ").replace(/(;\s*)+$/, "").trim();
}

const SCALING_FIELDS = ["strength", "duration", "range", "misc"];

// What each ability scales with, from the parameters on its wiki page. A page that can't be read just goes without.
async function importAbilityDetails(moduleLua) {
  const table = parseLuaAfter(moduleLua, "\n\tAbility = ");
  const entries = Object.values(table).filter((entry) => entry.Powersuit && entry.Name);
  const pages = await mapLimit(entries, 4, async (entry) => wikiPage(entry.Link ?? entry.Name));
  console.log(`Ability pages read: ${pages.filter(Boolean).length} of ${entries.length}.`);
  const details = {};
  entries.forEach((entry, i) => {
    const field = (name) => {
      const match = pages[i].match(new RegExp(`^\\|\\s*${name}\\s*=\\s*([\\s\\S]*?)(?=^\\s*\\||^\\}\\})`, "m"));
      const text = match ? wikiText(match[1]) : "";
      return text && !/^(n\/a|none)$/i.test(text) ? text : undefined;
    };
    const scaling = Object.fromEntries(SCALING_FIELDS.map((name) => [name, field(name)]).filter(([, value]) => value));
    const weapon = typeof entry.Weapon === "string" ? entry.Weapon.replace(/ \(.*\)$/, "") : undefined;
    (details[entry.Powersuit] ??= {})[entry.Name.toLowerCase()] = {
      ...(typeof entry.Cost === "number" && { cost: entry.Cost }),
      ...(entry.IsChanneled && { channeled: true }),
      ...(weapon && { weapon }),
      ...(Object.keys(scaling).length && { scaling }),
    };
  });
  return details;
}

// WFCD marks every mod that began in Conclave as PvP, though the wiki says some were later opened up to all missions.
async function reopenPveMods(modTables) {
  const flagged = modTables.flatMap((table) => Object.entries(table).filter(([, mod]) => mod.pvpOnly));
  const opened = [];
  await mapLimit(flagged, 4, async ([name, mod]) => {
    // A page that can't be read stays flagged, which only means the mod isn't suggested.
    if (/usable in both PvE|available in PvE|in both PvE and|PvE and \[*Conclave/i.test(await wikiPage(name))) {
      delete mod.pvpOnly;
      opened.push(name);
    }
  });
  return opened;
}

function check(condition, message) {
  if (!condition) throw new Error(`Sanity check failed: ${message}. The source format may have changed; data.json was not written.`);
}

const ENEMY_MODULES = ["grineer", "corpus", "infestation", "orokin", "sentient", "stalker", "narmer", "themurmur", "techrot", "scaldra", "anarchs", "unaffiliated"];
const [
  warframes, primary, secondary, melee, mods, arcaneItems, archwingItems, sentinelItems, petItems,
  wikiLua, wikiPrimary, wikiSecondary, wikiMelee, wikiArchwing, wikiCompanion, wikiModsLua, wikiStances, wikiDamage, wikiModular,
] = await Promise.all([
  ...["Warframes", "Primary", "Secondary", "Melee", "Mods", "Arcanes", "Archwing", "Sentinels", "Pets"]
    .map((file) => fetchText(`${WFCD}/${file}.json`).then(JSON.parse)),
  fetchText(WIKI),
  fetchText(WIKI_WEAPONS("primary")),
  fetchText(WIKI_WEAPONS("secondary")),
  fetchText(WIKI_WEAPONS("melee")),
  fetchText(WIKI_WEAPONS("archwing")),
  fetchText(WIKI_WEAPONS("companion")),
  fetchText(WIKI_MODULE("Mods/data")),
  fetchText(WIKI_MODULE("Stances/data")),
  fetchText(WIKI_MODULE("DamageTypes/data")),
  fetchText(WIKI_MODULE("Modular/data")),
]);
const wikiAbilities = await fetchText(WIKI_MODULE("Ability/data"));
const wikiEnemies = await Promise.all(ENEMY_MODULES.map((name) => fetchText(WIKI_MODULE(`Enemies/data/${name}`))));

const wiki = parseWikiWarframes(wikiLua);
const { frames, counts } = importWarframes(warframes, wiki);
const wikiWeapons = {
  ...parseWikiWeapons(wikiPrimary), ...parseWikiWeapons(wikiSecondary), ...parseWikiWeapons(wikiMelee),
  ...parseWikiWeapons(wikiArchwing), ...parseWikiWeapons(wikiCompanion),
};
// WFCD's melee file also holds Zaw parts, which are not weapons on their own. Some real melee weapons are typed Rifle there.
const weapons = importWeapons([...primary, ...secondary, ...melee.filter((w) => w.type !== "Zaw Component")], wikiWeapons);
const wikiOnly = importWikiOnlyWeapons(wikiWeapons, weapons);
const { warframeMods, weaponMods, nonLinear, flawedOnly } = await importMods(mods, parseWikiMods(wikiModsLua), weapons);

// Values confirmed against the wiki's rendered pages when this script was written.
check(Object.keys(frames).length >= 100, "too few Warframes");
check(Object.keys(weapons).length >= 650, "too few weapons");
const stances = importStances(wikiStances);
const factions = importFactions(wikiDamage);
const modular = importModular(wikiModular);
const enemies = importEnemies(wikiEnemies, factions);
addDescriptions([warframeMods, weaponMods], mods);
const arcanes = importArcanes(arcaneItems);
const companions = importOtherFrames(sentinelItems.concat(petItems), "companion");
const archwings = importOtherFrames(archwingItems, "archwing");
const necramechs = importOtherFrames(warframes.filter((w) => w.type === "Necramech"), "necramech");
const reopened = await reopenPveMods([warframeMods, weaponMods]);
const abilityDetails = await importAbilityDetails(wikiAbilities);
for (const frame of [...Object.entries(frames), ...Object.entries(archwings), ...Object.entries(necramechs)]) {
  const details = abilityDetails[frame[0].replace(/ (Prime|Umbra)$/, "")];
  const wikiPassive = (wiki[frame[0]] ?? wiki[frame[0].replace(/ (Prime|Umbra)$/, "")])?.passive;
  if (wikiPassive) frame[1].passive = wikiPassive;
  for (const ability of frame[1].abilityText ?? []) Object.assign(ability, details?.[ability.name.toLowerCase()]);
}
check(frames.Jade?.auraPolarity === "universal" && frames.Jade.secondAuraPolarity === "vazarin", "Jade's aura slots");
check(weapons["Boar Prime"]?.modes.find((m) => m.name === "Incarnon Form")?.pellets === 1, "pellets per attack");
check(weapons.Ogris?.modes[1].aoe && weapons.Kohm?.modes[0].pellets === 12, "attack details");
check(weapons["AX-52"] && !weapons["Ax-52"], "weapon name matching");
check(weapons["Kuva Bramma"]?.maxRank === 40, "rank 40 weapons");
check(arcanes["Arcane Fury"]?.weaponConditional?.[0].appliesTo === "Melee Weapons", "arcane restrictions");
check(warframeMods["Power Donation"]?.effects.strength === -30 && warframeMods.Physique?.effects.health === 20, "aura effects");
check(weapons["Exalted Blade"]?.exalted && weapons["Exalted Blade"].slot === "melee", "Exalted Blade");
check(weapons.Larkspur?.slot === "archgun" && weapons.Veritux?.slot === "archmelee", "Archwing weapons");
check(weapons["Adarza Claws"]?.slot === "claws" && weapons["Deth Machine Rifle"]?.slot === "primary", "companion weapons");
check(weaponMods["Blood Rush"]?.blockedTags?.includes("POWER_WEAPON"), "Blood Rush is blocked on Exalted weapons");
check(stances["Blind Justice"]?.combos.some((c) => c.input === "Forward" && c.duration === 3.05), "Blind Justice timing");
check(factions.Grineer?.corrosive === 1.5 && factions.Sentient?.corrosive === 0.5, "faction tables");
check(modular.zaw.strikes.Balla?.damage.Puncture === 134.4 && modular.zaw.grips.Korb?.damage === 28, "Zaw parts");
check(modular.kitgun.secondary.chambers.Catchmoon?.damage.Gibber.Heat === 119, "Kitgun parts");
check(arcanes["Primary Merciless"]?.weaponConditional?.[0].stacks === 12, "Primary Merciless");
check(weaponMods["Galvanized Chamber"]?.conditional?.[0].effects.multishot > 0, "Galvanized Chamber");
check(weaponMods["Condition Overload"]?.effects.damagePerStatus === 80, "Condition Overload");
check(weaponMods["Bane Of Grineer"]?.effects["faction:Grineer"] === 30, "Bane of Grineer");
check(companions["Adarza Kavat"]?.health === 310 && archwings.Itzal?.health === 200 && necramechs.Voidrig?.health === 1400, "other frames");
check(frames.Excalibur?.health === 370 && frames.Excalibur?.energy === 150, "Excalibur rank 30 stats");
check(warframeMods.Vitality?.effects.health === 100 && warframeMods.Vitality?.maxRank === 10, "Vitality");
check(warframeMods["Transient Fortitude"]?.effects.duration === -27.5, "Transient Fortitude");
check(weaponMods.Serration?.effects.damage === 165, "Serration");
check(weaponMods.Hellfire?.effects.heat === 90, "Hellfire picked the wrong variant");
check(weapons["Tigris Prime"]?.pellets === 8, "Tigris Prime pellets");
check(Object.keys(wikiWeapons).length >= 300, "too few wiki weapons");
check(Object.keys(enemies).length >= 500, "too few enemies");
check(enemies.Crewman?.armor === 0 && enemies.Crewman.shields > 0, "unarmored enemies");
check(warframeMods["Mesa's Waltz"] && !warframeMods["Mesa's Waltz"].pvpOnly, "Conclave mods opened to PvE");
check(frames.Saryn.abilityText[0].scaling?.strength?.includes("initial damage"), "ability scaling");
check(frames.Mesa.abilityText.some((a) => a.weapon === "Regulators") && frames.Khora.abilityText.some((a) => a.weapon === "Whipclaw"), "Exalted links");
check(enemies["Heavy Gunner"]?.armor === 500 && enemies["Heavy Gunner"].baseLevel === 8 && enemies["Heavy Gunner"].faction === "Grineer", "Heavy Gunner");
check(frames.Saryn?.abilityText?.[0].text.includes("Corrosive") && frames.Saryn.passive, "ability text");
check(weapons.Lanka?.modes[0].name === "Charged Shot" && weapons.Lanka.modes[0].fireRate === 1, "Lanka charge rate");
check(warframeMods["Quick Thinking"]?.maxRank === 5 && warframeMods["Quick Thinking"]?.baseDrain === 10, "Quick Thinking rank table");
check(warframeMods["Primed Flow"]?.incompatible?.includes("Flow"), "Primed Flow conflicts");
check(weapons.Convectrix?.magazine === 70 && weapons.Convectrix.modes[0].ammoCost === 0.5, "Convectrix magazine");
check(weapons["Nikana Prime"]?.heavyAttack === 990 && weapons["Nikana Prime"]?.type === "Nikana", "Nikana Prime heavy attack");
check(weapons["Wolf Sledge"]?.heavyAttack === 1554 && !weapons["Wolf Sledge"].heavyUnconfirmed, "Wolf Sledge heavy attack");
check(weaponMods["Killing Blow"]?.effects.heavyDamage === 120, "Killing Blow heavy damage");
check(weapons.Paracesis?.slot === "melee", "Paracesis is typed Rifle by WFCD but is melee");
check(weaponMods["Pressure Point"]?.effects.damage === 120 && weaponMods["Pressure Point"]?.maxRank === 5, "Pressure Point picked the wrong variant");
check(weaponMods["True Steel"]?.effects.heavyCritChance === 120, "True Steel heavy crit");
check(weaponMods["Blood Rush"]?.effects.comboCritChance === 40, "Blood Rush combo crit");
check(weaponMods["Semi-Rifle Cannonade"]?.requiredTags?.includes("SEMI_AUTO") && weaponMods["Semi-Rifle Cannonade"].fireRateLocked, "Cannonade limits");
check(weaponMods["Split Flights"]?.blockedTags?.includes("CROSSBOW"), "Split Flights blocked tags");
check(weapons["Lex Prime"]?.trigger === "Semi-Auto" && weapons["Soma Prime"]?.trigger === "Auto-Spool", "weapon triggers");
check(weaponMods["Lie In Wait"]?.pvpOnly && !weaponMods.Serration?.pvpOnly, "PvP-only mods");
check(weaponMods["Crimson Dervish"]?.stance && weaponMods["Crimson Dervish"]?.baseDrain === 2, "Crimson Dervish stance");

const data = {
  meta: {
    format: 2, // raised when code must change to read the data
    imported: new Date().toISOString().slice(0, 10),
    sources: ["WFCD/warframe-items (MIT)", "wiki.warframe.com data modules"],
    note: "Warframe game data belongs to Digital Extremes. Regenerate with npm run import-data.",
  },
  warframes: frames,
  companions,
  archwings,
  necramechs,
  weapons,
  warframeMods,
  weaponMods,
  arcanes,
  stances,
  factions,
  enemies,
  modular,
  heavyMultipliers: HEAVY_MULTIPLIERS,
};
writeFileSync(OUTPUT, `${JSON.stringify(data, null, 1)}\n`);

console.log(`Enemies: ${Object.keys(enemies).length}. Conclave mods opened to PvE: ${reopened.length} (${reopened.join(", ")}).`);
console.log(`Warframes: ${Object.keys(frames).length} (rank 30 from wiki ${counts.wiki}, base frame ${counts.baseFrame}, default rule ${counts.defaultRule})`);
console.log(`Weapons: ${Object.keys(weapons).length} (${Object.values(weapons).filter((w) => w.slot === "melee").length} melee, ${Object.values(weapons).filter((w) => w.heavyUnconfirmed).length} with unconfirmed heavy attacks)`);
console.log(`Mods: ${Object.keys(warframeMods).length} Warframe, ${Object.keys(weaponMods).length} weapon, ${nonLinear} with exact per-rank values`);
console.log(`Other frames: ${Object.keys(companions).length} companions, ${Object.keys(archwings).length} Archwings, ${Object.keys(necramechs).length} Necramechs`);
console.log(`Wiki-only weapons: ${wikiOnly}. Arcanes: ${Object.keys(arcanes).length}. Stances: ${Object.keys(stances).length}. Factions: ${Object.keys(factions).length}.`);
console.log(`Flawed-only mods repaired from wiki pages: ${flawedOnly.repaired.length} (${flawedOnly.repaired.join(", ")})`);
console.log(`Flawed-only mods left unverified: ${flawedOnly.unverified.length} (${flawedOnly.unverified.join(", ")})`);
