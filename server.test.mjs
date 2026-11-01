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
    "list_warframes", "list_weapons", "search_mods", "warframe_build", "weapon_build",
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
  assert.ok(weapons.length >= 300);
  for (const [name, build] of sweep("weapon_build", "weapon", weapons)) {
    assert.ok(build.burst_dps > 0 && build.sustained_dps > 0, `${name} has bad DPS`);
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

test("unknown names return a helpful tool error", () => {
  assert.match(call("warframe_build", { warframe: "Nobody" }).error, /Unknown warframe/);
  assert.match(call("weapon_build", { weapon: "Soma Primer" }).error, /Did you mean/);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
