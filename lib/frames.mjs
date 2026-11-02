// Builds for Warframes, companions, Archwings and Necramechs: final stats, ability stats and mod capacity.
import { DATA_VERSION, data, find, round } from "./data.mjs";
import { arcanesNotCalculated, buildLevel, capacityReport, checkNumbers, conditionalEffects, notCalculated, resolveArcanes, resolveMods, totalEffects } from "./mods.mjs";

// From the wiki's Archon Shard page: flat stats apply after all other bonuses, and Tauforged shards give 50% more.
const SHARDS = {
  strength: { percent: 10 }, duration: { percent: 10 },
  health: { flat: 150 }, shields: { flat: 150 }, armor: { flat: 150 }, energy: { flat: 50 },
};

const EFFECTS = new Set(["health", "shields", "armor", "energy", "strength", "duration", "range", "efficiency"]);
const FLAT_ONLY = ["health", "shields", "armor", "energy"];

const ROBOTIC = /Sentinel|Moa|Hound/i;
const BEAST = /Kavat|Kubrow|Predasite|Vulpaphyla|Charger/i;

export const allFrames = () => ({ ...data.warframes, ...data.companions, ...data.archwings, ...data.necramechs });

// Multiplies an ability's listed values by the build's stats. Values that shrink with duration, such as decay rates, and
// lines that aren't a plain number stay as listed rather than being guessed at.
function abilityNumbers(abilities, unreliable, stats) {
  let unreliableNow = false;
  const scaled = (text, stat) => String(text ?? "").split(";").map((line) => line.trim()).filter(Boolean).map((line) => {
    // A proper thousands comma only: the sources garble some rank lists into "1,1,1,1,500".
    const match = line.match(/^\+?\s*(\d{1,3}(?:,\d{3})+|\d*\.?\d+)\s*(%|m|s|\/s|x)?\s*(?:\((.+)\))?$/);
    if (!match || unreliableNow || (stat === "duration" && /decay|rate|interval/i.test(match[3] ?? ""))) return { listed: line };
    const value = Number(match[1].replaceAll(",", ""));
    return { ...(match[3] && { label: match[3] }), listed: line, at_build: `${round((value * stats[stat]) / 100)}${(match[2] ?? "").replace("/s", " /s").replace(/^(m|s|x)$/, " $1")}` };
  });
  return abilities.filter((a) => a.scaling).map((a) => (unreliableNow = a.name === unreliable, {
    ability: a.name,
    ...(a.cost != null && { energy_cost: round(a.cost * stats.cost) }),
    strength: scaled(a.scaling.strength, "strength"),
    duration: scaled(a.scaling.duration, "duration"),
    range: scaled(a.scaling.range, "range"),
    ...(a.scaling.misc && { fixed: a.scaling.misc }),
  }));
}

// An ability infused through the Helminth, in place of one of the Warframe's own. A few damage buffs can only replace a
// matching buff on Warframes that already have one.
export function resolveSubsume({ ability, replaces }, name, frame) {
  const [abilityName, source] = find(data.subsumes ?? {}, ability, "subsumable ability");
  if ((frame.kind ?? "warframe") !== "warframe") throw new Error(`Only Warframes can subsume abilities, and ${name} is a ${frame.kind}.`);
  const own = frame.abilities ?? [];
  const slot = own.find((entry) => entry.toLowerCase() === String(replaces).toLowerCase());
  if (!slot) throw new Error(`subsume.replaces must be one of ${name}'s abilities: ${own.join(", ")}.`);
  const baseFrame = name.replace(/ (Prime|Umbra)$/, "");
  const limited = data.subsumeRestrictions?.replaces[baseFrame];
  if (limited && data.subsumeRestrictions.abilities.includes(abilityName) && limited !== slot) throw new Error(`${abilityName} can only replace ${limited} on ${baseFrame}, as both are damage buffs.`);
  if (source.from === baseFrame) throw new Error(`${abilityName} is already one of ${name}'s abilities.`);
  const text = data.warframes[source.from]?.abilityText?.find((entry) => entry.name === abilityName);
  const fallback = { name: abilityName, text: source.note ?? "" };
  const changed = /^Changed when subsumed/.test(source.note ?? "");
  return {
    augments: source.augments,
    abilityText: (frame.abilityText ?? []).map((entry) => (entry.name === slot ? (text ?? fallback) : entry)),
    unreliable: changed ? abilityName : undefined,
    report: {
      ability: abilityName, replaces: slot, from: source.from, roles: source.roles, scales_with: source.scales_with,
      ...(source.note && { helminth_note: source.note }),
      ...(changed && { numbers_note: "It's weaker when subsumed, so its ability_numbers have no at_build values. Use helminth_note instead." }),
    },
  };
}

export function frameFits(compat, name, frame) {
  const wanted = (compat ?? "").trim();
  const kind = frame.kind ?? "warframe";
  if (kind === "warframe") {
    return ["WARFRAME", "AURA"].includes(wanted) || wanted === name.replace(/ (Prime|Umbra)$/, "");
  }
  if (kind === "archwing") return wanted === "Archwing" || name.includes(wanted);
  if (kind === "necramech") return wanted === "Necramech" || name.includes(wanted);
  if (wanted === "COMPANION") return true;
  if (wanted === "ROBOTIC") return frame.type === "Sentinel" || ROBOTIC.test(name);
  if (wanted === "BEAST") return BEAST.test(name);
  return name.toLowerCase().includes(wanted.toLowerCase()) || (frame.type === wanted);
}

function shardBonuses(shards) {
  if (!Array.isArray(shards)) throw new Error("archon_shards must be a list, such as [\"strength\", {stat: \"health\", tauforged: true}].");
  if (shards.length > 5) throw new Error("A Warframe has at most 5 Archon Shard slots.");
  const percent = {};
  const flat = {};
  for (const shard of shards) {
    const spec = typeof shard === "string" ? { stat: shard } : shard;
    const info = Object.hasOwn(SHARDS, String(spec?.stat).toLowerCase()) ? SHARDS[String(spec.stat).toLowerCase()] : undefined;
    if (!info) throw new Error(`Unknown Archon Shard stat: ${spec?.stat}. Stats: ${Object.keys(SHARDS).join(", ")}.`);
    const scale = spec.tauforged ? 1.5 : 1;
    const stat = spec.stat.toLowerCase();
    if (info.percent) percent[stat] = (percent[stat] ?? 0) + info.percent * scale;
    else flat[stat] = (flat[stat] ?? 0) + info.flat * scale;
  }
  return { percent, flat };
}

export function warframeBuild(args) {
  const {
    warframe, mods = [], aura, second_aura, exilus, reactor = true, base_stats, archon_shards = [], arcanes = [], extra_effects = {}, conditionals = false, level, subsume,
  } = args;
  checkNumbers(extra_effects, "extra effect", (key) => EFFECTS.has(key), [...EFFECTS]);
  if (base_stats) checkNumbers(base_stats, "base stat", (key) => FLAT_ONLY.includes(key), FLAT_ONLY);
  const [name, stored] = find(allFrames(), warframe, "warframe");
  const kind = stored.kind ?? "warframe";
  const infused = subsume ? resolveSubsume(subsume, name, stored) : undefined;
  const fitsFrame = (mod) => frameFits(mod.compat, name, stored) || infused?.augments.includes(mod.name);
  const base = { ...stored, ...base_stats };
  // A mod the game wouldn't let on doesn't count towards anything, so results can't be inflated by one.
  const listed = resolveMods(mods, data.warframeMods);
  const ignored = listed.map((m) => ({
    mod: m.name,
    reason: m.mod.slot !== kind ? `${m.name} is a ${m.mod.slot} mod, but ${name} takes ${kind} mods.` : !fitsFrame({ ...m.mod, name: m.name }) ? `${m.name} only fits ${String(m.mod.compat).trim()}.` : undefined,
  })).filter((entry) => entry.reason);
  const regular = listed.filter((m) => !ignored.some((entry) => entry.mod === m.name));
  // Only Warframes have a confirmed 8 slots, and other frames are capped at the most any frame could have.
  const maxSlots = kind === "warframe" ? 8 : 12;
  const capacityLevel = buildLevel(level, stored.kind === "necramech" ? 40 : 30);
  if (regular.length > maxSlots) throw new Error(`A ${kind} build can have at most ${maxSlots} regular mods here.`);
  for (const m of regular) if (m.mod.aura) throw new Error(`${m.name} is an aura: pass it as "aura".`);

  let auraMod;
  if (aura) {
    if (kind !== "warframe") throw new Error(`Only Warframes have aura slots, and ${name} is a ${kind}.`);
    [auraMod] = resolveMods([aura], data.warframeMods);
    if (!auraMod.mod.aura) throw new Error(`${auraMod.name} is not an aura mod.`);
    auraMod.slot ??= stored.auraPolarity; // the frame's own aura slot, unless told otherwise
  }
  let secondAuraMod;
  if (second_aura) {
    if (!stored.secondAuraPolarity) throw new Error(`${name} has one aura slot.`);
    [secondAuraMod] = resolveMods([second_aura], data.warframeMods);
    if (!secondAuraMod.mod.aura) throw new Error(`${secondAuraMod.name} is not an aura mod.`);
    if (secondAuraMod.name === auraMod?.name) throw new Error("The two aura slots need different auras.");
    secondAuraMod.slot ??= stored.secondAuraPolarity;
  }
  const exilusMod = exilus ? resolveMods([exilus], data.warframeMods)[0] : undefined;
  const equipped = exilusMod ? [...regular, exilusMod] : regular;
  const withAura = [...equipped, ...[auraMod, secondAuraMod].filter(Boolean)];
  const arcaneList = resolveArcanes(arcanes, data.arcanes, "frame");
  if (arcaneList.length > 2) throw new Error("A Warframe has 2 arcane slots.");
  if (new Set(arcaneList.map((a) => a.name)).size < arcaneList.length) throw new Error("A Warframe cannot equip the same arcane twice.");
  const shards = shardBonuses(archon_shards);
  for (const stat of Object.keys(shards.flat)) {
    if (!base[stat]) throw new Error(`${name} has no ${stat}, so it cannot use that Archon Shard.`);
  }
  const triggered = conditionalEffects([...withAura, ...arcaneList], conditionals);
  const totals = totalEffects([...withAura, ...arcaneList, ...triggered, { effects: shards.percent }, { effects: extra_effects }]);
  const sum = (stat) => totals[stat] ?? 0;

  // Percentage mods apply to the rank 30 stat, after rank bonuses, and shard stats are added last.
  const scaled = (stat) => round(base[stat] * Math.max(1 + sum(stat) / 100, 0) + (shards.flat[stat] ?? 0));
  const efficiency = Math.min(100 + sum("efficiency"), 175);
  const health = scaled("health");
  const shields = scaled("shields");
  const armor = scaled("armor");

  const capacity = capacityReport(equipped, { reactor, aura: auraMod, secondAura: secondAuraMod, level: capacityLevel });
  for (const { reason } of ignored) capacity.warnings.push(`${reason} It is left out of these numbers.`);
  for (const a of arcaneList) {
    if (!["warframe", "arcane"].includes(a.arcane.type)) capacity.warnings.push(`${a.name} is a ${a.arcane.type} arcane and does not go on ${name}.`);
  }
  for (const m of withAura) {
    if (m.mod.slot !== kind) capacity.warnings.push(`${m.name} is a ${m.mod.slot} mod, but ${name} takes ${kind} mods.`);
    else if (!fitsFrame({ ...m.mod, name: m.name })) capacity.warnings.push(`${m.name} only fits ${String(m.mod.compat).trim()}.`);
  }
  if (exilusMod && !exilusMod.mod.exilus) capacity.warnings.push(`${exilusMod.name} is not an Exilus mod.`);

  const stats = { health, shields, armor, energy: scaled("energy") };
  return {
    warnings: capacity.warnings,
    warframe: name,
    kind,
    stats,
    abilities: {
      strength: round(100 + sum("strength")),
      duration: round(Math.max(100 + sum("duration"), 12.5)),
      range: round(Math.max(100 + sum("range"), 34)),
      efficiency: round(efficiency),
      ability_cost_multiplier: round(2 - efficiency / 100),
    },
    ...(infused && { subsume: infused.report }),
    ...(stored.abilityText?.some((a) => a.scaling) && {
      ability_numbers: abilityNumbers(infused?.abilityText ?? stored.abilityText, infused?.unreliable, {
        strength: Math.max(100 + sum("strength"), 0),
        duration: Math.max(100 + sum("duration"), 12.5),
        range: Math.max(100 + sum("range"), 34),
        cost: 2 - efficiency / 100,
      }),
      ability_numbers_note: "The sources' listed values multiplied by this build's stats. They are not damage to an enemy: armor, factions, stacking and each ability's own caps are not applied, and the assistant should not present them as kill speed.",
    }),
    damage_reduction_pct: round((armor / (armor + 300)) * 100),
    // The wiki's formula: armor mitigates health only, and shields count double, except on companions.
    effective_health: round((health * (armor + 300)) / 300 + (kind === "companion" ? shields : shields / 0.5)),
    ...(triggered.length && { conditionals_applied: triggered.map((c) => `${c.source}: ${c.text}`) }),
    ...(ignored.length && { ignored_mods: ignored }),
    mod_capacity: capacity,
    not_calculated: [
      ...notCalculated(withAura, { conditionalsOn: conditionals }),
      ...arcanesNotCalculated(arcaneList, conditionals),
    ],
    assumptions: [
      kind === "warframe" ? "Rank 30." : "Uses the stats the sources list, as they publish no rank 30 rule for this kind of frame. Correct them through base_stats if yours differ.",
      "Excludes passives and overshields.",
      conditionals ? "Every triggered effect counts at full stacks, so this is a peak figure." : "Triggered effects are left out and listed in not_calculated.",
    ].join(" "),
    data: DATA_VERSION,
  };
}
