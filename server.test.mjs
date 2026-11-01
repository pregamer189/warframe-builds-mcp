import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

function session(...requests) {
  const input = requests.map((r, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...r })).join("\n") + "\n";
  const { stdout } = spawnSync(process.execPath, [server], { input, encoding: "utf8" });
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
    "list_warframes", "list_weapons", "search_mods", "warframe_build", "weapon_build", "suggest_weapon_build",
  ]);
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

  const weaponData = call("list_weapons", { limit: 1000 }).results;
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
  assert.ok(mods.length >= 60);
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
  const { mod_capacity: capacity } = call("weapon_build", { weapon: "Soma Prime", mods: ["Lie In Wait"] });
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

test("unknown names return a helpful tool error", () => {
  assert.match(call("warframe_build", { warframe: "Nobody" }).error, /Unknown warframe/);
  assert.match(call("weapon_build", { weapon: "Soma Primer" }).error, /Did you mean/);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
