import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseLuaAfter } from "./scripts/lua.mjs";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
// Tests never touch the network or the real profile.
const home = mkdtempSync(join(tmpdir(), "warframe-builds-test-"));
process.env.WARFRAME_BUILDS_HOME = home;
process.env.WARFRAME_BUILDS_OFFLINE = "1";
after(() => rmSync(home, { recursive: true, force: true }));

function session(...requests) {
  const input = requests.map((r, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...r })).join("\n") + "\n";
  const { stdout } = spawnSync(process.execPath, [server], { input, encoding: "utf8", env: process.env });
  return stdout.trim().split("\n").map((line) => JSON.parse(line));
}

function call(name, args) {
  const [reply] = session({ method: "tools/call", params: { name, arguments: args } });
  const { content, isError } = reply.result;
  return isError ? { error: content[0].text } : JSON.parse(content[0].text);
}

// Fixed stats, so the arithmetic tests don't break when a game patch changes real numbers.
const FRAME = { health: 300, shields: 200, armor: 300, energy: 100 };
const GUN = {
  damage: { impact: 2, puncture: 4, slash: 6 }, pellets: 1, critChance: 30, critDamage: 3,
  statusChance: 10, fireRate: 15, magazine: 200, reload: 3,
};

test("completes the MCP handshake and lists tools", () => {
  const [init, list] = session(
    { method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { method: "tools/list" },
  );
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(list.result.tools.map((t) => t.name), [
    "list_warframes", "list_weapons", "list_enemies", "list_modular_parts", "search_mods", "search_arcanes", "warframe_build", "weapon_build",
    "suggest_weapon_build", "suggest_warframe_build", "explore_synergies", "get_profile", "update_profile", "save_build", "delete_saved_build",
    "market_price", "sell_advice", "alecaframe_account", "data_info",
  ]);
  const writers = list.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(writers, ["update_profile", "save_build", "delete_saved_build"]);
});

test("warframe_build applies mods to rank 30 stats", () => {
  const build = call("warframe_build", {
    warframe: "Saryn", base_stats: FRAME, mods: ["Vitality", "Blind Rage", "Streamline"],
  });
  assert.equal(build.stats.health, 600);
  assert.equal(build.abilities.strength, 199);
  assert.equal(build.abilities.efficiency, 75);
  assert.equal(build.abilities.ability_cost_multiplier, 1.25);
});

test("effective health uses the wiki formula", () => {
  const build = call("warframe_build", { warframe: "Saryn", base_stats: FRAME });
  assert.equal(build.damage_reduction_pct, 50);
  assert.equal(build.effective_health, 300 * 2 + 200 * 2);
});

test("efficiency is capped at 175%", () => {
  const build = call("warframe_build", { warframe: "Rhino", mods: ["Streamline", "Fleeting Expertise"] });
  assert.equal(build.abilities.efficiency, 175);
  assert.equal(build.abilities.ability_cost_multiplier, 0.25);
});

test("lower ranks scale mod effects and drain", () => {
  const build = call("warframe_build", {
    warframe: "Saryn", base_stats: FRAME, mods: [{ name: "Vitality", rank: 4 }],
  });
  assert.equal(build.stats.health, round(300 * (1 + 5 / 11)));
  assert.equal(build.mod_capacity.drains[0].drain, 6);
});

test("polarity changes drain with the documented rounding", () => {
  const { mod_capacity: capacity } = call("warframe_build", {
    warframe: "Rhino",
    mods: [
      { name: "Intensify", slot_polarity: "madurai" }, // 11 halves to 6, rounded up
      { name: "Vitality", slot_polarity: "madurai" }, // 12 + 25% = 15
      { name: "Blind Rage", slot_polarity: "none" }, // 16 unchanged
    ],
  });
  assert.deepEqual(capacity.drains.map((d) => d.drain), [6, 15, 16]);
});

test("aura adds capacity by polarity and defaults to the frame's slot", () => {
  const capacityWith = (slot_polarity) => call("warframe_build", {
    warframe: "Excalibur", aura: { name: "Steel Charge", slot_polarity },
  }).mod_capacity.capacity;
  assert.equal(capacityWith("madurai"), 78);
  assert.equal(capacityWith("naramon"), 67);
  assert.equal(capacityWith("none"), 69);

  // Rhino's aura slot is Madurai, matching Steel Charge.
  const rhino = call("warframe_build", { warframe: "Rhino", aura: "Steel Charge" });
  assert.equal(rhino.mod_capacity.capacity, 78);
  assert.match(rhino.not_calculated[0].at_max_rank, /Melee Damage/);
});

test("mod variants conflict and overspending warns", () => {
  const { mod_capacity: capacity } = call("warframe_build", {
    warframe: "Rhino", reactor: false, mods: ["Flow", "Primed Flow", "Blind Rage"],
  });
  assert.equal(capacity.capacity, 30);
  assert.equal(capacity.warnings.length, 2);
});

test("augments for another frame warn", () => {
  const { mod_capacity: capacity } = call("warframe_build", { warframe: "Rhino", mods: ["Abating Link"] });
  assert.match(capacity.warnings[0], /only fits/);
});

test("weapon_build combines elements in mod order and computes DPS", () => {
  const build = call("weapon_build", {
    weapon: "Soma Prime", base_stats: GUN, mods: ["Serration", "Hellfire", "Infected Clip", "Stormbringer"],
  });
  // 12 base x 2.65 Serration, then heat + toxin = gas at 180%, and electricity at 90%
  assert.equal(build.damage_by_type.gas, 57.24);
  assert.equal(build.damage_by_type.electricity, 28.62);
  assert.equal(build.damage_per_shot, 117.66);
  // 117.66 x 1.6 average crit x 15 fire rate
  assert.equal(build.burst_dps, 2823.84);
});

test("innate elements combine after mod elements", () => {
  const build = call("weapon_build", {
    weapon: "Soma Prime", base_stats: { ...GUN, damage: { heat: 10 } }, mods: ["Infected Clip"],
  });
  assert.deepEqual(build.damage_by_type, { gas: 19 });
});

test("damage types no mod can change still count, and scale with +damage", () => {
  const build = call("weapon_build", {
    weapon: "Soma Prime", base_stats: { ...GUN, damage: { void: 100, radiation: 50, slash: 10 } }, mods: ["Serration"],
  });
  assert.deepEqual(build.damage_by_type, { slash: 26.5, void: 265, radiation: 132.5 });
});

test("multishot, pellets, reload and status are applied", () => {
  const build = call("weapon_build", {
    weapon: "Tigris Prime",
    base_stats: { ...GUN, damage: { slash: 100 }, pellets: 8, magazine: 2, reload: 2, fireRate: 2, statusChance: 10 },
    mods: ["Hell's Chamber"],
  });
  assert.equal(build.pellets_or_multishot, 17.6);
  assert.equal(build.damage_per_trigger, 1760);
  assert.equal(build.reload_seconds, 2);
  assert.equal(build.status_chance_pct, 10);
});

test("ammo cost and empty magazines affect sustained DPS", () => {
  const sustained = (extra) => call("weapon_build", { weapon: "Soma Prime", base_stats: { ...GUN, reload: 5, ...extra } });
  const normal = sustained({ magazine: 30, ammoCost: 1 });
  assert.equal(normal.attacks_per_magazine, 30);
  // 2s of firing, then 5s of reloading
  assert.equal(normal.sustained_dps, round(normal.burst_dps * (2 / 7)));

  const costly = sustained({ magazine: 30, ammoCost: 3 });
  assert.equal(costly.attacks_per_magazine, 10);
  assert.equal(costly.sustained_dps, round(costly.burst_dps * ((10 / 15) / (10 / 15 + 5))));

  const none = sustained({ magazine: 0 });
  assert.equal(none.sustained_dps, none.burst_dps);

  const free = sustained({ ammoCost: 0 });
  assert.equal(free.sustained_dps, free.burst_dps);
  assert.equal(free.attacks_per_magazine, null);
});

test("real conflict lists catch variants that names alone would miss", () => {
  const { mod_capacity: capacity } = call("weapon_build", { weapon: "Soma Prime", mods: ["Serration", "Amalgam Serration"] });
  assert.match(capacity.warnings.join(" "), /Amalgam Serration conflicts with Serration/);
  const clean = call("weapon_build", { weapon: "Soma Prime", mods: ["Serration", "Heavy Caliber"] });
  assert.deepEqual(clean.mod_capacity.warnings, []);
});

test("mods missing from WFCD use the real version instead of the Flawed copy", () => {
  const { mods } = call("search_mods", { query: "Quick Thinking" });
  assert.equal(mods[0].maxRank, 5);
  assert.equal(mods[0].baseDrain, 10);
  assert.match(mods[0].other.join(" "), /240%/);
});

test("charge weapons default to a full charge with a real fire rate", () => {
  const lanka = call("weapon_build", { weapon: "Lanka" });
  assert.equal(lanka.attack, "Charged Shot");
  assert.equal(lanka.fire_rate, 1);
  assert.equal(lanka.damage_by_type.electricity, 525);
  assert.ok(lanka.other_attacks.includes("Partially Charged Shot"));
});

test("mods for the wrong weapon class warn", () => {
  const { mod_capacity: capacity } = call("weapon_build", { weapon: "Lex Prime", mods: ["Serration"] });
  assert.match(capacity.warnings[0], /primary mod/);
});

test("attack modes can be selected, and unknown ones are explained", () => {
  const incarnon = call("weapon_build", { weapon: "Soma Prime", attack: "Incarnon Form" });
  assert.equal(incarnon.attack, "Incarnon Form");
  assert.match(call("weapon_build", { weapon: "Soma Prime", attack: "Nope" }).error, /Modes:/);
});

test("matches the wiki's own worked examples", () => {
  // From the wiki's Vitality and Flow pages.
  assert.equal(call("warframe_build", { warframe: "Frost", mods: ["Vitality"] }).stats.health, 740);
  assert.equal(call("warframe_build", { warframe: "Loki", mods: ["Flow"] }).stats.energy, 450);
});

test("imported data has the corrected real values", () => {
  const inaros = call("list_warframes", { query: "Inaros" }).results.Inaros;
  assert.equal(inaros.health, 2310);
  assert.equal(inaros.shields, 0);
  const { mods } = call("search_mods", { query: "Hellfire" });
  assert.equal(mods[0].effects.heat, 90);
  assert.equal(call("search_mods", { query: "Transient Fortitude" }).mods[0].effects.duration, -27.5);
});

test("every weapon and Warframe calculates, and listing is capped", () => {
  const sweep = (tool, argument, names) => session(
    ...names.map((name) => ({ method: "tools/call", params: { name: tool, arguments: { [argument]: name } } })),
  ).map((reply, i) => {
    assert.ok(!reply.result.isError, `${names[i]}: ${reply.result.content[0].text}`);
    return [names[i], JSON.parse(reply.result.content[0].text)];
  });

  const weaponData = call("list_weapons", { limit: 1000, detail: true }).results;
  const weapons = Object.keys(weaponData);
  assert.ok(weapons.length >= 500);
  for (const [name, build] of sweep("weapon_build", "weapon", weapons)) {
    const isMelee = weaponData[name].slot === "melee";
    assert.ok(build.burst_dps > 0 && (isMelee || build.sustained_dps > 0), `${name} has bad DPS`);
    // With no mods, nothing may be lost: every damage type in the data must reach the result.
    const expected = Object.values(weaponData[name].modes[0].damage).reduce((total, v) => total + v, 0);
    assert.ok(Math.abs(build.damage_per_shot - expected) <= 0.01, `${name} lost damage: ${build.damage_per_shot} vs ${expected}`);
  }

  const frames = Object.keys(call("list_warframes", { limit: 1000 }).results);
  assert.ok(frames.length >= 100);
  for (const [name, build] of sweep("warframe_build", "warframe", frames)) {
    // Energy can be 0: Hildryn has no energy pool.
    assert.ok(build.stats.health > 0 && build.stats.energy >= 0, `${name} has bad stats`);
  }

  assert.equal(Object.keys(call("list_weapons", {}).results).length, 25);
});

test("melee follows the wiki's worked examples", () => {
  // From the wiki's Melee page: Paracesis, Pressure Point and Fever Strike at 7x.
  const paracesis = call("weapon_build", { weapon: "Paracesis", mods: ["Pressure Point", "Fever Strike"], combo_multiplier: 7 });
  assert.equal(paracesis.heavy_attack.damage, 38974.32);
  // From the Blood Rush and Weeping Wounds pages: 20% base at 4x, with True Steel or Voltaic Strike.
  const sword = { damage: { slash: 100 }, critChance: 20, statusChance: 20 };
  const crit = call("weapon_build", { weapon: "Skana", base_stats: sword, mods: ["True Steel", "Blood Rush"], combo_multiplier: 4 });
  assert.equal(crit.crit_chance_pct, 68);
  const status = call("weapon_build", { weapon: "Skana", base_stats: sword, mods: ["Voltaic Strike", "Weeping Wounds"], combo_multiplier: 4 });
  assert.equal(status.status_chance_pct, 56);
});

test("True Steel counts twice on heavy attacks only", () => {
  const build = call("weapon_build", {
    weapon: "Skana", base_stats: { damage: { slash: 100 }, critChance: 10, critDamage: 2, heavyAttack: 500 }, mods: ["True Steel"],
  });
  assert.equal(build.crit_chance_pct, 22);
  assert.equal(build.heavy_attack.crit_chance_pct, 34);
  assert.equal(build.heavy_attack.damage, 500);
  assert.equal(build.heavy_attack.average_damage_with_crits, 670);
});

test("Killing Blow adds to +damage on heavy attacks only", () => {
  const build = call("weapon_build", {
    weapon: "Skana", base_stats: { damage: { slash: 100 }, critChance: 0, heavyAttack: 500 }, mods: ["Pressure Point", "Killing Blow"],
  });
  assert.equal(build.damage_per_shot, 220);
  assert.equal(build.heavy_attack.damage, 1700); // 500 x (1 + 1.2 + 1.2)
});

test("heavy attacks that do not fit their class multiplier are flagged", () => {
  assert.equal(call("weapon_build", { weapon: "Nikana Prime" }).heavy_attack.unconfirmed, undefined);
  assert.match(call("weapon_build", { weapon: "Dual Skana" }).heavy_attack.unconfirmed, /5x heavy attack multiplier/);
  assert.match(call("weapon_build", { weapon: "Glaive" }).heavy_attack.unconfirmed, /2x heavy attack multiplier/);
  assert.equal(call("weapon_build", { weapon: "Dual Skana", base_stats: { heavyAttack: 900 } }).heavy_attack.unconfirmed, undefined);
  assert.equal(call("weapon_build", { weapon: "Dual Skana", base_stats: { heavyAttack: 0 } }).heavy_attack, null);
});

test("melee uses attack speed and flat range, with no magazine", () => {
  const build = call("weapon_build", {
    weapon: "Skana", base_stats: { damage: { slash: 100 }, critChance: 0, fireRate: 1, range: 2 }, mods: ["Fury", "Reach"],
  });
  assert.equal(build.attack_speed, 1.3);
  assert.equal(build.burst_dps, 130);
  assert.equal(build.range_m, 3.5);
  assert.equal(build.magazine, undefined);
  assert.equal(build.sustained_dps, undefined);
});

test("stances add capacity by polarity and warn on the wrong class", () => {
  const capacityWith = (slot_polarity) => call("weapon_build", {
    weapon: "Skana", stance: { name: "Crimson Dervish", slot_polarity },
  }).mod_capacity;
  assert.equal(capacityWith("madurai").capacity, 70);
  assert.equal(capacityWith("naramon").capacity, 64);
  assert.equal(capacityWith("none").capacity, 65);
  assert.deepEqual(capacityWith("madurai").warnings, []);

  const wrong = call("weapon_build", { weapon: "Nikana Prime", stance: "Crimson Dervish" });
  assert.match(wrong.mod_capacity.warnings[0], /only fits Swords/);
  assert.match(call("weapon_build", { weapon: "Skana", mods: ["Crimson Dervish"] }).error, /pass it as "stance"/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", stance: "Crimson Dervish" }).error, /not melee/);
  assert.match(call("weapon_build", { weapon: "Skana", combo_multiplier: 13 }).error, /1-12/);
});

test("every stance fits a real melee class", () => {
  const weapons = Object.values(call("list_weapons", { type: "melee", limit: 1000 }).results);
  const { mods } = call("search_mods", { category: "stance", limit: 1000 });
  assert.ok(mods.length >= 50);
  const classes = new Set(weapons.map((w) => w.type.toLowerCase().replace(/^staves$/, "staff").replace(/s$/, "")));
  // Bayonet's only weapon is Vinquibus, which WFCD lists as a primary with no melee attacks.
  for (const stance of mods.filter((m) => m.compat !== "Bayonet")) {
    const wanted = stance.compat.toLowerCase().replace(/^staves$/, "staff").replace(/s$/, "");
    assert.ok(classes.has(wanted), `${stance.name} fits no class: ${stance.compat}`);
  }
});

test("Cannonade mods need a semi-auto trigger and fix the fire rate", () => {
  const warnings = (weapon, mods) => call("weapon_build", { weapon, mods }).mod_capacity.warnings;
  assert.match(warnings("Soma Prime", ["Semi-Rifle Cannonade"]).join(" "), /Semi-Auto/);
  assert.deepEqual(warnings("Lex Prime", ["Semi-Pistol Cannonade"]), []);
  const rate = (mods) => call("weapon_build", { weapon: "Lex Prime", mods }).fire_rate;
  assert.ok(rate(["Lethal Torrent"]) > rate([]));
  assert.equal(rate(["Semi-Pistol Cannonade", "Lethal Torrent"]), rate([]));
});

test("wiki tags block mods from the weapons they exclude", () => {
  assert.match(call("weapon_build", { weapon: "Zhuge", mods: ["Split Flights"] }).mod_capacity.warnings.join(" "), /cannot be used/);
});

test("PvP-only mods warn", () => {
  const { mod_capacity: capacity } = call("weapon_build", { weapon: "Vectis", mods: ["Lie In Wait"] });
  assert.match(capacity.warnings.join(" "), /Conclave/);
});

test("with no polarities, every mod goes in a blank slot", () => {
  const { mods, build } = call("suggest_weapon_build", { weapon: "Soma Prime", polarities: [], mods: ["Serration"] });
  assert.ok(mods.every((m) => m.slot_polarity === "none"));
  assert.equal(build.mod_capacity.warnings.length, 0);
});

test("suggestions are legal builds that the calculator agrees with", () => {
  for (const weapon of ["Soma Prime", "Tigris Prime", "Lex Prime", "Nikana Prime", "Lanka"]) {
    const { mods, build, stance } = call("suggest_weapon_build", { weapon });
    assert.ok(mods.length > 0 && mods.length <= 8, weapon);
    assert.deepEqual(build.mod_capacity.warnings, [], weapon);
    assert.ok(build.mod_capacity.used <= build.mod_capacity.capacity, weapon);
    const again = call("weapon_build", { weapon, mods, stance, ...(stance && { combo_multiplier: 12 }) });
    assert.equal(again.burst_dps, build.burst_dps, weapon);
    assert.ok(build.burst_dps > call("weapon_build", { weapon }).burst_dps, weapon);
  }
});

test("suggestions respect exclude, required mods and capacity", () => {
  const names = (result) => result.mods.map((m) => m.name);
  assert.ok(names(call("suggest_weapon_build", { weapon: "Soma Prime" })).includes("Serration"));
  assert.ok(!names(call("suggest_weapon_build", { weapon: "Soma Prime", exclude: ["Serration"] })).includes("Serration"));
  assert.ok(names(call("suggest_weapon_build", { weapon: "Soma Prime", mods: ["Hush"] })).includes("Hush"));

  const small = call("suggest_weapon_build", { weapon: "Soma Prime", catalyst: false, polarities: [] });
  assert.ok(small.build.mod_capacity.used <= 30);
  assert.match(call("suggest_weapon_build", { weapon: "Soma Prime", mods: ["Serration", "Amalgam Serration"] }).error, /do not fit/);
});

test("suggestions find builds a one-step search gets stuck below", () => {
  // Each swaps one costly mod for two cheaper ones, which brute force found and the first search missed.
  const beats = (weapon, goal, mods) => {
    const suggested = call("suggest_weapon_build", { weapon, goal }).build[goal];
    const assigned = mods.map((name) => ({ name, slot_polarity: "none" }));
    const known = call("weapon_build", { weapon, mods: assigned });
    assert.deepEqual(known.mod_capacity.warnings, [], weapon);
    assert.ok(suggested >= known[goal], `${weapon}: ${suggested} < ${known[goal]}`);
  };
  beats("Lex Prime", "sustained_dps", ["Semi-Pistol Cannonade", "Primed Convulsion", "Barrel Diffusion", "Primed Target Cracker", "Creeping Bullseye"]);
  beats("Tigris Prime", "burst_dps", ["Primed Point Blank", "Primed Charged Shell", "Hell's Chamber", "Shotgun Barrage", "Chilling Reload"]);
});

test("melee suggestions chase the goal and combo", () => {
  const heavy = call("suggest_weapon_build", { weapon: "Nikana Prime", goal: "heavy_attack" });
  assert.equal(heavy.goal, "heavy_attack");
  assert.equal(heavy.build.combo_multiplier, 12);
  assert.ok(heavy.build.heavy_attack.average_damage_with_crits > call("suggest_weapon_build", { weapon: "Nikana Prime" }).build.heavy_attack.average_damage_with_crits);
  assert.ok(heavy.stance);

  const dps = call("suggest_weapon_build", { weapon: "Nikana Prime" });
  assert.ok(dps.mods.some((m) => m.name === "Blood Rush"));
  assert.match(call("suggest_weapon_build", { weapon: "Nikana Prime", goal: "sustained_dps" }).error, /no magazine/);
  assert.match(call("suggest_weapon_build", { weapon: "Soma Prime", goal: "heavy_attack" }).error, /not melee/);
  assert.match(call("suggest_weapon_build", { weapon: "Soma Prime", goal: "nope" }).error, /Unknown goal/);
});

test("enemy armor uses the wiki's enemy formula, not the Warframe one", () => {
  const reduction = (armor) => call("weapon_build", { weapon: "Soma Prime", target: { armor } }).target.armor_damage_reduction_pct;
  assert.equal(reduction(0), 0);
  // 90% x sqrt(armor / 2700)
  assert.equal(reduction(300), 30);
  assert.equal(reduction(900), 51.96);
  assert.equal(reduction(2700), 90);
  assert.equal(reduction(3000), round((3000 / 3300) * 100));
});

test("targets apply faction multipliers and armor per damage type", () => {
  const gun = { ...GUN, damage: { impact: 100, slash: 100 }, critChance: 0 };
  const build = call("weapon_build", { weapon: "Soma Prime", base_stats: gun, target: { faction: "Grineer", armor: 300 } });
  // Grineer take x1.5 Impact, and 300 armor removes 30% of everything.
  assert.equal(build.target.damage_by_type.impact, 105);
  assert.equal(build.target.damage_by_type.slash, 70);
  assert.equal(build.target.damage_per_shot, 175);
  assert.equal(build.target.burst_dps, 175 * 15);
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { faction: "Nobody" } }).error, /Unknown faction/);
});

test("faction mods count only against their faction", () => {
  const gun = { ...GUN, damage: { slash: 100 } };
  const shot = (faction) => call("weapon_build", { weapon: "Soma Prime", base_stats: gun, mods: ["Bane Of Grineer"], target: { faction } }).target.damage_per_shot;
  assert.equal(shot("Grineer"), 130);
  assert.equal(shot("Kuva Grineer"), 130);
  assert.equal(shot("Corpus"), 100);
});

test("status follows the wiki's proc and tick formulas", () => {
  // The wiki's example: 40 base damage with +60% Heat ticks for (40 + 1) x 0.5 x 1.6 = 32.8.
  const supra = call("weapon_build", {
    weapon: "Soma Prime", base_stats: { ...GUN, damage: { impact: 40 }, critChance: 0, statusChance: 100, fireRate: 1 }, mods: ["Thermite Rounds"],
  });
  assert.equal(supra.status.by_type.heat.tick_damage, 32.8);
  // Its proc share follows damage: 24 of 64.
  assert.equal(supra.status.by_type.heat.proc_chance_pct, 37.5);
  // Thermite Rounds also adds 60% status chance.
  assert.equal(supra.status.procs_per_second, 1.6);
  assert.equal(supra.status.by_type.heat.dps, round(1.6 * 0.375 * 32.8 * 6));

  // The wiki's proc table: 20 Impact, 5 Puncture, 10 Slash and 25 Heat out of 60.
  const shares = call("weapon_build", { weapon: "Soma Prime", base_stats: { ...GUN, damage: { impact: 20, puncture: 5, slash: 10, heat: 25 } } }).status.by_type;
  assert.equal(shares.impact.proc_chance_pct, 33.33);
  assert.equal(shares.heat.proc_chance_pct, 41.67);
  // Slash uses 0.35, and multishot adds procs without changing the chance per pellet.
  const slash = call("weapon_build", {
    weapon: "Soma Prime", base_stats: { ...GUN, damage: { slash: 99 }, critChance: 0, statusChance: 50, fireRate: 1, pellets: 2 },
  }).status;
  assert.equal(slash.procs_per_second, 1);
  assert.equal(slash.by_type.slash.tick_damage, 35);
});

test("damage over time matches the wiki's faction examples", () => {
  // (40 x 1.55 + 1) x 0.35 x 1.55 = 34.18, and (40 x 1.55 + 1) x 0.5 x 3.25 x 1.55 = 158.68.
  const gun = { ...GUN, damage: { slash: 20, toxin: 20 }, critChance: 0, statusChance: 100, fireRate: 1 };
  const ticks = call("weapon_build", {
    weapon: "Soma Prime", base_stats: gun, mods: ["Primed Bane of Orokin"], extra_effects: { toxin: 225 }, target: { faction: "Orokin" },
  }).status.by_type;
  assert.equal(ticks.slash.tick_damage, 34.18);
  assert.equal(ticks.toxin.tick_damage, 158.68);
});

test("every attack uses its own pellet count, and explosions count with their impact", () => {
  assert.equal(call("weapon_build", { weapon: "Boar Prime", attack: "Incarnon Form" }).pellets_or_multishot, 1);
  assert.equal(call("weapon_build", { weapon: "Boar Prime" }).pellets_or_multishot, 8);
  assert.equal(call("weapon_build", { weapon: "Kohm" }).pellets_or_multishot, 12);
  assert.equal(call("weapon_build", { weapon: "Kohm", attack: "Single Pellet" }).pellets_or_multishot, 1);
  const ogris = call("weapon_build", { weapon: "Ogris" });
  const blast = call("weapon_build", { weapon: "Ogris", attack: "Rocket Explosion" });
  assert.equal(ogris.linked_attacks[0].attack, "Rocket Explosion");
  assert.equal(ogris.burst_dps, round(ogris.linked_attacks[0].burst_dps + (ogris.damage_per_trigger * ogris.average_crit_multiplier * ogris.fire_rate)));
  assert.ok(ogris.burst_dps > blast.burst_dps);
  assert.equal(call("weapon_build", { weapon: "Soma Prime" }).linked_attacks, undefined);
  // Several parts of one shot all count.
  assert.deepEqual(call("weapon_build", { weapon: "Lenz" }).linked_attacks.map((a) => a.attack), ["Initial Blast", "Bubble Collapse"]);
  assert.equal(call("weapon_build", { weapon: "Proboscis Cernos" }).linked_attacks.length, 2);
  // Alternatives and weak point bonuses don't.
  assert.equal(call("weapon_build", { weapon: "Castanas" }).linked_attacks, undefined);
  assert.equal(call("weapon_build", { weapon: "Vectis Prime", attack: "Incarnon Form" }).linked_attacks, undefined);
  assert.equal(call("weapon_build", { weapon: "Artemis Bow", attack: "Concentrated Arrow Charged Shot" }).linked_attacks, undefined);
  assert.ok(call("weapon_build", { weapon: "Staticor" }).linked_attacks.length === 1);
  // The explosion shares the main attack's reload downtime.
  const staticor = call("weapon_build", { weapon: "Staticor" });
  const main = call("weapon_build", { weapon: "Staticor", base_stats: { damage: call("list_weapons", { query: "Staticor" }).results.Staticor.modes[0].damage } });
  assert.ok(Math.abs(staticor.sustained_dps / staticor.burst_dps - main.sustained_dps / main.burst_dps) < 0.001);
  // Explosions count towards status totals.
  assert.ok(call("weapon_build", { weapon: "Kuva Tonkor", mods: ["High Voltage", "Hellfire"] }).status.damage_over_time_dps > 0);
});

test("elements from outside mods add to the same element on a mod", () => {
  const build = call("weapon_build", { weapon: "Soma Prime", base_stats: GUN, mods: ["Hellfire"], extra_effects: { heat: 90 } });
  assert.equal(build.damage_by_type.heat, 21.6);
});

test("bows use their own value on mods and the plain value elsewhere", () => {
  const rate = (args) => call("weapon_build", { weapon: "Paris Prime", base_stats: { fireRate: 1 }, ...args }).fire_rate;
  assert.equal(rate({ extra_effects: { fireRate: 100 } }), 2);
  assert.equal(rate({ riven: { effects: { fireRate: 100 } } }), 2);
  assert.equal(rate({ mods: ["Speed Trigger"] }), 2.2);
});

test("Condition Overload's bonus reaches its ticks", () => {
  const { status } = call("weapon_build", {
    weapon: "Skana", base_stats: { damage: { slash: 100 }, critChance: 0, statusChance: 100 }, mods: ["Condition Overload"], status_types_on_target: 3,
  });
  assert.equal(status.by_type.slash.tick_damage, 119.35);
});

test("arcanes follow slot limits and their weapon restrictions", () => {
  assert.match(call("weapon_build", { weapon: "Soma Prime", arcanes: ["Primary Merciless", "Primary Deadhead"] }).error, /1 arcane slot/);
  const zaw = { strike: "Balla", grip: "Korb", link: "Jai" };
  assert.deepEqual(call("weapon_build", { zaw, arcanes: ["Melee Influence", "Exodia Brave"] }).mod_capacity.warnings, []);
  assert.deepEqual(call("weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Gibber", loader: "Arcroid" }, arcanes: ["Secondary Deadhead", "Pax Bolt"] }).mod_capacity.warnings, []);
  assert.deepEqual(call("weapon_build", { weapon: "Larkspur", arcanes: ["Primary Merciless"] }).mod_capacity.warnings, []);
  assert.match(call("weapon_build", { weapon: "Deth Machine Rifle", arcanes: ["Primary Merciless"] }).mod_capacity.warnings.join(), /does not apply/);
  // Multi-class restrictions, and ones that exclude the weapon.
  assert.deepEqual(call("weapon_build", { weapon: "Lex Prime", arcanes: ["Arcane Arachne"] }).mod_capacity.warnings, []);
  const plain = call("weapon_build", { weapon: "Soma Prime" });
  const momentum = call("weapon_build", { weapon: "Soma Prime", arcanes: ["Arcane Momentum"], conditionals: true });
  assert.equal(momentum.reload_seconds, plain.reload_seconds);
  assert.match(momentum.mod_capacity.warnings.join(), /does not apply/);
  assert.equal(call("weapon_build", { weapon: "Soma Prime", arcanes: ["Eternal Eradicate"], conditionals: true }).burst_dps, plain.burst_dps);
  const burst = (args) => call("weapon_build", { weapon: "Soma Prime", base_stats: GUN, ...args }).burst_dps;
  assert.equal(burst({ arcanes: ["Arcane Fury"], conditionals: true }), burst({}));
  assert.match(call("weapon_build", { weapon: "Soma Prime", arcanes: ["Arcane Fury"] }).mod_capacity.warnings.join(), /does not apply/);
  assert.ok(call("weapon_build", { weapon: "Skana", base_stats: { damage: { slash: 100 } }, arcanes: ["Arcane Fury"], conditionals: true }).damage_per_shot > 100);
  for (const [weapon, arcane] of [["Soma Prime", "Pax Bolt"], ["Soma Prime", "Longbow Sharpshot"], ["Nikana Prime", "Exodia Brave"]]) {
    assert.match(call("weapon_build", { weapon, arcanes: [arcane] }).mod_capacity.warnings.join(), /does not apply/, arcane);
  }
  assert.match(call("warframe_build", { warframe: "Saryn", arcanes: ["Arcane Grace", "Arcane Grace"] }).error, /same arcane/);
  assert.match(call("warframe_build", { warframe: "Saryn", arcanes: ["Primary Merciless"] }).mod_capacity.warnings.join(), /does not go on/);
});

test("universal polarity matches anything, on frames and stances", () => {
  const capacity = (warframe) => call("warframe_build", { warframe, aura: "Steel Charge" }).mod_capacity.capacity;
  assert.equal(capacity("Protea"), 78);
  assert.equal(capacity("Dante"), 78);
  assert.equal(call("warframe_build", { warframe: "Jade", aura: "Steel Charge", second_aura: { name: "Physique", slot_polarity: "vazarin" } }).mod_capacity.capacity, 92);
  assert.match(call("warframe_build", { warframe: "Saryn", second_aura: "Physique" }).error, /one aura slot/);
  assert.equal(call("weapon_build", { weapon: "Soma Prime", mods: [{ name: "Serration", slot_polarity: "universal" }] }).mod_capacity.drains[0].drain, 7);
});

test("rank 40 capacity and 12 Necramech slots", () => {
  assert.equal(call("weapon_build", { weapon: "Kuva Bramma" }).mod_capacity.capacity, 60);
  assert.equal(call("weapon_build", { weapon: "Kuva Bramma", level: 40 }).mod_capacity.capacity, 80);
  assert.match(call("weapon_build", { weapon: "Soma Prime", level: 40 }).error, /level must be/);
  assert.match(call("warframe_build", { warframe: "Saryn", level: 1 }).error, /level must be/);
  assert.equal(call("warframe_build", { warframe: "Voidrig", level: 40 }).mod_capacity.capacity, 80);
});

test("conflicts ignore case differences between sources", () => {
  const { mod_capacity: capacity } = call("weapon_build", { weapon: "Soma Prime", mods: ["Primed Bane of Grineer", "Bane Of Grineer"] });
  assert.match(capacity.warnings.join(), /conflicts/);
});

test("companions' shields get no damage reduction, and frames without a stat reject its shard", () => {
  const kavat = call("warframe_build", { warframe: "Adarza Kavat", base_stats: { health: 100, shields: 100, armor: 300 } });
  assert.equal(kavat.effective_health, 300);
  assert.match(call("warframe_build", { warframe: "Kullervo", archon_shards: ["shields"] }).error, /no shields/);
});

test("aura effects count on the frame, and suggestions avoid auras that hurt the goal", () => {
  assert.equal(call("warframe_build", { warframe: "Saryn", base_stats: FRAME, aura: "Physique" }).stats.health, 360);
  assert.equal(call("warframe_build", { warframe: "Saryn", aura: "Power Donation" }).abilities.strength, 70);
  assert.notEqual(call("suggest_warframe_build", { warframe: "Protea", goal: "strength" }).aura, "Power Donation");
  assert.notEqual(call("suggest_warframe_build", { warframe: "Excalibur", goal: "range" }).aura, "Power Donation");
  assert.equal(call("suggest_warframe_build", { warframe: "Mag", goal: "efficiency", aura: "Power Donation" }).aura, "Power Donation");
  assert.equal(call("suggest_warframe_build", { warframe: "Jade", goal: "strength", second_aura: "Physique" }).build.mod_capacity.capacity > 78, true);
  assert.match(call("suggest_warframe_build", { warframe: "Inaros", goal: "shields" }).error, /has no shields/);
  assert.match(call("suggest_warframe_build", { warframe: "Hildryn", goal: "energy" }).error, /has no energy/);
});

test("stances and compatibility match the class exactly", () => {
  assert.match(call("weapon_build", { weapon: "Dual Heat Swords", stance: "Crimson Dervish" }).mod_capacity.warnings.join(), /only fits Swords/);
  assert.equal(call("weapon_build", { weapon: "Vinquibus (Melee)", stance: "Harrowing Spire" }).mod_capacity.capacity, 70);
  assert.deepEqual(call("weapon_build", { weapon: "Grimoire", mods: ["Fass Canticle"] }).mod_capacity.warnings, []);
  assert.deepEqual(call("weapon_build", { weapon: "Soma Prime", mods: ["Mending Shot"] }).mod_capacity.warnings, []);
  assert.match(call("suggest_weapon_build", { weapon: "Veritux", goal: "heavy_attack" }).error, /no heavy attack/);
  assert.ok(call("weapon_build", { weapon: "AX-52" }).burst_dps > 0);
});

test("armor reduces elemental ticks but not Bleed", () => {
  const gun = { ...GUN, damage: { slash: 49, heat: 50 }, critChance: 0, statusChance: 100, fireRate: 1 };
  const ticks = call("weapon_build", { weapon: "Soma Prime", base_stats: gun, target: { armor: 2700 } }).status.by_type;
  assert.equal(ticks.slash.tick_damage, 35);
  assert.equal(ticks.heat.tick_damage, 5);
});

test("Zaws match the wiki's stat table", () => {
  const build = call("weapon_build", { zaw: { strike: "Balla", grip: "Korb", link: "Ruhang" } });
  assert.equal(build.damage_per_shot, 266);
  assert.deepEqual(build.damage_by_type, { impact: 13.3, puncture: 159.6, slash: 93.1 });
  assert.equal(build.attack_speed, 0.8); // 0.799, shown to two places
  assert.equal(build.crit_chance_pct, 18);
  assert.equal(build.type, "Dagger");
  const vargeet = call("weapon_build", { zaw: { strike: "Balla", grip: "Korb", link: "Vargeet Jai" } });
  assert.equal(vargeet.crit_chance_pct, 25);
  assert.equal(vargeet.status_chance_pct, 14);
  // Two-handed grips use the strike's factor and its two-handed class.
  const polearm = call("weapon_build", { zaw: { strike: "Dehtat", grip: "Jayap", link: "Jai" } });
  assert.equal(polearm.type, "Polearm");
  assert.equal(polearm.damage_per_shot, round((224 - 4) * 1.09));
  assert.match(call("weapon_build", { zaw: { strike: "Nope", grip: "Korb", link: "Jai" } }).error, /Unknown Zaw strike/);
});

test("Kitguns take stats from their chamber, grip and loader", () => {
  const build = call("weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Gibber", loader: "Arcroid" } });
  assert.deepEqual(build.damage_by_type, { impact: 41, heat: 119 });
  assert.equal(build.fire_rate, 3.17);
  assert.equal(build.magazine, 9);
  assert.equal(build.reload_seconds, 1.5);
  assert.equal(build.crit_chance_pct, 24);
  assert.equal(build.type, "Kitgun");
  const primary = call("weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Brash", loader: "Arcroid" } });
  assert.match(primary.mod_capacity.warnings.join() + call("weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Brash", loader: "Arcroid" }, mods: ["Semi-Rifle Cannonade"] }).mod_capacity.warnings.join(), /cannot be used/);
  assert.match(call("weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Nope", loader: "Arcroid" } }).error, /Unknown Kitgun grip/);
  assert.match(call("weapon_build", {}).error, /exactly one/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", zaw: { strike: "Balla", grip: "Korb", link: "Jai" } }).error, /exactly one/);
});

test("stances give per-combo DPS by the wiki's melee formula", () => {
  const { stance_combos: stance } = call("weapon_build", {
    weapon: "Nikana Prime", base_stats: { damage: { slash: 100 }, critChance: 0, fireRate: 1 }, stance: "Blind Justice",
  });
  const forward = stance.combos.find((c) => c.input === "Forward");
  // 1 + (1 + 2) + (1 + 2 + 3) + 3 = 13 times weapon damage, over 3.05 seconds.
  assert.equal(forward.damage_multiplier, 13);
  assert.equal(forward.seconds, 3.05);
  assert.equal(forward.dps, round((100 * 13) / 3.05));
  assert.ok(stance.best_combo_dps >= forward.dps);
});

test("conditional effects are listed by default and count when asked", () => {
  const off = call("weapon_build", { weapon: "Soma Prime", base_stats: GUN, mods: ["Galvanized Chamber"] });
  assert.equal(off.pellets_or_multishot, 1.8);
  assert.match(JSON.stringify(off.not_calculated), /On Kill/);
  const on = call("weapon_build", { weapon: "Soma Prime", base_stats: GUN, mods: ["Galvanized Chamber"], conditionals: true });
  assert.equal(on.pellets_or_multishot, 1 + 0.8 + 0.3 * 5);
  assert.match(on.conditionals_applied[0], /Galvanized Chamber/);
  assert.doesNotMatch(JSON.stringify(on.not_calculated), /On Kill/);
});

test("per-status mods scale with status types on the target", () => {
  const shot = (status_types_on_target) => call("weapon_build", {
    weapon: "Skana", base_stats: { damage: { slash: 100 } }, mods: ["Condition Overload"], status_types_on_target,
  }).damage_per_shot;
  assert.equal(shot(0), 100);
  assert.equal(shot(3), 340);
});

test("arcanes count their triggered effects at full stacks", () => {
  const gun = { ...GUN, damage: { slash: 100 } };
  assert.equal(call("weapon_build", { weapon: "Soma Prime", base_stats: gun, arcanes: ["Primary Merciless"] }).damage_per_shot, 100);
  const on = call("weapon_build", { weapon: "Soma Prime", base_stats: gun, arcanes: ["Primary Merciless"], conditionals: true });
  assert.equal(on.damage_per_shot, 460); // 100 x (1 + 0.3 x 12)
  const reload = call("weapon_build", { weapon: "Soma Prime", base_stats: { ...gun, reload: 2.6 }, arcanes: [{ name: "Primary Merciless", rank: 5 }] });
  assert.equal(reload.reload_seconds, 2);
  const wrong = call("weapon_build", { weapon: "Lex Prime", arcanes: ["Primary Merciless"] });
  assert.match(wrong.mod_capacity.warnings.join(), /primary arcane/);
  assert.match(call("search_arcanes", { query: "merciless" }).arcanes[0].name, /Merciless/);
});

test("Rivens fill a slot with rolled stats, and extra effects cover outside buffs", () => {
  const riven = call("weapon_build", {
    weapon: "Soma Prime", base_stats: { ...GUN, damage: { slash: 100 } }, riven: { effects: { damage: 100 }, polarity: "madurai", drain: 18, slot_polarity: "madurai" },
  });
  assert.equal(riven.damage_per_shot, 200);
  assert.equal(riven.mod_capacity.used, 9);
  assert.match(call("weapon_build", { weapon: "Soma Prime", riven: { effects: {} }, mods: ["Serration", "Split Chamber", "Vital Sense", "Point Strike", "Hellfire", "Cryo Rounds", "Stormbringer", "Infected Clip"] }).error, /8 regular/);
  const buffed = call("weapon_build", { weapon: "Soma Prime", base_stats: { ...GUN, damage: { slash: 100 } }, extra_effects: { damage: 50 } });
  assert.equal(buffed.damage_per_shot, 150);
});

test("Exalted, Archwing and companion weapons work, with the right mod rules", () => {
  const blade = call("weapon_build", { weapon: "Exalted Blade", mods: ["Blood Rush"] });
  assert.match(blade.mod_capacity.warnings.join(), /cannot be used/);
  assert.match(blade.assumptions, /Ability Strength/);
  assert.deepEqual(call("weapon_build", { weapon: "Exalted Blade", mods: ["Pressure Point"] }).mod_capacity.warnings, []);
  const larkspur = call("weapon_build", { weapon: "Larkspur", mods: ["Rubedo-Lined Barrel"] });
  assert.equal(larkspur.type, "Archgun");
  assert.deepEqual(larkspur.mod_capacity.warnings, []);
  assert.match(call("weapon_build", { weapon: "Larkspur", mods: ["Serration"] }).mod_capacity.warnings.join(), /primary mod/);
  assert.ok(call("weapon_build", { weapon: "Adarza Claws" }).burst_dps > 0);
  assert.ok(call("weapon_build", { weapon: "Deth Machine Rifle", mods: ["Serration"] }).burst_dps > 0);
  assert.equal(Object.keys(call("list_weapons", { type: "archgun", limit: 100 }).results).length >= 15, true);
});

test("Archon Shards add flat stats after mods and percent to abilities", () => {
  const build = call("warframe_build", {
    warframe: "Saryn", base_stats: FRAME, mods: ["Vitality"], archon_shards: ["health", { stat: "strength", tauforged: true }, "strength"],
  });
  assert.equal(build.stats.health, 300 * 2 + 150);
  assert.equal(build.abilities.strength, 125);
  assert.match(call("warframe_build", { warframe: "Saryn", archon_shards: ["luck"] }).error, /Unknown Archon Shard/);
  assert.match(call("warframe_build", { warframe: "Saryn", archon_shards: Array(6).fill("health") }).error, /at most 5/);
});

test("companions, Archwings and Necramechs build with their own mods", () => {
  const kinds = { Itzal: "archwing", Voidrig: "necramech", "Adarza Kavat": "companion", Carrier: "companion" };
  for (const [warframe, kind] of Object.entries(kinds)) {
    const build = call("warframe_build", { warframe });
    assert.equal(build.kind, kind);
    assert.ok(build.stats.health > 0, warframe);
    assert.match(build.assumptions, /stats the sources list/);
  }
  assert.match(call("warframe_build", { warframe: "Itzal", mods: ["Vitality"] }).mod_capacity.warnings.join(), /warframe mod/);
  assert.match(call("warframe_build", { warframe: "Itzal", aura: "Steel Charge" }).error, /Only Warframes/);
  assert.ok(Object.keys(call("list_warframes", { kind: "companion", limit: 100 }).results).length >= 20);
});

test("Warframe suggestions reach goals and targets legally", () => {
  const strength = call("suggest_warframe_build", { warframe: "Saryn", goal: "strength" });
  assert.deepEqual(strength.build.mod_capacity.warnings, []);
  assert.ok(strength.mods.some((m) => m.name === "Blind Rage" || m.name === "Intensify"));
  assert.ok(strength.build.abilities.strength > 150);

  const targeted = call("suggest_warframe_build", { warframe: "Saryn", targets: { efficiency: 175 }, goal: "strength" });
  assert.equal(targeted.build.abilities.efficiency, 175);
  assert.equal(targeted.targets_missed, undefined);
  const impossible = call("suggest_warframe_build", { warframe: "Saryn", targets: { strength: 5000 } });
  assert.equal(impossible.targets_missed[0].stat, "strength");

  const tank = call("suggest_warframe_build", { warframe: "Rhino", goal: { effective_health: 1 } });
  assert.ok(tank.build.effective_health > call("warframe_build", { warframe: "Rhino" }).effective_health);
  assert.ok(!call("suggest_warframe_build", { warframe: "Saryn", goal: "strength", exclude: ["Blind Rage"] }).mods.some((m) => m.name === "Blind Rage"));
  assert.match(call("suggest_warframe_build", { warframe: "Saryn" }).error, /Pass a goal/);
  assert.match(call("suggest_warframe_build", { warframe: "Saryn", goal: "luck" }).error, /Unknown goal/);
  assert.match(call("suggest_warframe_build", { warframe: "Saryn", goal: { luck: 1 } }).error, /Unknown stat/);
});

test("Forma lets suggestions fit more, and lists what to add", () => {
  const without = call("suggest_warframe_build", { warframe: "Saryn", goal: "strength", polarities: [] });
  const withForma = call("suggest_warframe_build", { warframe: "Saryn", goal: "strength", polarities: [], forma: 3 });
  assert.equal(withForma.forma_to_add.length, 3);
  assert.deepEqual(withForma.build.mod_capacity.warnings, []);
  assert.ok(withForma.build.abilities.strength >= without.build.abilities.strength);
  assert.match(call("suggest_weapon_build", { weapon: "Soma Prime", forma: 99 }).error, /forma/);
});

test("weapon suggestions adapt to the target", () => {
  const onGrineer = (mods) => call("weapon_build", { weapon: "Soma Prime", mods, target: { faction: "Grineer", armor: 500 } }).target.sustained_dps;
  const raw = call("suggest_weapon_build", { weapon: "Soma Prime" });
  const aimed = call("suggest_weapon_build", { weapon: "Soma Prime", target: { faction: "Grineer", armor: 500 } });
  assert.deepEqual(aimed.build.mod_capacity.warnings, []);
  assert.ok(aimed.build.target.sustained_dps >= onGrineer(raw.mods));
  const status = call("suggest_weapon_build", { weapon: "Soma Prime", goal: "status_dps" });
  assert.ok(status.build.status.damage_over_time_dps > raw.build.status.damage_over_time_dps);
  const zaw = call("suggest_weapon_build", { zaw: { strike: "Balla", grip: "Korb", link: "Jai" } });
  assert.ok(zaw.mods.length > 0);
  assert.deepEqual(zaw.build.mod_capacity.warnings, []);
  // The wiki blocks rifle Cannonades on Kitguns, but not the pistol one.
  const kitgun = call("suggest_weapon_build", { kitgun: { chamber: "Catchmoon", grip: "Brash", loader: "Arcroid" } });
  assert.deepEqual(kitgun.build.mod_capacity.warnings, []);
  assert.ok(!kitgun.mods.some((m) => /Cannonade/.test(m.name)));
});

test("names forgive case, punctuation and typos", () => {
  assert.equal(call("weapon_build", { weapon: "soma prime" }).weapon, "Soma Prime");
  assert.equal(call("weapon_build", { weapon: "Tigris Prime", mods: ["hells chamber"] }).mod_capacity.drains[0].mod, "Hell's Chamber");
  assert.match(call("weapon_build", { weapon: "Somma Prim" }).error, /Did you mean: Soma Prime/);
});

test("bad input gets a clear error instead of a wrong answer", () => {
  assert.match(call("weapon_build", { weapon: "Soma Prime", modz: [] }).error, /Unknown argument: modz/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", mods: "Serration" }).error, /must be of type array/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", mods: [{ name: "Serration", rank: 1.5 }] }).error, /whole number/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", mods: [{ name: "Serration", slot_polarity: "blue" }] }).error, /Unknown polarity/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", mods: [7] }).error, /must be a name/);
  assert.match(call("warframe_build", {}).error, /Missing required argument: warframe/);
  assert.match(call("list_modular_parts", { kind: "gun" }).error, /must be one of/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { faction: 3 } }).error, /faction name/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { armor: -1 } }).error, /0 or more/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", riven: { effects: { crit_chance: 200 } } }).error, /Unknown Riven effect/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", extra_effects: { critical_chance: 200 } }).error, /Unknown extra effect/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", extra_effects: { damage: "x" } }).error, /must be a number/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", base_stats: { crit_chance: 90 } }).error, /Unknown base stat/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", mods: [{ name: "Serration", ranks: 0 }] }).error, /Unknown mod field/);
  assert.equal(call("weapon_build", { weapon: "Soma Prime", base_stats: { damage: { Slash: 100 } }, mods: ["Sawtooth Clip"] }).damage_by_type.slash, 190);
  assert.equal(call("weapon_build", { weapon: "Soma Prime", riven: { effects: {}, polarity: "Madurai", slot_polarity: "madurai", drain: 18 } }).mod_capacity.used, 9);
});

test("the protocol answers bad requests and stays quiet for notifications", () => {
  const input = [
    "not json",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "data_info", arguments: [] } }),
    JSON.stringify([1, 2]),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
  ].join("\n") + "\n";
  const { stdout } = spawnSync(process.execPath, [server], { input, encoding: "utf8" });
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies.length, 6);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].error.code, -32601);
  assert.equal(replies[2].result.isError, true);
  assert.equal(replies[3].result.isError, true);
  assert.equal(replies[4].error.code, -32600);
  assert.deepEqual(replies[5].result, {});
});

test("data_info reports coverage", () => {
  const info = call("data_info", {});
  assert.ok(info.coverage.weapons >= 650);
  assert.ok(info.coverage.factions.includes("Grineer"));
  assert.match(info.data, /imported/);
});

test("the Lua parser reads the tables the wiki uses", () => {
  const parsed = parseLuaAfter(`-- a comment
    return { a = 1, ["b c"] = "x -- y", list = { 1, 2.5, -3 }, nested = { ok = true, no = false, gone = nil, inf = math.huge }, --[[ block ]] typo = Knockdown, }`, "return");
  assert.deepEqual(parsed, { a: 1, "b c": "x -- y", list: [1, 2.5, -3], nested: { ok: true, no: false, gone: undefined, inf: Infinity }, typo: undefined });
  assert.throws(() => parseLuaAfter("x = 1", "return"), /has no/);
});

test("unknown names return a helpful tool error", () => {
  assert.match(call("warframe_build", { warframe: "Nobody" }).error, /Unknown warframe/);
  assert.match(call("weapon_build", { weapon: "Soma Primer" }).error, /Did you mean/);
});

function round(n) {
  return Math.round(n * 100) / 100;
}

test("enemy levels scale armor by the wiki's formula", async () => {
  const { armorAtLevel } = await import("./lib/target.mjs");
  const armorOf = (target) => call("weapon_build", { weapon: "Soma Prime", target }).target;
  // The scaling page's own figures: base armor 100 from base level 1.
  assert.ok(Math.abs(armorAtLevel(100, 1, 100) - 1356) < 1);
  assert.ok(Math.abs(armorAtLevel(100, 1, 75) - 1061) < 1);
  assert.equal(armorAtLevel(10, 1, 1), 200, "the floor");
  assert.equal(armorAtLevel(0, 1, 500), 0, "no armor stays none");
  assert.equal(armorAtLevel(500, 8, 1000), 2700, "the cap");
  const gunner = armorOf({ enemy: "Heavy Gunner", level: 50 });
  assert.equal(gunner.enemy, "Heavy Gunner");
  assert.equal(gunner.faction, "Grineer");
  assert.equal(gunner.armor, Math.round(armorAtLevel(500, 8, 50) * 100) / 100);
  assert.equal(armorOf({ enemy: "Heavy Gunner", level: 50, steel_path: true }).level, 150);
  assert.equal(armorOf({ enemy: "Heavy Gunner", level: 150 }).armor, 2700);
  assert.equal(armorOf("Heavy Gunner").level, 8, "plain text, at the enemy's base level");
  assert.equal(armorOf("Grineer").faction, "Grineer");
  assert.equal(armorOf({ enemy: "Heavy Gunner", armor: 100 }).armor, 100, "an explicit armor wins");
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { faction: "Grineer", level: 100 } }).error, /named enemy/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { nope: 1 } }).error, /Unknown target field/);
  assert.equal(call("list_enemies", { query: "Heavy Gunner", level: 150, limit: 1 }).results["Heavy Gunner"].armor_at_level, 2700);
  assert.equal(call("suggest_weapon_build", { weapon: "Soma Prime", target: { enemy: "Heavy Gunner", level: 150 } }).build.target.armor, 2700);
});

test("lookups understand how people shorten names", () => {
  assert.equal(call("weapon_build", { weapon: "Bramma" }).weapon, "Kuva Bramma");
  assert.equal(call("weapon_build", { weapon: "ramma" }).error?.startsWith("Unknown weapon"), true);
  assert.match(call("weapon_build", { weapon: "Prime" }).error, /matches several/);
  assert.equal(call("weapon_build", { weapon: "Torid Incarnon" }).attack, "Incarnon Form");
  assert.equal(call("weapon_build", { weapon: "Felarx", attack: "Incarnon" }).attack, "Incarnon Form");
  assert.equal(call("suggest_weapon_build", { weapon: "Torid Incarnon" }).build.attack, "Incarnon Form");
  assert.equal(call("weapon_build", { weapon: "Soma Prime", target: { faction: "Murmur" } }).target.faction, "The Murmur");
  assert.equal(call("weapon_build", { weapon: "Skana", mods: ["CO"] }).mod_capacity.drains[0].mod, "Condition Overload");
  assert.match(call("warframe_build", { warframe: "Saryn", mods: ["Serration"] }).error, /Serration is a primary mod/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", riven: { effects: { "critical chance": 100 } } }).error, /Use: .*critChance/);
  assert.match(call("weapon_build", { weapon: "Soma Prime", extra_effects: { strength: 50 } }).error, /Use: .*damage/);
  assert.equal(call("suggest_warframe_build", { warframe: "Mesa", goal: "survivability" }).goal, "effective_health");
  assert.ok(call("suggest_warframe_build", { warframe: "Wisp", targets: { ability_strength: 130 } }).build.abilities.strength >= 130);
  assert.match(call("suggest_warframe_build", { warframe: "Saryn" }).error, /explore_synergies/);
  assert.equal(call("suggest_weapon_build", { weapon: "Soma Prime", goal: "dps" }).goal, "sustained_dps");
  assert.equal(call("suggest_weapon_build", { weapon: "Soma Prime", goal: "status" }).goal, "status_dps");
});

test("build problems are at the top of a result, and lists stay short", () => {
  const twice = call("weapon_build", { weapon: "Soma Prime", mods: ["Serration", "Serration"] });
  assert.equal(Object.keys(twice)[0], "warnings");
  assert.match(twice.warnings[0], /cannot be equipped together/);
  assert.equal(Object.keys(call("warframe_build", { warframe: "Saryn", mods: ["Intensify", "Umbral Intensify"] }))[0], "warnings");
  const rifles = call("list_weapons", { type: "Rifle" });
  assert.ok(JSON.stringify(rifles).length < 6000);
  assert.ok(call("list_weapons", { query: "Soma Prime" }).results["Soma Prime"].modes, "a close match has everything");
  assert.ok(!call("list_warframes", { query: "" }).results.Saryn?.abilityText);
  const [init] = session({ method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(init.result.protocolVersion, "2025-11-25", "never claims a version it does not know");
});

test("explore_synergies gathers text to reason from", () => {
  const saryn = call("explore_synergies", { warframe: "Saryn", theme: "status", limit: 5 });
  assert.match(saryn.abilities[0].text, /Corrosive/);
  assert.ok(saryn.passive);
  assert.ok(saryn.augments.some((m) => m.name === "Contagion Cloud"));
  assert.ok(saryn.augments.every((m) => m.text?.length || m.effects));
  assert.equal(saryn.matching_mods.length, 5);
  assert.ok(saryn.matching_arcanes.every((a) => ["warframe", "arcane"].includes(a.type)));
  assert.ok(saryn.damage_types_in_abilities.includes("viral"));
  assert.equal(call("explore_synergies", { warframe: "Saryn Prime" }).augments.length, saryn.augments.length, "Primes share augments");
  const gun = call("explore_synergies", { weapon: "Torid", theme: "status" });
  assert.equal(gun.kind, "primary");
  assert.ok(gun.matching_arcanes.every((a) => a.type === "primary"));
  assert.ok(call("explore_synergies", { weapon: "Nikana Prime", theme: "heavy" }).stances.length > 0);
  assert.match(call("explore_synergies", {}).error, /Pass warframe/);
  assert.match(call("explore_synergies", { warframe: "Saryn", weapon: "Soma" }).error, /Pass warframe/);
  for (const subject of [{ warframe: "Carrier Prime" }, { warframe: "Itzal" }, { warframe: "Voidrig" }, { zaw: { strike: "Balla", grip: "Korb", link: "Jai" } }]) {
    assert.ok(!call("explore_synergies", subject).error, JSON.stringify(subject));
  }
});

test("the profile changes suggestions, survives restarts and hides the token", () => {
  const start = call("get_profile", {});
  assert.equal(start.mods_mode, "assume_all");
  assert.equal(start.alecaframe_connected, false);
  const before = call("suggest_warframe_build", { warframe: "Saryn", goal: "strength" });
  assert.ok(before.mods.some((m) => m.name === "Blind Rage"));
  const updated = call("update_profile", { add_missing_mods: ["blind rage", "Serration"], alecaframe_public_token: "secret-token", notes: "Likes Saryn" });
  assert.deepEqual(updated.missing_mods, ["Blind Rage", "Serration"]);
  assert.equal(updated.alecaframe_connected, true);
  assert.ok(!JSON.stringify(updated).includes("secret-token"));
  assert.ok(!JSON.stringify(call("get_profile", {})).includes("secret-token"));
  const after = call("suggest_warframe_build", { warframe: "Saryn", goal: "strength" });
  assert.ok(!after.mods.some((m) => m.name === "Blind Rage"));
  assert.equal(after.profile_applied.mods_marked_missing, 1, "only the mods for this kind of item");
  assert.ok(call("suggest_warframe_build", { warframe: "Saryn", goal: "strength", use_profile: false }).mods.some((m) => m.name === "Blind Rage"));
  assert.ok(!call("suggest_weapon_build", { weapon: "Soma Prime" }).mods.some((m) => m.name === "Serration"));
  call("update_profile", { add_owned_mods: ["Serration", "Vital Sense"], mods_mode: "owned_only" });
  const limited = call("suggest_weapon_build", { weapon: "Soma Prime" });
  assert.deepEqual(limited.mods.map((m) => m.name).sort(), ["Serration", "Vital Sense"]);
  assert.ok(call("explore_synergies", { weapon: "Soma Prime" }).matching_mods.every((m) => ["Serration", "Vital Sense"].includes(m.name)));
  assert.match(call("update_profile", { add_owned_mods: ["Not A Mod"] }).error, /Unknown mod/);
  assert.match(call("update_profile", { rivens: { Soma: { effects: { nonsense: 1 } } } }).error, /Unknown Riven effect/);
  assert.equal(call("update_profile", { rivens: { "Soma Prime": { effects: { critChance: 100 } } } }).rivens["Soma Prime"].effects.critChance, 100);
  assert.equal(statSync(join(home, "profile.json")).mode & 0o777, process.platform === "win32" ? statSync(join(home, "profile.json")).mode & 0o777 : 0o600);

  assert.match(call("save_build", { name: "x", tool: "weapon_build", arguments: { weapon: "Nope" } }).error, /Unknown weapon/);
  assert.equal(call("save_build", { name: "Soma", tool: "weapon_build", arguments: { weapon: "Soma Prime", mods: ["Serration"] }, notes: "n" }).saved, "Soma");
  assert.equal(call("get_profile", {}).saved_builds.Soma.notes, "n");
  assert.match(call("delete_saved_build", { name: "Nope" }).error, /No saved build/);
  assert.equal(call("delete_saved_build", { name: "Soma" }).deleted, "Soma");

  writeFileSync(join(home, "profile.json"), "{ not json");
  assert.match(call("get_profile", {}).error, /not valid JSON/);
  assert.match(call("update_profile", { notes: "x" }).error, /not valid JSON/);
  assert.equal(readFileSync(join(home, "profile.json"), "utf8"), "{ not json", "a damaged file is left alone");
  rmSync(join(home, "profile.json"));
});

test("network tools say plainly when they are off or not set up", () => {
  assert.match(call("market_price", { item: "Serration" }).error, /OFFLINE/);
  assert.match(call("sell_advice", {}).error, /Nothing to check/);
  assert.match(call("alecaframe_account", {}).error, /not connected/);
});

test("AlecaFrame's documented relic format is read correctly", async () => {
  const { parseRelicInventory } = await import("./lib/alecaframe.mjs");
  const buffer = Buffer.alloc(4 + 18);
  buffer.writeUInt32LE(2, 0);
  buffer[4] = 0; buffer[5] = 3; buffer.write("L1\0", 6, "latin1"); buffer.writeUInt32LE(7, 9);
  buffer[13] = 3; buffer[14] = 0; buffer.write("B21", 15, "latin1"); buffer.writeUInt32LE(1, 18);
  assert.deepEqual(parseRelicInventory(buffer), [
    { relic: "Lith L1", refinement: "Radiant", count: 7 },
    { relic: "Axi B21", refinement: "Intact", count: 1 },
  ]);
  assert.throws(() => parseRelicInventory(Buffer.alloc(2)), /too short/);
  const lying = Buffer.alloc(4);
  lying.writeUInt32LE(5, 0);
  assert.throws(() => parseRelicInventory(lying), /shorter than/);
});

test("only sane, newer game data replaces what is bundled", async () => {
  const { acceptDownload, newerVersion } = await import("./lib/update.mjs");
  const { data } = await import("./lib/data.mjs");
  const newer = { ...data, meta: { ...data.meta, imported: "2999-01-01" } };
  assert.equal(acceptDownload(newer), true);
  assert.equal(acceptDownload(data), false, "not newer");
  assert.equal(acceptDownload({ ...newer, meta: { ...newer.meta, format: 999 } }), false, "code can't read it");
  assert.equal(acceptDownload({ ...newer, weapons: {} }), false, "damaged");
  assert.equal(acceptDownload(null), false);
  assert.equal(newerVersion("1.10.0", "1.9.0"), true);
  assert.equal(newerVersion("1.1.0", "1.1.0"), false);

  writeFileSync(join(home, "data.json"), JSON.stringify({ ...newer, meta: { ...newer.meta, sources: ["a test"] } }));
  assert.equal(call("data_info", {}).data, "imported 2999-01-01");
  writeFileSync(join(home, "data.json"), "{ damaged");
  assert.equal(call("data_info", {}).data, `imported ${data.meta.imported}`);
  rmSync(join(home, "data.json"));
});

test("every package states the same version", () => {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;
  const version = read("./package.json");
  assert.equal(read("./manifest.json"), version);
  assert.equal(read("./.claude-plugin/plugin.json"), version);
});

test("what the trial builds exposed stays fixed", () => {
  // A mod that began in Conclave but works everywhere must be usable.
  assert.ok(!call("warframe_build", { warframe: "Mesa", exilus: "Mesa's Waltz" }).warnings.some((w) => /Conclave/.test(w)));
  assert.ok(call("explore_synergies", { warframe: "Mesa" }).augments.some((m) => m.name === "Mesa's Waltz"));

  // Exalted weapons are linked, and ability scaling is there to reason from.
  const mesa = call("explore_synergies", { warframe: "Mesa Prime", theme: "tank peacemaker" });
  assert.deepEqual(mesa.exalted_weapons, ["Regulators Prime"]);
  assert.ok(call("explore_synergies", { warframe: "Khora" }).exalted_weapons.includes("Whipclaw"));
  const saryn = call("explore_synergies", { warframe: "Saryn", theme: "spore nuke" });
  assert.match(saryn.abilities[0].scaling.strength, /initial damage/);
  assert.ok(!saryn.passive.includes("#"));

  // Ranking puts what raises the stat first, and off-topic text last.
  const strength = call("explore_synergies", { warframe: "Saryn", theme: "strength", limit: 8 }).matching_mods.map((m) => m.name);
  assert.ok(strength.includes("Intensify") && strength.includes("Blind Rage"));
  assert.ok(!strength.includes("Motus Signal"));
  assert.ok(!call("explore_synergies", { weapon: "Torid", theme: "status" }).matching_arcanes.some((a) => a.text.join(" ").includes("chance to resist")));

  // Mods the game wouldn't accept can't inflate a result.
  const clean = call("weapon_build", { weapon: "Nikana Prime", mods: ["Pressure Point"] });
  const wrong = call("weapon_build", { weapon: "Nikana Prime", mods: ["Pressure Point", "Point Blank", "Serration"] });
  assert.equal(wrong.damage_per_shot, clean.damage_per_shot);
  assert.deepEqual(wrong.ignored_mods.map((m) => m.mod), ["Point Blank", "Serration"]);
  assert.equal(wrong.mod_capacity.used, clean.mod_capacity.used);
  assert.match(wrong.warnings.join(" "), /left out of these numbers/);
  assert.equal(call("warframe_build", { warframe: "Saryn", mods: ["Mesa's Waltz"] }).ignored_mods[0].mod, "Mesa's Waltz");

  // A limited list explains itself.
  const limited = call("suggest_weapon_build", { weapon: "Nikana Prime", only_mods: ["Pressure Point", "True Steel", "Point Blank", "Serration"], use_profile: false });
  assert.deepEqual(limited.mods.map((m) => m.name).sort(), ["Pressure Point", "True Steel"]);
  assert.deepEqual(limited.only_mods_not_usable.sort(), ["Point Blank", "Serration"]);
  assert.equal(limited.empty_slots, 6);
  assert.match(call("suggest_weapon_build", { weapon: "Soma Prime", only_mods: ["Not A Mod"] }).error, /Unknown mod/);
  assert.equal(call("suggest_weapon_build", { weapon: "Skana", only_mods: ["CO"], status_types_on_target: 2 }).mods[0].name, "Condition Overload");
  assert.match(call("suggest_weapon_build", { weapon: "Nikana Prime" }).assumptions, /combo_multiplier: 12/);

  // Incarnon Forms aren't judged on ammo the sources don't have.
  const torid = call("suggest_weapon_build", { weapon: "Torid Incarnon" });
  assert.equal(torid.goal, "burst_dps");
  assert.match(torid.build.assumptions, /Incarnon Forms have their own ammo/);

  // Armor strip, unarmored enemies and spawn levels.
  assert.equal(call("weapon_build", { weapon: "Soma Prime", target: { armor: 1000, armor_strip: 50 } }).target.armor, 500);
  assert.match(call("weapon_build", { weapon: "Soma Prime", target: { armor: 1, armor_strip: 101 } }).error, /armor_strip/);
  assert.equal(call("weapon_build", { weapon: "Soma Prime", target: "Crewman" }).target.armor, 0);

  // Searches ignore punctuation, as lookups do.
  assert.ok(call("search_mods", { query: "hells chamber" }).total >= 1);
  assert.ok(call("list_weapons", { query: "Kuva-Bramma" }).total >= 1);
});

test("special property names can't slip through", () => {
  assert.match(call("data_info", { constructor: 1 }).error, /Unknown argument/);
  assert.match(call("save_build", { name: "__proto__", tool: "weapon_build", arguments: { weapon: "Soma Prime" } }).error, /can't be used/);
  assert.match(call("update_profile", { spare_items: JSON.parse('{"__proto__": 1}') }).error, /can't be used/);
  assert.match(call("suggest_warframe_build", { warframe: "Saryn", targets: JSON.parse('{"__proto__": 100}') }).error, /Unknown stat/);
  assert.ok(!call("explore_synergies", { warframe: "Saryn", theme: "constructor" }).error);
  assert.match(call("save_build", { name: "x", tool: "weapon_build", arguments: { weapon: "Soma Prime", modz: [] } }).error, /Unknown argument/);
  rmSync(join(home, "profile.json"), { force: true });
});

test("a saved nickname still warns before selling", async () => {
  const { usedInSavedBuilds } = await import("./lib/profile.mjs");
  const profile = { saved_builds: { Skana: { arguments: { mods: ["CO"] } } } };
  assert.deepEqual(usedInSavedBuilds(profile, "Condition Overload"), ["Skana"]);
});

test("the process ends soon after the client goes away", () => {
  const started = Date.now();
  const { status } = spawnSync(process.execPath, [server], { input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`, env: process.env });
  assert.equal(status, 0);
  assert.ok(Date.now() - started < 3000);
});
