#!/usr/bin/env node
// Regenerates data.json from WFCD warframe-items, plus the Warframe wiki for rank 30 stats.
import { writeFileSync } from "node:fs";

const WFCD = "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json";
const WIKI = "https://wiki.warframe.com/w/Module:Warframes/data?action=raw";
const WIKI_WEAPONS = (slot) => `https://wiki.warframe.com/w/Module:Weapons/data/${slot}?action=raw`;
const OUTPUT = new URL("../data.json", import.meta.url);

const MOD_SLOTS = {
  "Warframe Mod": "warframe", "Primary Mod": "primary", "Shotgun Mod": "shotgun", "Secondary Mod": "secondary",
  "Melee Mod": "melee", "Stance Mod": "stance",
};
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
  "Melee Damage on Heavy Attack": "heavyDamage",
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
      // "aura" here marks an extra aura slot rather than a polarity.
      auraPolarity: [w.aura].flat().find((polarity) => polarity && polarity !== "aura"),
      polarities: (w.polarities ?? []).filter((polarity) => polarity !== "aura"),
      mastery: w.masteryReq ?? 0,
      abilities: (w.abilities ?? []).map((a) => a.name),
    };
  }
  return { frames, counts };
}

// Reads magazine, reload and per-attack ammo cost from the wiki's weapon tables, as WFCD's are missing or
// inconsistent for battery and burst weapons.
function parseWikiWeapons(lua) {
  const weapons = {};
  for (const match of lua.matchAll(/\n\t(?:\["[^"]+"\]|\w+) = \{\n([\s\S]*?)\n\t\}/g)) {
    const body = match[1];
    const name = body.match(/^\t\tName = "([^"]+)"/m)?.[1];
    if (!name) continue;
    const num = (key) => {
      const value = body.match(new RegExp(`^\\t\\t${key} = ([\\d.]+)`, "m"));
      return value ? Number(value[1]) : undefined;
    };
    const attacks = {};
    for (const attack of body.matchAll(/AmmoCost = ([\d.]+),[\s\S]*?AttackName = "([^"]+)",([\s\S]*?)(?=AmmoCost = |$)/g)) {
      const chargeTime = attack[3].match(/ChargeTime = ([\d.]+)/)?.[1];
      attacks[attack[2]] ??= { ammoCost: Number(attack[1]), chargeTime: chargeTime && Number(chargeTime) };
    }
    const text = (key) => body.match(new RegExp(`^\\t\\t${key} = "([^"]+)"`, "m"))?.[1];
    weapons[name] = {
      magazine: num("Magazine"), reload: num("Reload"), attacks,
      trigger: text("Trigger"),
      tags: [...(body.match(/^\t\tCompatibilityTags = \{([^}]*)\}/m)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((tag) => tag[1]),
      weaponClass: text("Class"), stancePolarity: text("StancePolarity")?.toLowerCase(),
      heavyAttack: num("HeavyAttack"), range: num("MeleeRange"), windUp: num("WindUp"),
    };
  }
  return weapons;
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
  for (const w of items) {
    // Some weapons list an attack with no damage ahead of their real one, which would default to 0 DPS.
    const attacks = (w.attacks ?? []).filter((a) => Object.keys(a.damage ?? {}).length);
    if (!attacks.length) continue;
    const melee = w.category === "Melee";
    const slot = melee ? "melee" : w.type === "Shotgun" ? "shotgun" : w.category === "Primary" ? "primary" : "secondary";
    const extra = wiki[w.name];
    weapons[w.name] = {
      type: melee ? extra?.weaponClass ?? "Melee" : w.type,
      slot,
      pellets: w.multishot ?? 1,
      magazine: extra?.magazine ?? w.magazineSize ?? 0,
      reload: round(extra?.reload ?? w.reloadTime ?? 0),
      mastery: w.masteryReq ?? 0,
      polarities: w.polarities ?? [],
      exilusPolarity: w.exilusPolarity,
      trigger: extra?.trigger ?? w.trigger,
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
      })).sort((a, b) => Number(/^(Partially|Uncharged)/.test(a.name)) - Number(/^(Partially|Uncharged)/.test(b.name))),
    };
  }
  return weapons;
}

function parseLines(lines, stats) {
  const effects = {};
  const other = [];
  for (const raw of lines) {
    const line = raw.replace(/<[^>]+>/g, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
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
  return { effects, other };
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
  const weaponTags = new Set(Object.values(weapons).flatMap((w) => w.tags ?? []));
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
    const slot = MOD_SLOTS[m.type];
    const stats = slot === "warframe" ? WARFRAME_STATS : WEAPON_STATS;
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
    if (m.compatName === "AURA") entry.aura = true;
    if (slot === "stance") entry.stance = true;
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

    const table = slot === "warframe" ? warframeMods : weaponMods;
    if (table[m.name]) {
      // The same name exists for several weapon classes, so the later one gets a qualified key.
      table[`${m.name} (${slot})`] = entry;
    } else {
      table[m.name] = entry;
    }
  }
  return { warframeMods, weaponMods, nonLinear, flawedOnly };
}

function check(condition, message) {
  if (!condition) throw new Error(`Sanity check failed: ${message}. The source format may have changed; data.json was not written.`);
}

const [warframes, primary, secondary, melee, mods, wikiLua, wikiPrimary, wikiSecondary, wikiMelee, wikiModsLua] = await Promise.all([
  fetchText(`${WFCD}/Warframes.json`).then(JSON.parse),
  fetchText(`${WFCD}/Primary.json`).then(JSON.parse),
  fetchText(`${WFCD}/Secondary.json`).then(JSON.parse),
  fetchText(`${WFCD}/Melee.json`).then(JSON.parse),
  fetchText(`${WFCD}/Mods.json`).then(JSON.parse),
  fetchText(WIKI),
  fetchText(WIKI_WEAPONS("primary")),
  fetchText(WIKI_WEAPONS("secondary")),
  fetchText(WIKI_WEAPONS("melee")),
  fetchText("https://wiki.warframe.com/w/Module:Mods/data?action=raw"),
]);

const wiki = parseWikiWarframes(wikiLua);
const { frames, counts } = importWarframes(warframes, wiki);
const wikiWeapons = { ...parseWikiWeapons(wikiPrimary), ...parseWikiWeapons(wikiSecondary), ...parseWikiWeapons(wikiMelee) };
// WFCD's melee file also holds Zaw parts, which are not weapons on their own. Some real melee weapons are typed Rifle there.
const weapons = importWeapons([...primary, ...secondary, ...melee.filter((w) => w.type !== "Zaw Component")], wikiWeapons);
const { warframeMods, weaponMods, nonLinear, flawedOnly } = await importMods(mods, parseWikiMods(wikiModsLua), weapons);

// Values confirmed against the wiki's rendered pages when this script was written.
check(Object.keys(frames).length >= 100, "too few Warframes");
check(Object.keys(weapons).length >= 500, "too few weapons");
check(frames.Excalibur?.health === 370 && frames.Excalibur?.energy === 150, "Excalibur rank 30 stats");
check(warframeMods.Vitality?.effects.health === 100 && warframeMods.Vitality?.maxRank === 10, "Vitality");
check(warframeMods["Transient Fortitude"]?.effects.duration === -27.5, "Transient Fortitude");
check(weaponMods.Serration?.effects.damage === 165, "Serration");
check(weaponMods.Hellfire?.effects.heat === 90, "Hellfire picked the wrong variant");
check(weapons["Tigris Prime"]?.pellets === 8, "Tigris Prime pellets");
check(Object.keys(wikiWeapons).length >= 300, "too few wiki weapons");
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
    imported: new Date().toISOString().slice(0, 10),
    sources: ["WFCD/warframe-items (MIT)", "wiki.warframe.com data modules (rank 30 stats, magazine, reload, ammo cost, melee class and heavy attacks)"],
    note: "Warframe game data belongs to Digital Extremes. Regenerate with npm run import-data.",
  },
  warframes: frames,
  weapons,
  warframeMods,
  weaponMods,
};
writeFileSync(OUTPUT, `${JSON.stringify(data, null, 1)}\n`);

console.log(`Warframes: ${Object.keys(frames).length} (rank 30 from wiki ${counts.wiki}, base frame ${counts.baseFrame}, default rule ${counts.defaultRule})`);
console.log(`Weapons: ${Object.keys(weapons).length} (${Object.values(weapons).filter((w) => w.slot === "melee").length} melee, ${Object.values(weapons).filter((w) => w.heavyUnconfirmed).length} with unconfirmed heavy attacks)`);
console.log(`Mods: ${Object.keys(warframeMods).length} Warframe, ${Object.keys(weaponMods).length} weapon, ${nonLinear} with exact per-rank values`);
console.log(`Flawed-only mods repaired from wiki pages: ${flawedOnly.repaired.length} (${flawedOnly.repaired.join(", ")})`);
console.log(`Flawed-only mods left unverified: ${flawedOnly.unverified.length} (${flawedOnly.unverified.join(", ")})`);
