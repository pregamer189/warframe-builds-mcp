// Starts a packaged server with almost no environment, as an app would, and checks that it answers. Used by CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requests = [
  { method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { method: "tools/list" },
  { method: "tools/call", params: { name: "build_guide", arguments: {} } },
];
const input = requests.map((r, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...r })).join("\n") + "\n";
const env = { WARFRAME_BUILDS_HOME: mkdtempSync(join(tmpdir(), "warframe-builds-check-")), WARFRAME_BUILDS_OFFLINE: "1", SYSTEMROOT: process.env.SYSTEMROOT };
const { stdout, stderr, status } = spawnSync(process.execPath, [process.argv[2]], { input, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
assert.equal(status, 0, stderr);
const [init, list, guide] = stdout.trim().split("\n").map((line) => JSON.parse(line));
assert.ok(init.result.serverInfo.version);
assert.ok(list.result.tools.some((tool) => tool.name === "warframe_build"));
assert.equal(JSON.parse(guide.result.content[0].text).first_time, true);
console.log(`Server ${init.result.serverInfo.version} answers with ${list.result.tools.length} tools.`);
