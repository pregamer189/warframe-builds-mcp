// Weapon, Zaw and Kitgun builds: damage by type, crit, status, DPS, melee heavy attacks and stance combos.
import { DATA_VERSION, data, find, normalize, round } from "./data.mjs";
import {
  arcanesNotCalculated, buildLevel, capacityReport, checkNumbers, conditionalEffects, notCalculated, resolveArcanes, resolveMods, slotPolarity, totalEffects,
} from "./mods.mjs";
import { resolveTarget, targetDamage, targetSummary } from "./target.mjs";

const COMPOSITES = {
  "cold+heat": "blast", "electricity+toxin": "corrosive", "heat+toxin": "gas",
  "cold+electricity": "magnetic", "electricity+heat": "radiation", "cold+toxin": "viral",
};
const ELEMENTS = ["heat", "cold", "electricity", "toxin"];
const PHYSICAL = ["impact", "puncture", "slash"];
const COMBINED = Object.values(COMPOSITES);
const DOT_COEFFICIENT = { slash: 0.35, heat: 0.5, toxin: 0.5, electricity: 0.5, gas: 0.5 };
const DOT_TICKS = 6;
const MELEE_SLOTS = new Set(["melee", "archmelee", "claws"]);
const GENERAL_COMPAT = new Set(["PRIMARY", "Rifle", "Shotgun", "Pistol", "Archgun", "Archmelee", "Unique", "Rifle (No Aoe)", "Pistol (No Aoe)"]);
const KNOWN_EFFECTS = new Set([
  "damage", "multishot", "critChance", "critDamage", "fireRate", "fireRateBow", "statusChance", "statusDamage", "magazine", "reload",
  "comboCritChance", "comboStatusChance", "damagePerStatus", "heavyCritChance", "heavyDamage", "meleeRange", "initialCombo",
  "impact", "puncture", "slash", "heat", "cold", "electricity", "toxin", "blast", "corrosive", "gas", "magnetic", "radiation", "viral",
]);
const BASE_STATS = new Set(["damage", "critChance", "critDamage", "statusChance", "fireRate", "pellets", "magazine", "reload", "ammoCost", "heavyAttack", "range", "windUp"]);
const isEffect = (key) => KNOWN_EFFECTS.has(key) || key.startsWith("faction:");
const EFFECT_NAMES = [...KNOWN_EFFECTS, "faction:Grineer (or another faction)"];

// "Torid Incarnon" means the Torid's Incarnon Form, as the game has no separate weapon by that name.
export function withIncarnonForm(args) {
  const match = typeof args.weapon === "string" && args.weapon.match(/^(.+?)\s+incarnon(?:\s+form)?$/i);
  if (!match || Object.hasOwn(data.weapons, args.weapon)) return args;
  return { ...args, weapon: match[1], attack: args.attack ?? "Incarnon Form" };
}

export const DAMAGE_EFFECTS = [
  "damage", "multishot", "critChance", "critDamage", "fireRate", "fireRateBow", "comboCritChance", ...PHYSICAL, ...ELEMENTS, ...COMBINED,
];

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

let meleeClasses;
export function meleeFits(compat, name, weapon) {
  if (compat === "Melee" || weapon.type === "Melee") return true; // "Melee" as a type means the class is unknown
  if (compat === "Thrown Melee") return weapon.modes.some((m) => /throw/i.test(m.name));
  meleeClasses ??= new Set(Object.values(data.weapons).filter((w) => w.slot === "melee").map((w) => weaponClass(w.type)));
  // A class must match exactly, as "Swords" must not fit Dual Heat Swords. Anything else names a weapon.
  if (meleeClasses.has(weaponClass(compat))) return weaponClass(compat) === weaponClass(weapon.type);
  return name.toLowerCase().includes(compat.toLowerCase());
}

export function weaponCompatibility(m, name, weapon) {
  if (m.mod.slot !== weapon.slot && !(m.mod.stance && MELEE_SLOTS.has(weapon.slot))) {
    return `${m.name} is a ${m.mod.slot} mod, but ${name} takes ${weapon.slot} mods.`;
  }
  const tags = weapon.tags ?? [];
  if (m.mod.blockedTags?.some((tag) => tags.includes(tag))) return `${m.name} cannot be used on ${name}.`;
  const needs = m.mod.requiredTags;
  if (needs?.includes("SEMI_AUTO")) {
    if (!tags.includes("SEMI_AUTO") && !/(^|\/ )Semi/.test(weapon.trigger ?? "")) return `${m.name} only fits Semi-Auto weapons.`;
  } else if (needs && weapon.tags && !needs.some((tag) => tags.includes(tag))) {
    return `${m.name} only fits weapons tagged ${needs.join(" or ")}.`;
  }
  const compat = m.mod.compat;
  if (weapon.slot === "claws") return undefined;
  if (weapon.slot === "melee") return meleeFits(compat, name, weapon) ? undefined : `${m.name} only fits ${compat}.`;
  if (GENERAL_COMPAT.has(compat)) return undefined;
  const byType = { "Assault Rifle": ["Rifle"], Sniper: ["Sniper", "Sniper Rifle"], Bow: ["Bow"], Thrown: ["Throwing"] };
  const tome = compat === "Tome" && /Grimoire/.test(name);
  const fits = tome || (byType[compat] ? byType[compat].includes(weapon.type) : name.toLowerCase().includes(compat.toLowerCase()));
  return fits ? undefined : `${m.name} only fits ${compat}.`;
}

function zawRecord({ strike, grip, link }) {
  const { zaw } = data.modular;
  const [strikeName, s] = find(zaw.strikes, strike, "Zaw strike");
  const [gripName, g] = find(zaw.grips, grip, "Zaw grip");
  const [linkName, l] = find(zaw.links, link, "Zaw link");
  const baseTotal = Object.values(s.damage).reduce((sum, v) => sum + v, 0);
  const factor = g.hands === "TwoHanded" ? s.twoHandedFactor : 1;
  const total = (baseTotal + g.damage + l.damage) * factor;
  const type = s.types[g.hands];
  const multiplier = data.heavyMultipliers[type];
  return [`${strikeName} ${gripName} ${linkName}`, {
    type,
    slot: "melee",
    pellets: 1,
    magazine: 0,
    reload: 0,
    polarities: [],
    zaw: true,
    ...(multiplier && { heavyAttack: round(total * multiplier) }),
    modes: [{
      name: "Normal Attack",
      damage: Object.fromEntries(Object.entries(s.damage).map(([k, v]) => [k.toLowerCase(), round((v / baseTotal) * total)])),
      critChance: round((s.critChance + l.critChance) * 100),
      critDamage: s.critDamage,
      statusChance: round((s.statusChance + l.statusChance) * 100),
      fireRate: round(s.speed + g.speed + l.speed),
      ammoCost: 1,
    }],
  }];
}

function kitgunRecord({ chamber, grip, loader }) {
  const { primary, secondary } = data.modular.kitgun;
  const lowerGrip = String(grip).toLowerCase();
  const isPrimary = primary.grips.some((g) => g.toLowerCase() === lowerGrip);
  const parts = isPrimary ? primary : secondary;
  if (!isPrimary && !secondary.grips.some((g) => g.toLowerCase() === lowerGrip)) {
    throw new Error(`Unknown Kitgun grip: ${grip}. Secondary: ${secondary.grips.join(", ")}. Primary: ${primary.grips.join(", ")}.`);
  }
  const gripName = parts.grips.find((g) => g.toLowerCase() === lowerGrip);
  const [chamberName, c] = find(parts.chambers, chamber, "Kitgun chamber");
  const [loaderName, l] = find(parts.loaders, loader, "Kitgun loader");
  const damage = c.damage[gripName] ?? c.damage.Base;
  return [`${chamberName} ${gripName} ${loaderName}`, {
    type: "Kitgun",
    chamber: chamberName,
    grip: gripName,
    slot: isPrimary ? "primary" : "secondary",
    pellets: c.multishot,
    magazine: typeof c.magazine === "object" ? c.magazine[l.magazine] : c.magazine,
    reload: l.reload,
    polarities: [],
    trigger: c.trigger,
    tags: [...new Set([...c.tags, "MODULAR_GUN"])],
    modes: [{
      name: "Normal Attack",
      damage: Object.fromEntries(Object.entries(damage).map(([k, v]) => [k.toLowerCase(), v])),
      critChance: round((c.critChance + l.critChance) * 100),
      critDamage: round(c.critDamage + l.critDamage),
      statusChance: round((c.statusChance + l.statusChance) * 100),
      fireRate: typeof c.fireRate === "object" ? c.fireRate[gripName] : c.fireRate,
      ammoCost: c.ammoCost,
    }],
  }];
}

export function weaponRecord({ weapon, zaw, kitgun }) {
  if ([weapon, zaw, kitgun].filter(Boolean).length !== 1) throw new Error("Pass exactly one of weapon, zaw or kitgun.");
  if (zaw) return zawRecord(zaw);
  if (kitgun) return kitgunRecord(kitgun);
  return find(data.weapons, weapon, "weapon");
}

// A Riven is a mod with the stats the player rolled, and it fills a regular slot.
function rivenMod(riven) {
  if (!riven.effects || typeof riven.effects !== "object") throw new Error("riven needs effects, such as {critChance: 120, multishot: 90, zoom: -40}.");
  checkNumbers(riven.effects, "Riven effect", isEffect, EFFECT_NAMES);
  const drain = riven.drain ?? 18;
  if (typeof drain !== "number" || drain < 0) throw new Error("riven.drain must be 0 or more.");
  return {
    name: "Riven",
    rank: 8,
    effects: riven.effects,
    conditional: [],
    drain,
    slot: slotPolarity(riven.slot_polarity),
    mod: { polarity: slotPolarity(riven.polarity), slot: "riven", effects: riven.effects },
  };
}

// Tick damage from the wiki: (modded base damage x faction + 1) x coefficient x the literal element's mods x status
// damage x faction, so faction mods count twice.
function statusReport({ byType, perPellet, baseDamage, shots, statusChance, rate, avgCrit, sum, target, factionMult }) {
  const procsPerSecond = shots * (statusChance / 100) * rate;
  const report = { procs_per_second: round(procsPerSecond), by_type: {} };
  let dps = 0;
  for (const [type, value] of Object.entries(byType)) {
    const share = perPellet > 0 ? value / perPellet : 0;
    const entry = { share_of_procs_pct: round(share * 100) };
    if (DOT_COEFFICIENT[type]) {
      const elementBonus = type === "slash" ? 1 : Math.max(1 + sum(type), 0);
      let tick = (baseDamage * factionMult + 1) * DOT_COEFFICIENT[type] * elementBonus * Math.max(1 + sum("statusDamage"), 0) * factionMult;
      if (target) tick *= (target.multipliers[type] ?? 1) * (type === "slash" ? 1 : 1 - target.reduction);
      const typeDps = procsPerSecond * share * tick * DOT_TICKS * avgCrit;
      entry.tick_damage = round(tick);
      entry.dps = round(typeDps);
      dps += typeDps;
    }
    report.by_type[type] = entry;
  }
  report.damage_over_time_dps = round(dps);
  return report;
}

// Condition Overload-style bonuses behave differently per attack, as the wiki's catalog measures. Multiplying attacks treat
// them as a separate multiplier, others add them to +damage mods, and a gun's radial damage doesn't get them unless measured.
const CONDITION_OVERLOAD_NOTE = "How Condition Overload-style bonuses, such as Galvanized mods, apply to this attack, from the wiki's community measurements. Much of it is likely unintended, but it has lasted for years.";
function conditionOverloadFor(weapon, record, mode, baseTotal) {
  const kitgun = record.type === "Kitgun" && data.conditionOverloadKitguns?.[record.chamber]?.[record.slot];
  if (kitgun) {
    return {
      ...kitgun,
      ratio: kitgun.fixedBonus && baseTotal > 0 ? kitgun.fixedBonus / baseTotal : kitgun.ratio,
      measured: true,
      ...(kitgun.grip && kitgun.grip !== record.grip && { source: `Measured with the ${kitgun.grip} grip, and assumed the same for others.` }),
    };
  }
  const measured = data.conditionOverload?.[weapon]?.[mode.name];
  if (measured) return { ...measured, measured: true };
  const radial = /\b(explosion|radial|aoe)\b/i.test(mode.name) || (mode.aoe && !MELEE_SLOTS.has(record.slot));
  return radial ? { behavior: "none", ratio: 0 } : { behavior: "adding", ratio: 1 };
}

// Rockets and grenades hit and then explode, as attacks listed one after the other, and totals include both. These
// names always fire with the main attack. Weak point, embedded and reload variants are alternatives, and clouds linger.
const LINKED_NAME = /Explosion|Detonation|Radial|AoE|Blast|Collapse|Appendages/i;
const ALTERNATIVE_NAME = /Headshot|Embed|Reload|Cloud|Field/i;

function linkedAttacks(record, mode, melee) {
  if (melee || mode.aoe) return [];
  const linked = [];
  for (const next of record.modes.slice(record.modes.indexOf(mode) + 1)) {
    if (!next.aoe || Math.abs(next.fireRate - mode.fireRate) > 0.01) break;
    if (/Uncharged/.test(next.name) && !/Uncharged/.test(mode.name)) break;
    if (LINKED_NAME.test(next.name) && !ALTERNATIVE_NAME.test(next.name)) linked.push(next);
  }
  return linked;
}

export function weaponBuild(rawArgs) {
  const build = linkedBuild(withIncarnonForm(rawArgs));
  return { warnings: build.mod_capacity.warnings, ...build };
}

// A rough figure: it only counts health, and leaves out shields, weak points, overkill and armor stripped along the way.
const secondsToKill = (health, dps) => (health && dps > 0 ? { rough_seconds_to_empty_health: round(health / dps) } : {});

function linkedBuild(args) {
  const build = singleAttackBuild(args);
  const [, record] = weaponRecord(args);
  const mode = record.modes.find((m) => m.name === build.attack);
  const attacks = linkedAttacks(record, mode, MELEE_SLOTS.has(record.slot));
  if (!attacks.length || args.base_stats?.damage) return build;
  const linked = attacks.map((next) => singleAttackBuild({ ...args, attack: next.name }));
  const total = (read) => linked.reduce((sum, item) => sum + read(item), 0);
  // They come from one shot, so reloads take up the same share of time as they do for the main attack.
  const uptime = build.burst_dps > 0 ? build.sustained_dps / build.burst_dps : 1;
  return {
    ...build,
    burst_dps: round(build.burst_dps + total((item) => item.burst_dps)),
    sustained_dps: round(build.sustained_dps + total((item) => item.burst_dps) * uptime),
    status: {
      ...build.status,
      procs_per_second: round(build.status.procs_per_second + total((item) => item.status.procs_per_second)),
      damage_over_time_dps: round(build.status.damage_over_time_dps + total((item) => item.status.damage_over_time_dps)),
    },
    linked_attacks: linked.map((item) => ({
      attack: item.attack, damage_per_shot: item.damage_per_shot, damage_by_type: item.damage_by_type, burst_dps: item.burst_dps, status: item.status.by_type,
    })),
    ...(build.target && {
      target: {
        ...build.target,
        burst_dps: round(build.target.burst_dps + total((item) => item.target.burst_dps)),
        sustained_dps: round(build.target.sustained_dps + total((item) => item.target.burst_dps) * uptime),
        linked_damage_per_shot: round(total((item) => item.target.damage_per_shot)),
        ...secondsToKill(build.target.health, build.target.sustained_dps + total((item) => item.target.burst_dps) * uptime),
      },
    }),
    assumptions: `${build.assumptions} burst_dps, sustained_dps and the status totals include the attacks in linked_attacks, which fire with the main one.`,
  };
}

function singleAttackBuild(args) {
  const {
    mods = [], riven, exilus, stance, arcanes = [], combo_multiplier, attack, catalyst = true,
    extra_effects = {}, conditionals = false, status_types_on_target = 0, level,
  } = args;
  let { base_stats } = args;
  checkNumbers(extra_effects, "extra effect", isEffect, EFFECT_NAMES);
  if (base_stats) {
    const { damage, ...plain } = base_stats;
    checkNumbers(plain, "base stat", (key) => BASE_STATS.has(key));
    if (damage !== undefined) {
      if (!damage || typeof damage !== "object") throw new Error("base_stats.damage must map damage types to numbers.");
      checkNumbers(damage, "damage value");
      base_stats = { ...plain, damage: Object.fromEntries(Object.entries(damage).map(([type, value]) => [type.toLowerCase(), value])) };
    }
  }
  const [name, record] = weaponRecord(args);
  const wantedAttack = normalize(attack ?? "");
  const closeAttacks = record.modes.filter((m) => normalize(m.name).includes(wantedAttack));
  const mode = attack
    ? record.modes.find((m) => normalize(m.name) === wantedAttack) ?? (closeAttacks.length === 1 ? closeAttacks[0] : undefined)
    : record.modes[0];
  if (!mode) throw new Error(`${name} has no attack "${attack}". Modes: ${record.modes.map((m) => m.name).join(", ")}`);
  const melee = MELEE_SLOTS.has(record.slot);
  if (!melee && (stance || combo_multiplier !== undefined)) throw new Error(`${name} is not melee: stance and combo_multiplier only apply to melee weapons.`);
  const combo = combo_multiplier ?? 1;
  if (typeof combo !== "number" || combo < 1 || combo > 12) throw new Error("combo_multiplier must be 1-12.");
  if (typeof status_types_on_target !== "number" || status_types_on_target < 0) throw new Error("status_types_on_target must be 0 or more.");
  const target = resolveTarget(args.target);
  const capacityLevel = buildLevel(level, record.maxRank);
  const stats = {
    ...mode, pellets: mode.pellets ?? record.pellets, magazine: record.magazine, reload: record.reload,
    heavyAttack: record.heavyAttack, range: record.range, windUp: record.windUp, ...base_stats,
  };

  // A mod the game wouldn't let on doesn't count towards anything, so results can't be inflated by one.
  const listed = resolveMods(mods, data.weaponMods);
  const ignored = listed.map((m) => ({ mod: m.name, reason: weaponCompatibility(m, name, record) })).filter((entry) => entry.reason);
  const regular = listed.filter((m) => !ignored.some((entry) => entry.mod === m.name));
  if (riven) regular.push(rivenMod(riven));
  if (regular.length > 8) throw new Error("A weapon has 8 regular mod slots, and a Riven fills one.");
  for (const m of regular) if (m.mod.stance) throw new Error(`${m.name} is a stance: pass it as "stance".`);
  let stanceMod;
  if (stance) {
    [stanceMod] = resolveMods([stance], data.weaponMods);
    if (!stanceMod.mod.stance) throw new Error(`${stanceMod.name} is not a stance mod.`);
    stanceMod.slot ??= record.stancePolarity; // the weapon's own stance slot, unless told otherwise
  }
  const exilusMod = exilus ? resolveMods([exilus], data.weaponMods)[0] : undefined;
  if (exilusMod) exilusMod.slot ??= record.exilusPolarity; // the weapon's own Exilus slot, unless told otherwise
  const equipped = exilusMod ? [...regular, exilusMod] : regular;
  const arcaneList = resolveArcanes(arcanes, data.arcanes, "weapon");
  // Zaws and Kitguns have a slot for their own arcanes, and Archguns take a primary and a secondary one.
  const maxArcanes = record.zaw || record.type === "Kitgun" || record.slot === "archgun" ? 2 : 1;
  if (arcaneList.length > maxArcanes) throw new Error(`${name} has ${maxArcanes} arcane slot${maxArcanes > 1 ? "s" : ""}.`);
  if (new Set(arcaneList.map((a) => a.arcane.type)).size < arcaneList.length) throw new Error("Each arcane slot takes a different type of arcane.");
  // Some arcanes only buff one kind of weapon, such as "to Melee Weapons".
  const appliesTo = (text) => {
    if (!text) return true;
    const wanted = text.replace(/\(.*\)/, "");
    const primaryFits = record.slot === "primary" || record.slot === "archgun" || (record.slot === "shotgun" && !/Excludes Shotguns/.test(text));
    return (/Melee/.test(wanted) && melee)
      || (/Primary/.test(wanted) && primaryFits)
      || (/Shotgun/.test(wanted) && record.slot === "shotgun")
      || (/Secondary|Pistol/.test(wanted) && (record.slot === "secondary" || record.slot === "archgun"))
      || (/Sniper/.test(wanted) && /Sniper/.test(record.type))
      || (/Bow/.test(wanted) && record.type === "Bow")
      || (/^(?!.*Sniper).*Rifle/.test(wanted) && record.type === "Rifle")
      || /^Weapons?$/.test(wanted.trim());
  };
  const arcaneFits = (a) => !record.companionWeapon && {
    primary: ["primary", "shotgun", "archgun"].includes(record.slot),
    shotgun: record.slot === "shotgun",
    bow: record.type === "Bow",
    secondary: ["secondary", "archgun"].includes(record.slot),
    melee: record.slot === "melee",
    zaw: Boolean(record.zaw),
    kitgun: record.type === "Kitgun",
    warframe: a.arcane.weaponConditional?.some((c) => appliesTo(c.appliesTo)) ?? false,
  }[a.arcane.type];
  // An arcane that doesn't apply adds nothing, and a warning says why.
  const usable = arcaneList.filter(arcaneFits).map((a) => ({ ...a, conditional: a.conditional.filter((c) => appliesTo(c.appliesTo)) }));
  const triggered = conditionalEffects([...equipped, ...usable], conditionals);
  const outside = [...usable, ...triggered, { effects: extra_effects }];
  const sources = [...equipped, ...outside];
  const totals = totalEffects(sources);
  const sum = (stat) => (totals[stat] ?? 0) / 100;

  // Elemental and physical bonuses scale from base damage after +damage mods.
  const baseTotal = Object.values(stats.damage).reduce((total, v) => total + v, 0);
  const conditionOverload = conditionOverloadFor(name, record, mode, baseTotal);
  const perStatusBonus = sum("damagePerStatus") * status_types_on_target * conditionOverload.ratio;
  // A stance combo can keep only part of the bonus, so the share is separate.
  const damageMultWith = (share) => (conditionOverload.behavior === "multiplying"
    ? Math.max(1 + sum("damage"), 0) * (1 + perStatusBonus * share)
    : Math.max(1 + sum("damage") + perStatusBonus * share, 0));
  const damageMult = damageMultWith(1);
  const moddedTotal = baseTotal * damageMult;
  const byType = {};
  for (const type of PHYSICAL) {
    const base = stats.damage[type] ?? 0;
    if (base) byType[type] = base * damageMult * Math.max(1 + sum(type), 0);
  }
  const singles = [
    ...equipped.flatMap((m) => Object.keys(m.effects).filter((e) => ELEMENTS.includes(e))
      .map((element) => ({ element, value: (moddedTotal * m.effects[element]) / 100 }))),
    // Elements from arcanes and buffs come after mods.
    ...outside.flatMap(({ effects }) => Object.keys(effects).filter((e) => ELEMENTS.includes(e))
      .map((element) => ({ element, value: (moddedTotal * effects[element]) / 100 }))),
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
  const multishotLocked = equipped.some((m) => m.mod.multishotLocked);
  const shots = stats.pellets * (1 + (multishotLocked ? 0 : sum("multishot")));
  // Blood Rush and Weeping Wounds add their bonus once per combo multiplier above 1x.
  const comboCrit = sum("comboCritChance") * (combo - 1);
  const critChance = (stats.critChance / 100) * Math.max(1 + sum("critChance") + comboCrit, 0);
  const critDamage = stats.critDamage * Math.max(1 + sum("critDamage"), 0);
  // Cannonade mods fix the rate of fire.
  const fireLocked = equipped.some((m) => m.mod.fireRateLocked);
  // Bows use a mod's own bow value where it has one, such as Speed Trigger's doubled rate.
  const bowBonus = sources.reduce((total, { effects }) => total + (effects.fireRateBow ?? effects.fireRate ?? 0), 0) / 100;
  const fireBonus = fireLocked ? 0 : record.type === "Bow" ? bowBonus : sum("fireRate");
  const fireRate = stats.fireRate * Math.max(1 + fireBonus, 0.01);
  const magazine = Math.round(stats.magazine * Math.max(1 + sum("magazine"), 0));
  const reload = stats.reload / Math.max(1 + sum("reload"), 0.01);
  const avgCrit = 1 + critChance * (critDamage - 1);
  const burst = perPellet * shots * avgCrit * fireRate;
  const ammoCost = stats.ammoCost ?? 1;
  const attacksPerMagazine = ammoCost > 0 ? magazine / ammoCost : 0;
  const firingTime = fireRate > 0 ? attacksPerMagazine / fireRate : 0;
  // Attacks that use no ammo and weapons with no magazine, such as Grimoire, never stop to reload.
  const uptime = firingTime > 0 ? firingTime / (firingTime + reload) : 1;
  const sustained = burst * uptime;
  const statusChance = stats.statusChance * Math.max(1 + sum("statusChance") + sum("comboStatusChance") * (combo - 1), 0);

  const factionMult = target?.group ? Math.max(1 + sum(`faction:${target.group}`), 0) : 1;
  const onTarget = target ? targetDamage(byType, target) : byType;
  const perPelletOnTarget = Object.values(onTarget).reduce((total, v) => total + v, 0) * factionMult;
  const targetRatio = perPellet > 0 ? perPelletOnTarget / perPellet : 1;
  const status = statusReport({
    byType, perPellet, baseDamage: baseTotal * damageMult, shots, statusChance, rate: fireRate, avgCrit, sum, target, factionMult,
  });

  // The wiki's measured share of the bonus for a stance's combos. Untested ones are assumed to keep all of it.
  const stanceShare = (input) => (stanceMod && data.conditionOverloadStances?.[stanceMod.name]?.[input]) ?? 1;

  const heavy = () => {
    // The class's heavy attack multiplier is stored as damage, and the combo multiplies it directly.
    const heavyMult = stats.heavyAttack / baseTotal;
    // Killing Blow's bonus only applies here, and adds to the other +damage mods.
    const heavyBonus = damageMult > 0 ? (damageMultWith(stanceShare("Heavy Attack")) + sum("heavyDamage")) / damageMult : 1;
    const damage = perPellet * heavyMult * heavyBonus * combo;
    const heavyCrit = (stats.critChance / 100) * Math.max(1 + sum("critChance") + sum("heavyCritChance") + comboCrit, 0);
    const average = damage * (1 + heavyCrit * (critDamage - 1));
    return {
      damage: round(damage),
      crit_chance_pct: round(heavyCrit * 100),
      average_damage_with_crits: round(average),
      ...(target && { average_damage_on_target: round(average * targetRatio) }),
      wind_up_seconds: stats.windUp,
      ...(record.heavyUnconfirmed && !base_stats?.heavyAttack && { unconfirmed: `The ${record.heavyUnconfirmed}, so treat this as approximate.` }),
    };
  };

  // The wiki's melee formula: a combo's total multiplier x average hit x attack speed / combo length.
  const stanceReport = () => {
    const stanceData = stanceMod && data.stances[stanceMod.name];
    if (!stanceData) return undefined;
    const combos = stanceData.combos.map((combo_) => {
      const share = perStatusBonus ? stanceShare(combo_.input) : 1;
      const keeps = damageMult > 0 ? damageMultWith(share) / damageMult : 1;
      const dps = perPellet * keeps * avgCrit * combo_.multiplier * (fireRate / combo_.duration);
      return {
        input: combo_.input, name: combo_.name, hits: combo_.hits, damage_multiplier: combo_.multiplier, seconds: combo_.duration,
        ...(share !== 1 && { condition_overload_share_pct: round(share * 100) }),
        dps: round(dps), ...(target && { dps_on_target: round(dps * targetRatio) }),
      };
    });
    const best = combos.reduce((top, c) => (c.dps > top.dps ? c : top), combos[0]);
    return { stance: stanceMod.name, best_combo: best.name, best_combo_dps: best.dps, ...(target && { best_combo_dps_on_target: best.dps_on_target }), combos };
  };

  const capacity = capacityReport(equipped, { reactor: catalyst, aura: stanceMod, level: capacityLevel });
  for (const { reason } of ignored) capacity.warnings.push(`${reason} It is left out of these numbers.`);
  for (const m of stanceMod ? [...equipped, stanceMod] : equipped) {
    if (m.name === "Riven") continue;
    const warning = weaponCompatibility(m, name, record);
    if (warning) capacity.warnings.push(warning);
  }
  if (exilusMod && !exilusMod.mod.exilus) capacity.warnings.push(`${exilusMod.name} is not an Exilus mod.`);
  for (const a of arcaneList) {
    if (!arcaneFits(a)) capacity.warnings.push(`${a.name} is a ${a.arcane.type} arcane and does not apply to ${name}.`);
  }

  const assumptions = [melee
    ? "One attack mode only. Attack DPS counts attack speed as hits per second, and stance_combos gives the more exact per-combo figure. Heavy attacks exclude Bleed, and Glaive-style heavy explosions are not modeled."
    : "One attack mode only."];
  if (/incarnon/i.test(mode.name)) assumptions.push("Incarnon Forms have their own ammo and evolution perks, which the sources don't give, so use burst_dps and treat sustained_dps and magazine as unreliable.");
  if (record.exalted) assumptions.push("Exalted weapons scale with Ability Strength and their ability's own rules, which aren't included, so check the ability's text. Add known bonuses through extra_effects or base_stats.");
  assumptions.push(target
    ? "Target results apply armor and faction multipliers. They exclude shields, weak points, and armor stripped by Corrosive or Heat status, unless you pass armor_strip."
    : "Before enemy armor and faction damage. Pass target to include them.");
  assumptions.push(conditionals ? "Every triggered effect counts at full stacks, so this is a peak figure." : "Triggered effects are left out and listed in not_calculated. Set conditionals to true for the peak figure.");
  assumptions.push("Damage-over-time figures assume every proc runs its full 6 ticks, with no status duration mods or forced procs.");
  if (/^(Kuva|Tenet) /.test(name)) assumptions.push("Its Progenitor bonus element isn't included. Add it approximately through extra_effects, such as {toxin: 60}.");

  return {
    weapon: name,
    type: record.type,
    ...(capacityLevel !== 30 && { level: capacityLevel }),
    attack: mode.name,
    other_attacks: record.modes.filter((m) => m !== mode).map((m) => m.name),
    damage_per_shot: round(perPellet),
    damage_by_type: Object.fromEntries(Object.entries(byType).map(([type, v]) => [type, round(v)])),
    pellets_or_multishot: round(shots),
    damage_per_trigger: round(perPellet * shots),
    crit_chance_pct: round(critChance * 100),
    crit_multiplier: round(critDamage),
    average_crit_multiplier: round(avgCrit),
    status_chance_pct: round(statusChance),
    status,
    ...((conditionOverload.measured || sum("damagePerStatus")) && {
      condition_overload: {
        behavior: conditionOverload.behavior,
        share_of_listed_bonus_pct: round(conditionOverload.ratio * 100),
        ...(conditionOverload.measured ? {} : { source: conditionOverload.behavior === "none" ? "Radial damage doesn't get this bonus." : "Not listed as unusual, so assumed to work as written." }),
        ...(conditionOverload.source && { source: conditionOverload.source }),
        ...(conditionOverload.note && { measurement_note: conditionOverload.note }),
        ...(conditionOverload.listedDamage && { wiki_listed_damage: conditionOverload.listedDamage, wiki_listed_damage_note: `The wiki lists this attack at ${conditionOverload.listedDamage} damage, more than the data these numbers use, so the real hit may be bigger.` }),
        note: CONDITION_OVERLOAD_NOTE,
      },
    }),
    ...(melee
      ? {
        combo_multiplier: combo,
        attack_speed: round(fireRate),
        range_m: stats.range === undefined ? null : round(stats.range + sum("meleeRange") * 100),
        initial_combo: round(sum("initialCombo") * 100),
        heavy_attack: stats.heavyAttack ? heavy() : null,
        ...(stanceMod && { stance_combos: stanceReport() ?? null }),
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
    ...(target && {
      target: {
        ...targetSummary(target),
        ...(target.group && sum(`faction:${target.group}`) ? { faction_mod_multiplier: round(factionMult) } : {}),
        damage_by_type: Object.fromEntries(Object.entries(onTarget).map(([type, v]) => [type, round(v * factionMult)])),
        damage_per_shot: round(perPelletOnTarget),
        burst_dps: round(burst * targetRatio),
        ...(!melee && { sustained_dps: round(sustained * targetRatio) }),
        ...secondsToKill(target.health, melee ? burst * targetRatio : sustained * targetRatio),
      },
    }),
    ...(triggered.length && { conditionals_applied: triggered.map((c) => `${c.source}: ${c.text}`) }),
    ...(ignored.length && { ignored_mods: ignored }),
    mod_capacity: capacity,
    not_calculated: [
      ...notCalculated(regular.concat(exilusMod ?? []), { conditionalsOn: conditionals }),
      ...arcanesNotCalculated(arcaneList, conditionals),
    ],
    assumptions: assumptions.join(" "),
    data: DATA_VERSION,
  };
}
