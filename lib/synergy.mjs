// Gathers what Claude needs to reason about a themed build: ability text, augments, and the mods and arcanes whose own
// wording fits. It only finds candidates. Whether a combination works is judged from the text, then checked in the calculators.
import { data, find, normalize } from "./data.mjs";
import { allFrames, frameFits } from "./frames.mjs";
import { meleeFits, weaponCompatibility, weaponRecord } from "./weapons.mjs";

// Everyday build words, expanded to the stats they care about and the wording game text uses.
const THEMES = {
  tank: { stats: ["health", "armor", "shields"], words: ["overguard", "damage reduction", "invulnerab", "heal", "revive", "last gasp"] },
  survive: { stats: ["health", "armor", "shields"], words: ["overguard", "damage reduction", "invulnerab", "heal", "revive"] },
  nuke: { stats: ["strength", "range", "efficiency"], words: ["ability damage", "explod", "explosion", "on cast"] },
  caster: { stats: ["strength", "duration", "range", "efficiency"], words: ["energy", "casting", "on cast"] },
  damage: { stats: ["strength", "damage", "multishot", "critChance", "critDamage", "statusChance"], words: ["ability damage", "damage bonus"] },
  status: { stats: ["statusChance", "statusDamage", "damagePerStatus", "heat", "cold", "electricity", "toxin", "blast", "corrosive", "gas", "magnetic", "radiation", "viral", "slash"], words: ["status", "proc"] },
  crit: { stats: ["critChance", "critDamage", "comboCritChance", "heavyCritChance"], words: ["critical"] },
  energy: { stats: ["efficiency", "energy"], words: ["energy", "orb"] },
  support: { stats: ["range", "duration"], words: ["allies", "squad", "ally", "buff", "restore"] },
  healer: { stats: ["range", "strength"], words: ["heal", "restore", "allies", "squad"] },
  speed: { stats: ["fireRate", "reload"], words: ["sprint", "parkour", "bullet jump", "slide", "aim glide", "speed"] },
  stealth: { stats: [], words: ["invisib", "stealth", "silent", "finisher"] },
  control: { stats: ["range", "duration"], words: ["stun", "knockdown", "ragdoll", "slow", "pull", "lift", "blind", "freeze", "immobil", "open to finisher"] },
  melee: { stats: ["damage", "comboCritChance", "comboStatusChance", "heavyDamage", "initialCombo"], words: ["melee", "combo", "heavy attack", "slam", "finisher"] },
  heavy: { stats: ["heavyDamage", "heavyCritChance", "initialCombo"], words: ["heavy attack", "combo"] },
  gun: { stats: ["damage", "multishot", "critChance", "critDamage", "fireRate"], words: ["reload", "magazine", "ammo"] },
  ammo: { stats: ["magazine", "reload"], words: ["ammo", "magazine", "reload"] },
  aoe: { stats: ["range"], words: ["radius", "area", "explod", "explosion", "punch through"] },
};

const DAMAGE_WORDS = ["impact", "puncture", "slash", "heat", "cold", "electricity", "toxin", "blast", "corrosive", "gas", "magnetic", "radiation", "viral", "void", "true"];

function readTheme(theme) {
  const words = new Set();
  const stats = new Set();
  for (const raw of String(theme ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)) {
    const key = [raw, raw.replace(/s$/, ""), raw.replace(/y$/, "")].find((name) => Object.hasOwn(THEMES, name));
    if (key) {
      THEMES[key].words.forEach((word) => words.add(word));
      THEMES[key].stats.forEach((stat) => stats.add(stat));
    } else {
      words.add(raw);
      // A stat named directly, such as "strength", should find the mods that raise it.
      for (const stat of Object.hasOwn(STAT_WORDS, raw) ? STAT_WORDS[raw] : []) stats.add(stat);
    }
  }
  return { words: [...words], stats: [...stats] };
}

const STAT_WORDS = {
  strength: ["strength"], duration: ["duration"], range: ["range"], efficiency: ["efficiency"], health: ["health"], armor: ["armor"], shield: ["shields"], shields: ["shields"],
  multishot: ["multishot"], reload: ["reload"], magazine: ["magazine"], viral: ["viral"], corrosive: ["corrosive"], heat: ["heat"], toxin: ["toxin"], slash: ["slash"],
};

const describeMod = (name, mod) => ({
  name,
  polarity: mod.polarity,
  max_drain: mod.baseDrain + mod.maxRank,
  ...(Object.keys(mod.effects).length && { effects: mod.effects }),
  ...(modText(mod).length && { text: modText(mod) }),
  ...(mod.set && { set: mod.set }),
  ...(mod.incompatible?.length && { conflicts_with: mod.incompatible }),
});

const modText = (mod) => [...(mod.other ?? []), ...(mod.conditional ?? []).map((c) => c.text)];
const searchable = (name, mod) => [name, ...modText(mod)].join(" ").toLowerCase();
const modStats = (mod) => Object.entries(mod.effects).filter(([, value]) => value > 0).map(([stat]) => stat);

const wordFound = (text, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text);
// Parkour text says "jump strength" and self-resist arcanes name every status, and neither helps unless asked for.
const OFF_TOPIC = /\b(double jump|bullet jump|aim glide|wall latch|slide|knockdown recovery)\b|chance to resist/;

function rank(entries, theme, limit, describe, textOf, statsOf) {
  const wantsMovement = theme.words.some((word) => /jump|glide|slide|parkour|resist|sprint/.test(word));
  const scored = entries.map(([name, item]) => {
    const text = textOf(name, item);
    const statHits = statsOf(item).filter((stat) => theme.stats.includes(stat)).length;
    const wordHits = theme.words.filter((word) => wordFound(text, word)).length;
    const penalty = !wantsMovement && OFF_TOPIC.test(text) ? 3 : 0;
    return { name, item, statHits, wordHits, score: statHits * 3 + wordHits - penalty, length: text.length };
  });
  const searching = theme.words.length || theme.stats.length;
  const matching = searching ? scored.filter((entry) => entry.score > 0) : scored.filter((entry) => !OFF_TOPIC.test(textOf(entry.name, entry.item)));
  return {
    total: matching.length,
    results: matching
      .sort((a, b) => b.score - a.score || b.length - a.length)
      .slice(0, limit)
      .map(({ name, item }) => describe(name, item)),
  };
}

const describeArcane = (name, arcane) => ({ name, type: arcane.type, text: arcane.text });

function arcanesFor(types, theme, limit, owned) {
  const entries = Object.entries(data.arcanes).filter(([name, arcane]) => types.includes(arcane.type) && owned(name));
  return rank(entries, theme, limit, describeArcane, (name, arcane) => `${name} ${arcane.text.join(" ")}`.toLowerCase(), (arcane) => Object.keys({ ...arcane.frameEffects, ...arcane.weaponEffects }));
}

const NEXT_STEPS = "Read the ability, augment, mod and arcane text for interactions, propose builds around them, then run each through warframe_build or weapon_build to check it is legal and see its numbers. Say which parts are calculated and which are theory from the text.";

function frameContext(name, frame, theme, limit, owned) {
  const kind = frame.kind ?? "warframe";
  const abilityWords = [...new Set(DAMAGE_WORDS.filter((word) => (frame.abilityText ?? []).some((a) => a.text.toLowerCase().includes(word))))];
  const fits = Object.entries(data.warframeMods)
    .filter(([modName, mod]) => !mod.pvpOnly && mod.slot === kind && frameFits(mod.compat, name, frame) && owned(modName));
  const baseName = name.replace(/ (Prime|Umbra)$/, "");
  const augments = fits.filter(([, mod]) => (mod.compat ?? "").trim() === baseName);
  const general = fits.filter(([, mod]) => (mod.compat ?? "").trim() !== baseName);
  const mods = rank(general, theme, limit, describeMod, searchable, modStats);
  const arcanes = arcanesFor(["warframe", "arcane"], theme, limit, owned);
  // Primes wield the Prime version where one exists.
  const exalted = [...new Set((frame.abilityText ?? []).filter((a) => a.weapon).map((a) => (name.endsWith(" Prime") && data.weapons[`${a.weapon} Prime`] ? `${a.weapon} Prime` : a.weapon)))];
  return {
    subject: name,
    kind,
    stats: { health: frame.health, shields: frame.shields, armor: frame.armor, energy: frame.energy },
    polarities: frame.polarities,
    ...(frame.auraPolarity && { aura_polarity: frame.auraPolarity }),
    ...(frame.passive && { passive: frame.passive }),
    abilities: frame.abilityText ?? frame.abilities,
    ...(exalted.length && { exalted_weapons: exalted, exalted_note: "These abilities attack with their own weapon, modded separately. Build it with explore_synergies or suggest_weapon_build." }),
    ...(abilityWords.length && { damage_types_in_abilities: abilityWords }),
    augments: augments.map(([modName, mod]) => describeMod(modName, mod)),
    matching_mods: mods.results,
    total_matching_mods: mods.total,
    matching_arcanes: arcanes.results,
    total_matching_arcanes: arcanes.total,
    next_steps: NEXT_STEPS,
  };
}

function arcaneTypes(record, { zaw, kitgun }) {
  if (zaw) return ["melee", "zaw"];
  if (kitgun) return [record.slot, "kitgun"];
  if (record.slot === "shotgun") return ["primary", "shotgun"];
  if (record.type === "Bow") return ["primary", "bow"];
  return [record.slot === "claws" ? "melee" : record.slot];
}

function weaponContext(name, record, theme, limit, owned, attack, parts) {
  const melee = ["melee", "archmelee", "claws"].includes(record.slot);
  const mode = record.modes.find((m) => normalize(m.name) === normalize(attack ?? "")) ?? record.modes[0];
  const fits = Object.entries(data.weaponMods).filter(([modName, mod]) => !mod.pvpOnly && !mod.stance && owned(modName) && !weaponCompatibility({ name: modName, mod }, name, record));
  const specific = fits.filter(([, mod]) => (mod.compat ?? "").trim() === name.replace(/ (Prime|Vandal|Wraith)$/, ""));
  const mods = rank(fits, theme, limit, describeMod, searchable, modStats);
  const stances = melee ? Object.entries(data.weaponMods).filter(([modName, mod]) => mod.stance && !mod.pvpOnly && owned(modName) && meleeFits(mod.compat, name, record)).map(([modName]) => modName) : undefined;
  const arcanes = arcanesFor(arcaneTypes(record, parts), theme, limit, owned);
  return {
    subject: name,
    kind: record.slot,
    type: record.type,
    ...(record.trigger && { trigger: record.trigger }),
    attacks: record.modes.map((m) => m.name),
    leans_on: { crit_chance_pct: mode.critChance, crit_multiplier: mode.critDamage, status_chance_pct: mode.statusChance },
    polarities: record.polarities,
    ...(specific.length && { augments: specific.map(([modName, mod]) => describeMod(modName, mod)) }),
    ...(stances && { stances }),
    matching_mods: mods.results,
    total_matching_mods: mods.total,
    matching_arcanes: arcanes.results,
    total_matching_arcanes: arcanes.total,
    next_steps: NEXT_STEPS,
  };
}

export function exploreSynergies({ warframe, weapon, zaw, kitgun, attack, theme: themeText, limit = 12, only_mods, exclude = [] }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("limit must be a whole number from 1 to 60.");
  if (Boolean(warframe) === Boolean(weapon || zaw || kitgun)) throw new Error("Pass warframe, or one of weapon, zaw or kitgun.");
  const theme = readTheme(themeText);
  const allMods = { ...data.warframeMods, ...data.weaponMods };
  const ownedNames = only_mods && new Set(only_mods.map((name) => normalize(find(allMods, name, "mod")[0])));
  // A list of owned mods never limits arcanes, which it doesn't cover.
  const missing = new Set(exclude.map(normalize));
  const owned = (name) => !missing.has(normalize(name)) && (!ownedNames || ownedNames.has(normalize(name)) || Object.hasOwn(data.arcanes, name));
  const result = warframe
    ? frameContext(...find(allFrames(), warframe, "warframe"), theme, limit, owned)
    : weaponContext(...weaponRecord({ weapon, zaw, kitgun }), theme, limit, owned, attack, { zaw, kitgun });
  // An empty list for a limited player should say why, not look like nothing fits.
  const limited = only_mods || exclude.length ? { limited_by_owned_mods: true, ...(only_mods && { owned_mods_counted: only_mods.length }) } : {};
  return { ...(themeText && { theme: themeText, searched_for: { stats: theme.stats, words: theme.words } }), ...limited, ...result };
}
