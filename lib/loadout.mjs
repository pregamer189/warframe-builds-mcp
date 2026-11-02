// The whole character at once: Warframe, subsume, weapons, companion and what changes when something is left out, plus
// variations for how far to push a stat and which ability a build is for.
import { data, find, round } from "./data.mjs";
import { allFrames, frameFits, warframeBuild } from "./frames.mjs";
import { suggestWarframeBuild, suggestWeaponBuild } from "./suggest.mjs";
import { weaponRecord } from "./weapons.mjs";

const CASTER_STATS = ["strength", "duration", "range", "efficiency"];

// Everyday words for the roles the wiki lists on subsumable abilities.
const ROLE_WORDS = {
  nuke: ["Nuking"], damage: ["Nuking", "Damage Buff"], buff: ["Damage Buff"], tank: ["Damage Reduction", "Healing", "Invulnerability", "Shield Restore"], survive: ["Damage Reduction", "Healing", "Invulnerability", "Shield Restore"],
  heal: ["Healing"], energy: ["Energy Restore"], armor: ["Armor Strip"], strip: ["Armor Strip", "Defense Strip"], control: ["Crowd Control"], cc: ["Crowd Control"], support: ["Damage Buff", "Healing", "Energy Restore"],
  stealth: ["Stealth"], loot: ["Farming"], farm: ["Farming"], speed: ["Mobility"], status: ["Status Cleanse", "Armor Strip"],
};

function subsumeOptions(name, theme, limit) {
  const baseFrame = name.replace(/ (Prime|Umbra)$/, "");
  const words = String(theme ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const roles = new Set(words.flatMap((word) => ROLE_WORDS[word] ?? ROLE_WORDS[word.replace(/s$/, "")] ?? []));
  const scored = Object.entries(data.subsumes ?? {}).filter(([, s]) => s.from !== baseFrame).map(([ability, s]) => {
    const text = `${ability} ${s.roles.join(" ")} ${s.damage.join(" ")} ${s.note ?? ""}`.toLowerCase();
    return { ability, s, score: s.roles.filter((role) => roles.has(role)).length * 3 + words.filter((word) => text.includes(word)).length };
  });
  const chosen = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.ability.localeCompare(b.ability)).slice(0, limit);
  const limited = data.subsumeRestrictions?.replaces[baseFrame];
  return {
    ...(limited && { damage_buff_slot: `${data.subsumeRestrictions.abilities.join(", ")} can only replace ${limited} on ${baseFrame}.` }),
    candidates: chosen.map(({ ability, s }) => ({ ability, from: s.from, roles: s.roles, damage: s.damage, scales_with: s.scales_with, ...(s.augments.length && { augments: s.augments }), ...(s.note && { helminth_note: s.note }) })),
    all_roles: Object.fromEntries([...new Set(Object.values(data.subsumes ?? {}).flatMap((s) => s.roles))].sort().map((role) => [role, Object.entries(data.subsumes).filter(([, s]) => s.roles.includes(role) && s.from !== baseFrame).map(([ability]) => ability)])),
  };
}

const weaponFacts = (spec) => {
  const [name, record] = weaponRecord(spec);
  return {
    name, slot: record.slot, type: record.type, trigger: record.trigger,
    attacks: record.modes.slice(0, 6).map((mode) => ({
      name: mode.name, damage: mode.damage, crit_chance_pct: mode.critChance, crit_multiplier: mode.critDamage, status_chance_pct: mode.statusChance, ...(mode.aoe && { radial: true }),
      ...(data.conditionOverload?.[name]?.[mode.name] && { condition_overload: data.conditionOverload[name][mode.name].behavior }),
    })),
  };
};

const WEAPON_WORDS = /\b(guns?|melee|weapons?|fire rate|reload|critical|multishot|status chance|combo)\b/i;

function companionFacts(companion, theme, limit) {
  const [name, record] = find(data.companions, companion, "companion");
  const words = String(theme ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  const fits = Object.entries(data.warframeMods).filter(([, mod]) => mod.slot === "companion" && !mod.pvpOnly && frameFits(mod.compat, name, record));
  const textOf = ([modName, mod]) => `${modName} ${(mod.other ?? []).join(" ")} ${Object.keys(mod.effects).join(" ")}`.toLowerCase();
  const scored = fits.map((entry) => ({ entry, score: words.filter((word) => textOf(entry).includes(word)).length, own: !["COMPANION", "ROBOTIC", "BEAST"].includes(String(entry[1].compat).trim()) }));
  const picks = scored.sort((a, b) => b.score - a.score || Number(b.own) - Number(a.own)).slice(0, limit);
  return {
    name, type: record.type, health: record.health, shields: record.shields, armor: record.armor, polarities: record.polarities,
    mods: picks.map(({ entry: [modName, mod] }) => ({ name: modName, polarity: mod.polarity, ...(Object.keys(mod.effects).length && { effects: mod.effects }), ...(mod.other?.length && { text: mod.other }) })),
    total_mods: fits.length,
  };
}

export function exploreLoadout({ warframe, weapons = [], companion, companion_weapon, theme, subsume, no_subsume = false, no_companion = false, limit = 8 }) {
  const [name, frame] = find(allFrames(), warframe, "warframe");
  if ((frame.kind ?? "warframe") !== "warframe") throw new Error(`${name} is a ${frame.kind}. explore_loadout starts from a Warframe.`);
  if (subsume && no_subsume) throw new Error("Pass subsume or no_subsume, not both.");
  if (companion && no_companion) throw new Error("Pass companion or no_companion, not both.");
  const gear = weapons.map((spec) => (typeof spec === "string" ? { weapon: spec } : spec)).map(weaponFacts);
  const infused = subsume ? warframeBuild({ warframe: name, subsume }).subsume : undefined;
  const abilities = (frame.abilityText ?? []).filter((a) => a.name !== infused?.replaces);
  const links = abilities.filter((a) => WEAPON_WORDS.test(`${a.text} ${Object.values(a.scaling ?? {}).join(" ")}`)).map((a) => ({ ability: a.name, text: a.text, ...(a.weapon && { own_weapon: a.weapon }) }));
  const options = no_subsume || subsume ? undefined : subsumeOptions(name, theme, limit);
  return {
    warframe: name,
    passive: frame.passive,
    abilities: abilities.map(({ name: abilityName, text, cost, scaling, weapon }) => ({ name: abilityName, text, cost, scaling, ...(weapon && { weapon }) })),
    abilities_that_touch_weapons: links,
    ...(infused && { subsume: infused }),
    ...(options && { subsume_options: options }),
    weapons: gear,
    ...(companion && { companion: companionFacts(companion, theme, limit) }),
    ...(companion_weapon && { companion_weapon: weaponFacts({ weapon: companion_weapon }) }),
    left_out: [
      ...(no_subsume ? [`No subsume: ${name} keeps all four abilities. Options like Nourish, Roar and armor strips stay unavailable, so say what that costs for this build.`] : []),
      ...(no_companion ? ["No companion: its mods, weapon, revive and any buff or loot it gives are gone. Check special_rules for what this build relied on it for."] : []),
    ],
    how_to_use: "Look for links between the parts: a status or damage type one part applies and another scales with, an ability that buffs a weapon type, a kill or status trigger one part needs and another causes, and a companion that strips armor or applies status. Then check each part with warframe_build and weapon_build, and pass ability buffs with a stated number through extra_effects on the weapon.",
  };
}

const scalesWith = (ability) => {
  const scaling = ability.scaling ?? {};
  return ["strength", "duration", "range"].filter((stat) => {
    const text = String(scaling[stat] ?? "");
    return stat === "duration" ? /\d\s*s\b/.test(text) : /\d/.test(text);
  });
};

const frameVariant = (label, why, args, base) => {
  const result = suggestWarframeBuild(args);
  const stats = Object.fromEntries(CASTER_STATS.map((stat) => [stat, result.build.abilities?.[stat]]));
  return {
    label, why,
    stats,
    ...(base && { compared_to_balanced: Object.fromEntries(CASTER_STATS.map((stat) => [stat, round(stats[stat] - base[stat])])) }),
    mods: result.mods.map((mod) => mod.name),
    ...(result.aura && { aura: result.aura }),
    ...(result.exilus && { exilus: result.exilus }),
    ...(result.forma_to_add && { forma_to_add: result.forma_to_add }),
    ...(result.targets_missed && { targets_missed: result.targets_missed }),
    ...(result.low_stats_note && { low_stats_note: result.low_stats_note }),
    effective_health: result.build.effective_health,
    ability_numbers: result.build.ability_numbers,
  };
};

function statTiers(shared, stat, base) {
  const others = Object.fromEntries(CASTER_STATS.filter((other) => other !== stat).map((other) => [other, 1]));
  const top = suggestWarframeBuild({ ...shared, goal: stat }).build;
  const read = (build) => (stat === "effective_health" ? build.effective_health : build.abilities?.[stat] ?? build.stats?.[stat]);
  const most = read(top);
  const start = read(warframeBuild({ warframe: shared.warframe, subsume: shared.subsume }));
  const tier = (label, share, why) => frameVariant(label, why, { ...shared, goal: others, targets: { [stat]: round(start + (most - start) * share) } }, base);
  return [
    tier(`Max ${stat}`, 1, `As much ${stat} as fits, with spare slots going to other stats.`),
    tier(`Most of it (75% of the gain)`, 0.75, `Gives up some ${stat} to win back other stats.`),
    tier(`Half of it (50% of the gain)`, 0.5, `Enough ${stat} to feel it, with the rest of the kit still working.`),
  ];
}

function abilityVariants(frame, shared, base, only) {
  const groups = new Map();
  for (const ability of frame.abilityText ?? []) {
    if (only && ability.name.toLowerCase() !== only.toLowerCase()) continue;
    const stats = scalesWith(ability);
    if (stats.length) groups.set(stats.join("+"), { stats, abilities: [...(groups.get(stats.join("+"))?.abilities ?? []), ability.name] });
  }
  return [...groups.values()].map(({ stats, abilities }) => frameVariant(
    `${abilities.join(" and ")} first`,
    `These abilities scale with ${stats.join(", ")}, so those stats lead and the rest are kept where possible.`,
    { ...shared, goal: { ...Object.fromEntries(stats.map((stat) => [stat, 2])), efficiency: 1 }, targets: Object.fromEntries(stats.map((stat) => [stat, 100])) },
    base,
  )).map((variant, index) => ({ prioritizes: [...groups.values()][index].abilities, ...variant }));
}

// Trade-offs are the point of building in Warframe, so this always shows more than one answer.
export function buildVariations(args) {
  const { warframe, weapon, stat, ability, forma = 3, ...rest } = args;
  if (Boolean(warframe) === Boolean(weapon)) throw new Error("Pass warframe or weapon.");
  if (weapon) return weaponVariations({ weapon, ...rest, forma });
  const [name, frame] = find(allFrames(), warframe, "warframe");
  if ((frame.kind ?? "warframe") !== "warframe" && !stat) throw new Error(`${name} has no abilities to prioritize, so pass stat.`);
  const shared = { ...rest, warframe: name, forma };
  const balanced = frameVariant("Balanced", "Everything raised evenly, as a baseline to compare with.", { ...shared, goal: Object.fromEntries(CASTER_STATS.map((s) => [s, 1])) });
  const base = balanced.stats;
  return {
    warframe: name,
    ...(stat ? { pushing: stat } : {}),
    ...(ability ? { ability } : {}),
    variations: stat ? [...statTiers(shared, stat, base), balanced] : [...abilityVariants(frame, shared, base, ability), balanced],
    how_to_use: "Show the player more than one of these, name which ability or stat each is for, and say what it gives up. These only count stats, so check augments, subsumes and special_rules before recommending one.",
  };
}

const WEAPON_GOALS = { burst_dps: "Highest damage while the magazine lasts", sustained_dps: "Highest damage counting reloads", status_dps: "Damage over time from status" };

function weaponVariations({ weapon, conditionals = false, ...rest }) {
  const row = (label, why, goal, on) => {
    const result = suggestWeaponBuild({ ...rest, weapon, goal, conditionals: on });
    const { build } = result;
    return {
      label, why, goal, mods: result.mods.map((mod) => mod.name),
      ...(result.forma_to_add && { forma_to_add: result.forma_to_add }),
      burst_dps: build.target?.burst_dps ?? build.burst_dps, sustained_dps: build.target?.sustained_dps ?? build.sustained_dps, status_dps: build.status.damage_over_time_dps,
      crit_chance_pct: build.crit_chance_pct, status_chance_pct: build.status_chance_pct,
    };
  };
  const [, record] = weaponRecord({ weapon });
  const melee = ["melee", "archmelee", "claws"].includes(record.slot);
  const goals = Object.entries(WEAPON_GOALS).filter(([goal]) => !(melee && goal === "sustained_dps"));
  return {
    weapon,
    variations: [
      ...goals.map(([goal, why]) => row(goal, why, goal, conditionals)),
      ...(melee && record.heavyAttack ? [row("heavy_attack", "One big heavy attack hit", "heavy_attack", conditionals)] : []),
      ...(conditionals ? [] : [row("Peak with triggers", "Counts Galvanized mods and other triggers at full stacks, so it's a best case", melee ? "burst_dps" : "sustained_dps", true)]),
    ],
    how_to_use: "Show the player more than one of these, and say which is a peak and which holds up before the triggers stack.",
  };
}

const verdictFor = (lossPct) => {
  if (lossPct < 5) return { verdict: "barely_matters", advice: "Tell the player they can skip it without worrying." };
  if (lossPct < 15) return { verdict: "noticeable", advice: "Tell the player plainly what it costs, and name the replacement." };
  return { verdict: "big_loss", advice: "Be direct: this build is much weaker without it. Say so, then offer a different build that doesn't rely on it, rather than patching this one." };
};

// What a build loses without something, with the replacement the search would pick.
export function costOfLeavingOut({ leave_out, ...args }) {
  if (!Array.isArray(leave_out) || !leave_out.length) throw new Error("leave_out must list what to go without, such as [\"Primed Point Blank\"].");
  if (Boolean(args.warframe) === Boolean(args.weapon)) throw new Error("Pass warframe or weapon.");
  const arcanesLeft = (args.arcanes ?? []).filter((arcane) => !leave_out.includes(typeof arcane === "string" ? arcane : arcane.name));
  const without = { ...args, arcanes: arcanesLeft, exclude: [...(args.exclude ?? []), ...leave_out.filter((item) => !Object.hasOwn(data.arcanes, item))] };
  const run = args.warframe ? suggestWarframeBuild : suggestWeaponBuild;
  const full = run(args);
  const less = run(without);
  const names = (result) => result.mods.map((mod) => mod.name);
  const changes = { removed: names(full).filter((mod) => !names(less).includes(mod)), added: names(less).filter((mod) => !names(full).includes(mod)) };
  let measures;
  if (args.warframe) {
    const stats = Object.keys(typeof args.goal === "object" ? args.goal : { [args.goal ?? "strength"]: 1 });
    const read = (result, stat) => (stat === "effective_health" ? result.build.effective_health : result.build.abilities?.[stat] ?? result.build.stats?.[stat]);
    measures = stats.map((stat) => ({ measure: stat, with: read(full, stat), without: read(less, stat) }));
  } else {
    const dps = (result) => {
      const source = result.build.target ?? result.build;
      if (result.goal === "status_dps") return result.build.status.damage_over_time_dps;
      if (result.goal === "heavy_attack") return result.build.heavy_attack?.average_damage_with_crits ?? 0;
      return source[result.goal] ?? 0;
    };
    measures = [{ measure: full.goal, with: dps(full), without: dps(less) }];
  }
  const rows = measures.map((row) => ({ ...row, loss_pct: row.with > 0 ? round((1 - row.without / row.with) * 100) : 0 }));
  const worst = Math.max(...rows.map((row) => row.loss_pct), 0);
  const used = leave_out.filter((item) => names(full).includes(item) || (args.arcanes ?? []).some((arcane) => (typeof arcane === "string" ? arcane : arcane.name) === item));
  return {
    leave_out,
    ...(used.length < leave_out.length && { not_in_the_best_build: leave_out.filter((item) => !used.includes(item)) }),
    results: rows,
    ...(changes.removed.length || changes.added.length ? { mod_changes: changes } : {}),
    ...verdictFor(worst),
    with_it: { mods: names(full), ...(full.forma_to_add && { forma_to_add: full.forma_to_add }) },
    without_it: { mods: names(less), ...(less.forma_to_add && { forma_to_add: less.forma_to_add }), ...(less.targets_missed && { targets_missed: less.targets_missed }) },
    limit: "This only compares what the calculator can model, so a mod valued for an augment, a special rule or a trigger can matter more than this shows. Use market_price to compare what each costs.",
  };
}
