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

test("warframe_build adds mods to base stats and ability stats", () => {
  const build = call("warframe_build", { warframe: "saryn", mods: ["Vitality", "Blind Rage", "Streamline"] });
  assert.equal(build.stats.health, 740);
  assert.equal(build.abilities.strength, 199);
  assert.equal(build.abilities.efficiency, 75);
  assert.equal(build.abilities.ability_cost_multiplier, 1.25);
});

test("efficiency is capped at 175%", () => {
  const build = call("warframe_build", { warframe: "rhino", mods: ["Streamline", "Fleeting Expertise"] });
  assert.equal(build.abilities.efficiency, 175);
  assert.equal(build.abilities.ability_cost_multiplier, 0.25);
});

test("polarity changes drain, and an aura adds capacity", () => {
  const { mod_capacity: matched } = call("warframe_build", {
    warframe: "rhino",
    aura: { name: "Steel Charge", slot_polarity: "madurai" },
    mods: [{ name: "Intensify", slot_polarity: "madurai" }, { name: "Vitality", slot_polarity: "madurai" }],
  });
  assert.equal(matched.capacity, 78);
  assert.equal(matched.drains[0].drain, 6);
  assert.equal(matched.drains[1].drain, 15);
});

test("mod variants conflict and overspending warns", () => {
  const { mod_capacity: capacity } = call("warframe_build", {
    warframe: "rhino",
    reactor: false,
    mods: ["Flow", "Primed Flow", "Blind Rage"],
  });
  assert.equal(capacity.capacity, 30);
  assert.equal(capacity.warnings.length, 2);
});

test("weapon_build combines elements in mod order and computes DPS", () => {
  const build = call("weapon_build", {
    weapon: "Soma Prime",
    mods: ["Serration", "Hellfire", "Infected Clip", "Stormbringer"],
  });
  assert.deepEqual(build.elements_pct, { gas: 180, electricity: 90 });
  assert.equal(build.damage_per_shot, 117.66);
  // 12 base x 2.65 Serration x 3.7 elements x 1.6 average crit x 15 fire rate
  assert.equal(build.burst_dps, 2823.84);
});

test("unknown names return a tool error", () => {
  assert.match(call("warframe_build", { warframe: "Nobody" }).error, /Unknown warframe/);
});
