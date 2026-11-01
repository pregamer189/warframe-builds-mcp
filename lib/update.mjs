// Keeps game data fresh between releases. Only JSON is downloaded, so this can never change what code runs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_FORMAT, HOME, data, usableData } from "./data.mjs";
import { offline, request } from "./online.mjs";

const RELEASE = "https://raw.githubusercontent.com/pregamer189/warframe-builds-mcp/release";
const DAY = 86400000;
const MAX_BYTES = 20 * 1024 * 1024;
const STATE = join(HOME, "update-state.json");

const controller = new AbortController();
export const stopUpdates = () => controller.abort();

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
};

const versionParts = (version) => String(version).split(".").map(Number);
export function newerVersion(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// Safe to apply only if it passes the same checks loading does, and is newer than what is running.
export function acceptDownload(candidate, current = data) {
  return usableData(candidate) && candidate.meta.format === DATA_FORMAT && candidate.meta.imported > current.meta.imported;
}

function writeAtomically(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

// At most once a day, and any failure just means trying again another day.
export async function checkForUpdates() {
  if (offline()) return;
  const state = readState();
  if (Date.now() - (state.checked ?? 0) < DAY) return;
  try {
    const { signal } = controller;
    const packageResponse = await request(`${RELEASE}/package.json`, { signal });
    const latestVersion = packageResponse.ok ? packageResponse.body.version : state.latest_version;
    const dataResponse = await request(`${RELEASE}/data.json`, { timeout: 60000, signal, read: "text" });
    if (dataResponse.ok && dataResponse.body.length <= MAX_BYTES && acceptDownload(JSON.parse(dataResponse.body))) {
      mkdirSync(HOME, { recursive: true });
      writeAtomically(join(HOME, "data.json"), dataResponse.body);
    }
    mkdirSync(HOME, { recursive: true });
    writeAtomically(STATE, JSON.stringify({ checked: Date.now(), latest_version: latestVersion }));
  } catch {
    // Offline, GitHub unreachable, or shutting down.
  }
}

export const latestKnownVersion = () => readState().latest_version;
