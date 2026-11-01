// Suggests mods with a beam search. It is heuristic, so results say a better build can exist.
import { data, find, round } from "./data.mjs";
import { allFrames, frameFits, warframeBuild } from "./frames.mjs";
import { assignSlots, resolveMods } from "./mods.mjs";
import { resolveTarget } from "./target.mjs";
import { DAMAGE_EFFECTS, meleeFits, weaponBuild, weaponCompatibility, weaponRecord } from "./weapons.mjs";

const BEAM_WIDTH = 200;

// Beam search: each round extends the best builds by one mod. Half the beam is ranked by value and half by value per
// capacity, or one costly mod crowds out the two cheap ones that would beat it. Single swaps then polish the result.
function search({ required, candidates, slots, evaluate }) {
  const start = evaluate(required);
  if (!start.fits) throw new Error(`The required mods do not fit: ${start.warnings.join(" ")}`);
  let best = { names: required, value: start.value };
  let beam = [best];
  for (let size = required.length; size < slots && beam.length; size++) {
    const seen = new Map();
    for (const state of beam) {
      for (const mod of candidates) {
        if (state.names.includes(mod)) continue;
        const names = [...state.names, mod];
        const key = [...names].sort().join("|");
        if (seen.has(key)) continue;
        const next = evaluate(names);
        if (next.fits) seen.set(key, { names, value: next.value, used: next.used });
      }
    }
    const states = [...seen.values()];
    const top = (rank) => [...states].sort((a, b) => rank(b) - rank(a)).slice(0, BEAM_WIDTH / 2);
    beam = [...new Set([...top((x) => x.value), ...top((x) => x.value / Math.max(x.used, 1))])];
    for (const state of beam) if (state.value > best.value) best = state;
  }

  for (let improved = true; improved;) {
    improved = false;
    for (const [i, old] of best.names.entries()) {
      if (required.includes(old)) continue;
      for (const mod of candidates) {
        if (best.names.includes(mod)) continue;
        const names = best.names.map((other, j) => (j === i ? mod : other));
        const next = evaluate(names);
        if (next.fits && next.value > best.value + 1e-9) {
          best = { names, value: next.value };
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best.names;
}

// On a tie, the first wins: a mod with no side effects, then the cheaper one, so Serration beats Heavy Caliber.
const preferSimple = ([, a], [, b]) => (a.other?.length ?? 0) - (b.other?.length ?? 0) || a.baseDrain + a.maxRank - b.baseDrain - b.maxRank;

const checkForma = (forma) => {
  if (!Number.isInteger(forma) || forma < 0 || forma > 8) throw new Error("forma must be a whole number from 0 to 8.");
};

export function suggestWeaponBuild(args) {
  const {
    weapon, zaw, kitgun, goal, mods: required = [], exclude = [], polarities, stance, combo_multiplier, attack, catalyst = true,
    forma = 0, target, conditionals = false, status_types_on_target = 0, use_exilus = false, arcanes = [], riven, extra_effects, level,
  } = args;
  checkForma(forma);
  const [name, record] = weaponRecord({ weapon, zaw, kitgun });
  const melee = ["melee", "archmelee", "claws"].includes(record.slot);
  const chosenGoal = goal ?? (melee ? "burst_dps" : "sustained_dps");
  const GOALS = {
    burst_dps: (b) => (target ? b.target.burst_dps : b.burst_dps),
    sustained_dps: (b) => (target ? b.target.sustained_dps : b.sustained_dps),
    heavy_attack: (b) => (target ? b.heavy_attack?.average_damage_on_target : b.heavy_attack?.average_damage_with_crits) ?? 0,
    status_dps: (b) => b.status.damage_over_time_dps,
  };
  if (!GOALS[chosenGoal]) throw new Error(`Unknown goal: ${chosenGoal}. Goals: ${Object.keys(GOALS).join(", ")}`);
  if (melee && chosenGoal === "sustained_dps") throw new Error("Melee weapons have no magazine: use burst_dps, heavy_attack or status_dps.");
  if (!melee && chosenGoal === "heavy_attack") throw new Error(`${name} is not melee: use burst_dps, sustained_dps or status_dps.`);
  if (chosenGoal === "heavy_attack" && !record.heavyAttack) throw new Error(`The sources list no heavy attack for ${name}.`);

  const relevant = new Set(DAMAGE_EFFECTS);
  if (chosenGoal === "sustained_dps") ["magazine", "reload"].forEach((e) => relevant.add(e));
  if (chosenGoal === "heavy_attack") ["heavyCritChance", "heavyDamage"].forEach((e) => relevant.add(e));
  if (chosenGoal === "status_dps") ["statusChance", "comboStatusChance", "statusDamage"].forEach((e) => relevant.add(e));
  if (status_types_on_target) relevant.add("damagePerStatus");
  const group = resolveTarget(target)?.group;
  if (group) relevant.add(`faction:${group}`);

  // Melee builds assume a held combo, since Blood Rush and heavy attacks are built around one.
  const combo = melee ? combo_multiplier ?? 12 : undefined;
  // A stance's moves change real damage, so it is only chosen for capacity here unless one is named.
  const chosenStance = !melee || record.slot === "claws" ? undefined : stance ?? Object.entries(data.weaponMods)
    .filter(([, mod]) => mod.stance && !mod.pvpOnly && meleeFits(mod.compat, name, record))
    .sort(([, a], [, b]) => Number(b.polarity === record.stancePolarity) - Number(a.polarity === record.stancePolarity))[0]?.[0];
  const slotPolarities = polarities ?? record.polarities;

  const buildOf = (names, exilusMod) => {
    const resolved = resolveMods(names, data.weaponMods);
    const { assigned, added } = assignSlots(resolved, slotPolarities, { forma });
    const build = weaponBuild({
      weapon, zaw, kitgun, attack, catalyst, stance: chosenStance, combo_multiplier: combo, target, conditionals,
      status_types_on_target, arcanes, riven, extra_effects, exilus: exilusMod, level,
      mods: resolved.map((m) => ({ name: m.name, slot_polarity: assigned.get(m.name) })),
    });
    return { build, assigned, added };
  };
  const evaluate = (names) => {
    const { build } = buildOf(names);
    return { fits: build.mod_capacity.warnings.length === 0, warnings: build.mod_capacity.warnings, value: GOALS[chosenGoal](build), used: build.mod_capacity.used };
  };

  const requiredNames = resolveMods(required, data.weaponMods).map((m) => m.name);
  const excluded = new Set(resolveMods(exclude, data.weaponMods).map((m) => m.name));
  const effectKeys = (mod) => [...Object.keys(mod.effects), ...(conditionals ? (mod.conditional ?? []).flatMap((c) => Object.keys(c.effects)) : [])];
  const candidates = Object.entries(data.weaponMods)
    .filter(([modName, mod]) => !mod.pvpOnly && !mod.stance && !mod.unverified && !excluded.has(modName) && !requiredNames.includes(modName))
    .filter(([, mod]) => effectKeys(mod).some((effect) => relevant.has(effect)))
    .filter(([modName, mod]) => !weaponCompatibility({ name: modName, mod }, name, record))
    .sort(preferSimple)
    .map(([modName]) => modName);

  const slots = riven ? 7 : 8;
  const chosen = search({ required: requiredNames, candidates, slots, evaluate });

  // An Exilus slot takes one more mod, if the weapon has an adapter.
  let exilusChoice;
  if (use_exilus) {
    let bestValue = GOALS[chosenGoal](buildOf(chosen).build);
    for (const modName of candidates.filter((c) => data.weaponMods[c].exilus && !chosen.includes(c))) {
      const { build } = buildOf(chosen, modName);
      if (build.mod_capacity.warnings.length === 0 && GOALS[chosenGoal](build) > bestValue + 1e-9) {
        bestValue = GOALS[chosenGoal](build);
        exilusChoice = modName;
      }
    }
  }

  const { build, assigned, added } = buildOf(chosen, exilusChoice);
  return {
    goal: chosenGoal,
    weapon: name,
    mods: chosen.map((mod) => ({ name: mod, slot_polarity: assigned.get(mod) })),
    ...(exilusChoice && { exilus: exilusChoice }),
    ...(chosenStance && { stance: chosenStance }),
    ...(added.length && { forma_to_add: added }),
    build,
    assumptions: `Assumes you own every mod at max rank, so use exclude for ones you do not have. ${target ? "Picks for the target you named." : "Picks for raw damage, so pass target for armor and faction matchups."} The search is heuristic, so a better build can exist.`,
  };
}

const FRAME_GOALS = {
  strength: { strength: 1 }, duration: { duration: 1 }, range: { range: 1 }, efficiency: { efficiency: 1 },
  health: { health: 1 }, shields: { shields: 1 }, armor: { armor: 1 }, energy: { energy: 1 },
  effective_health: { effective_health: 1 },
};

// Scores a build as a weighted sum of each stat relative to its value with no mods, so stats of any size can mix.
function frameScore(build, baseline, weights, targets) {
  const read = (b, stat) => {
    if (stat === "effective_health") return b.effective_health;
    return b.abilities[stat] ?? b.stats[stat];
  };
  let score = 0;
  for (const [stat, weight] of Object.entries(weights)) {
    const base = read(baseline, stat);
    if (base > 0) score += weight * (read(build, stat) / base);
  }
  // Targets come first: any shortfall outweighs every other gain.
  for (const [stat, wanted] of Object.entries(targets)) {
    const value = read(build, stat);
    if (value < wanted) score -= 1000 * ((wanted - value) / wanted);
  }
  return score;
}

export function suggestWarframeBuild(args) {
  const {
    warframe, goal, targets = {}, mods: required = [], exclude = [], polarities, aura, exilus, use_exilus = true, reactor = true,
    forma = 0, archon_shards, arcanes, extra_effects, base_stats, conditionals = false, level,
  } = args;
  checkForma(forma);
  const [name, frame] = find(allFrames(), warframe, "warframe");
  const kind = frame.kind ?? "warframe";
  const named = typeof goal === "string";
  if (named && !FRAME_GOALS[goal]) throw new Error(`Unknown goal: ${goal}. Goals: ${Object.keys(FRAME_GOALS).join(", ")}, or an object of weights such as {strength: 2, efficiency: 1}.`);
  const weights = named ? FRAME_GOALS[goal] : goal ?? {};
  if (!Object.keys(weights).length && !Object.keys(targets).length) throw new Error("Pass a goal, targets, or both.");
  for (const stat of [...Object.keys(weights), ...Object.keys(targets)]) {
    if (!Object.values(FRAME_GOALS).some((g) => g[stat])) throw new Error(`Unknown stat: ${stat}. Stats: ${Object.keys(FRAME_GOALS).join(", ")}.`);
  }

  const relevant = new Set([...Object.keys(weights), ...Object.keys(targets)]);
  if (relevant.has("effective_health")) ["health", "shields", "armor"].forEach((stat) => relevant.add(stat));
  const shared = { warframe: name, reactor, archon_shards, arcanes, extra_effects, base_stats, conditionals, level };
  const baseline = warframeBuild(shared);

  const excluded = new Set(resolveMods(exclude, data.warframeMods).map((m) => m.name));
  const requiredNames = resolveMods(required, data.warframeMods).map((m) => m.name);
  const usable = ([modName, mod]) => !mod.pvpOnly && !mod.unverified && !excluded.has(modName)
    && mod.slot === kind && frameFits(mod.compat, name, frame) && Object.keys(mod.effects).length > 0;

  // The highest-capacity aura that fits the slot, and among those one that helps the goal.
  let chosenAura = aura;
  if (!chosenAura && kind === "warframe") {
    const auras = Object.entries(data.warframeMods).filter(([auraName, mod]) => mod.aura && !excluded.has(auraName) && !mod.pvpOnly && !mod.unverified);
    const capacityOf = (mod) => (mod.baseDrain + mod.maxRank) * (frame.auraPolarity === "universal" || mod.polarity === frame.auraPolarity ? 2 : 0.75);
    const helps = (mod) => Object.entries(mod.effects).reduce((total, [stat, value]) => total + (relevant.has(stat) ? value : 0), 0);
    // An aura that lowers a stat the goal wants, such as Power Donation for strength, is never worth its capacity.
    chosenAura = auras.filter(([, mod]) => helps(mod) >= 0).sort(([, a], [, b]) => helps(b) - helps(a) || capacityOf(b) - capacityOf(a))[0]?.[0];
  }

  const candidates = Object.entries(data.warframeMods)
    .filter((entry) => usable(entry) && !entry[1].aura && !requiredNames.includes(entry[0]))
    .filter(([, mod]) => Object.keys(mod.effects).some((effect) => relevant.has(effect)))
    .sort(preferSimple)
    .map(([modName]) => modName);

  const slotPolarities = polarities ?? frame.polarities ?? [];
  const buildOf = (names, exilusMod = exilus) => {
    const resolved = resolveMods(names, data.warframeMods);
    const { assigned, added } = assignSlots(resolved, slotPolarities, { forma, slots: kind === "necramech" ? 12 : 8 });
    const build = warframeBuild({
      ...shared, aura: chosenAura, exilus: exilusMod,
      mods: resolved.map((m) => ({ name: m.name, slot_polarity: assigned.get(m.name) })),
    });
    return { build, assigned, added };
  };
  const evaluate = (names) => {
    const { build } = buildOf(names);
    return { fits: build.mod_capacity.warnings.length === 0, warnings: build.mod_capacity.warnings, value: frameScore(build, baseline, weights, targets), used: build.mod_capacity.used };
  };

  const chosen = search({ required: requiredNames, candidates, slots: kind === "necramech" ? 12 : 8, evaluate });

  let exilusChoice = exilus;
  if (!exilusChoice && use_exilus) {
    let bestValue = frameScore(buildOf(chosen).build, baseline, weights, targets);
    for (const modName of candidates.filter((c) => data.warframeMods[c].exilus && !chosen.includes(c))) {
      const { build } = buildOf(chosen, modName);
      const value = frameScore(build, baseline, weights, targets);
      if (build.mod_capacity.warnings.length === 0 && value > bestValue + 1e-9) {
        bestValue = value;
        exilusChoice = modName;
      }
    }
  }

  const { build, assigned, added } = buildOf(chosen, exilusChoice);
  const read = (stat) => (stat === "effective_health" ? build.effective_health : build.abilities[stat] ?? build.stats[stat]);
  const missed = Object.entries(targets).filter(([stat, wanted]) => read(stat) < wanted)
    .map(([stat, wanted]) => ({ stat, wanted, reached: round(read(stat)) }));
  return {
    goal: goal ?? "targets",
    warframe: name,
    mods: chosen.map((mod) => ({ name: mod, slot_polarity: assigned.get(mod) })),
    ...(chosenAura && { aura: chosenAura }),
    ...(exilusChoice && { exilus: exilusChoice }),
    ...(added.length && { forma_to_add: added }),
    ...(missed.length && { targets_missed: missed }),
    build,
    assumptions: "Assumes you own every mod at max rank, so use exclude for ones you do not have. Only counts stats the calculator can model, so it never picks a mod for an ability augment's effect. The search is heuristic, so a better build can exist.",
  };
}
