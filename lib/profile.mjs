// The player's own record, kept in one local file: which mods they have, what they can sell, their Rivens and saved builds.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, data, find, normalize } from "./data.mjs";
import { allFrames, warframeBuild } from "./frames.mjs";
import { weaponBuild } from "./weapons.mjs";

const PATH = join(HOME, "profile.json");
const EMPTY = { version: 1, mods_mode: "assume_all", owned_mods: [], missing_mods: [], owned_items: [], spare_items: {}, rivens: {}, saved_builds: {}, notes: "" };

export function loadProfile() {
  let text;
  try {
    text = readFileSync(PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(EMPTY);
    throw error;
  }
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(text) };
  } catch {
    // Saving over it would lose whatever the player had, so a damaged file is theirs to repair.
    throw new Error(`The profile at ${PATH} is not valid JSON. Fix or delete it, then try again.`);
  }
}

function saveProfile(profile) {
  mkdirSync(HOME, { recursive: true });
  const temporary = `${PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, PATH);
    chmodSync(PATH, 0o600);
  } finally {
    rmSync(temporary, { force: true }); // it can hold the token, so a failed save leaves nothing behind
  }
}

// Plain objects hold these by name, and JSON can't round-trip a key such as __proto__ through them.
function safeKey(name, label) {
  if (["__proto__", "constructor", "prototype"].includes(name) || !String(name).trim()) throw new Error(`${JSON.stringify(name)} can't be used as a ${label}.`);
  return name;
}

const allMods = () => ({ ...data.warframeMods, ...data.weaponMods });
const modNames = (names) => names.map((name) => find(allMods(), name, "mod")[0]);
const itemName = (name) => find({ ...allFrames(), ...data.weapons }, name, "item")[0];
const without = (list, removed) => list.filter((name) => !removed.includes(name));
const merged = (list, added) => [...new Set([...list, ...added])].sort();

// What a player sees: never the token itself, as anything shown here lands in the conversation.
function visible({ alecaframe_public_token: token, ...profile }) {
  return { ...profile, path: PATH, alecaframe_connected: Boolean(token || externalToken()) };
}

const externalToken = () => {
  const token = process.env.ALECAFRAME_PUBLIC_TOKEN;
  return token && !token.startsWith("${") ? token : undefined; // Desktop extensions can pass an unset option through as its placeholder
};

export const alecaframeToken = () => externalToken() ?? loadProfile().alecaframe_public_token;

export const getProfile = () => visible(loadProfile());

// The first update_profile creates the file, so setup is only offered until then.
export const firstTime = () => !existsSync(PATH);

export function updateProfile(changes) {
  const profile = loadProfile();
  const {
    mods_mode, add_owned_mods = [], remove_owned_mods = [], add_missing_mods = [], remove_missing_mods = [], add_owned_items = [], remove_owned_items = [],
    spare_items = {}, rivens = {}, notes, alecaframe_public_token,
  } = changes;
  if (mods_mode !== undefined && !["assume_all", "owned_only"].includes(mods_mode)) throw new Error("mods_mode must be assume_all or owned_only.");
  if (mods_mode) profile.mods_mode = mods_mode;
  profile.owned_mods = merged(without(profile.owned_mods, modNames(remove_owned_mods)), modNames(add_owned_mods));
  const owned = modNames(add_owned_mods);
  profile.missing_mods = merged(without(without(profile.missing_mods, modNames(remove_missing_mods)), owned), modNames(add_missing_mods));
  profile.owned_items = merged(without(profile.owned_items, remove_owned_items.map(itemName)), add_owned_items.map(itemName));
  for (const [name, count] of Object.entries(spare_items)) {
    safeKey(name, "spare item name");
    if (!Number.isInteger(count) || count < 0) throw new Error(`spare_items ${name} must be a whole number, or 0 to remove it.`);
    if (count === 0) delete profile.spare_items[name];
    else profile.spare_items[name] = count;
  }
  for (const [weapon, riven] of Object.entries(rivens)) {
    const name = find(data.weapons, weapon, "weapon")[0];
    if (riven === null) delete profile.rivens[name]; // weapon names came from the data, so they are safe keys
    else {
      weaponBuild({ weapon: name, riven }); // rejects effects the calculator would not understand
      profile.rivens[name] = riven;
    }
  }
  if (notes !== undefined) profile.notes = String(notes);
  if (alecaframe_public_token !== undefined) {
    if (alecaframe_public_token) profile.alecaframe_public_token = String(alecaframe_public_token);
    else delete profile.alecaframe_public_token;
  }
  saveProfile(profile);
  return visible(profile);
}

const BUILD_TOOLS = Object.assign(Object.create(null), { weapon_build: weaponBuild, warframe_build: warframeBuild });

// A correction or finding the player gave us, such as "this was nerfed" or a video they want used. It's listed with the
// special rules from then on, ahead of older ones.
export function recordMechanic({ subjects, reported, build_impact, kind = "player_note", source, change }) {
  if (!Array.isArray(subjects) || !subjects.length || subjects.some((subject) => typeof subject !== "string" || !subject.trim())) throw new Error("subjects must list the items this is about, such as [\"Acid Shells\", \"Kuva Sobek\"].");
  if (typeof reported !== "string" || !reported.trim()) throw new Error("reported must say what happens.");
  if (!["game_change", "video", "player_note"].includes(kind)) throw new Error("kind must be game_change, video or player_note.");
  const profile = loadProfile();
  const mechanics = profile.mechanics ?? [];
  const id = Math.max(0, ...mechanics.map((entry) => entry.id)) + 1;
  const entry = { id, subjects, reported, kind, recorded: new Date().toISOString().slice(0, 10), ...(build_impact && { build_impact }), ...(source && { source }), ...(change && { change }) };
  saveProfile({ ...profile, mechanics: [...mechanics, entry] });
  return {
    recorded: entry,
    numbers_changed: Boolean(change),
    note: change
      ? "Calculations now use this, and results that use these items list it first. It isn't verified, so say so when you rely on it. forget_mechanic restores the original numbers."
      : "Results that use these items now list this first, but no numbers changed. If it changes a number, record it again with change, or pass the number through extra_effects without also keeping the old item. It isn't verified, so say so when you rely on it.",
  };
}

export function forgetMechanic({ id }) {
  const profile = loadProfile();
  const mechanics = profile.mechanics ?? [];
  if (!mechanics.some((entry) => entry.id === id)) throw new Error(`No recorded mechanic with id ${id}. Recorded: ${mechanics.map((entry) => entry.id).join(", ") || "none"}.`);
  saveProfile({ ...profile, mechanics: mechanics.filter((entry) => entry.id !== id) });
  return { forgotten: id };
}

export function saveBuild({ name, tool, arguments: args, notes }) {
  safeKey(name ?? "", "build name");
  if (!BUILD_TOOLS[tool]) throw new Error("tool must be weapon_build or warframe_build.");
  const result = BUILD_TOOLS[tool](args ?? {}); // proves the names and shape work, so a saved build can always be loaded again
  const profile = loadProfile();
  profile.saved_builds[name] = { tool, arguments: args, ...(notes && { notes }), saved: new Date().toISOString().slice(0, 10) };
  saveProfile(profile);
  return { saved: name, warnings: result.warnings, total_saved_builds: Object.keys(profile.saved_builds).length };
}

export function deleteBuild({ name }) {
  const profile = loadProfile();
  if (!Object.hasOwn(profile.saved_builds, name)) throw new Error(`No saved build named ${name}.`);
  delete profile.saved_builds[name];
  saveProfile(profile);
  return { deleted: name };
}

// Builds can be saved with a nickname such as CO.
function canonical(name) {
  try {
    return find({ ...allMods(), ...data.arcanes }, name, "mod")[0];
  } catch {
    return name;
  }
}

// Names in saved builds, so sell advice can warn before someone sells a mod a build needs.
export function usedInSavedBuilds(profile, name) {
  const wanted = normalize(name);
  const nameOf = (entry) => (typeof entry === "string" ? entry : entry?.name);
  return Object.entries(profile.saved_builds)
    .filter(([, build]) => {
      const { mods = [], aura, second_aura, exilus, stance, arcanes = [] } = build.arguments ?? {};
      return [...mods, aura, second_aura, exilus, stance, ...arcanes].some((entry) => nameOf(entry) && normalize(canonical(nameOf(entry))) === wanted);
    })
    .map(([buildName]) => buildName);
}

// Turns the profile into suggestion inputs, split by mod table, because a list for one kind of item can name the other's mods.
export function suggestionLimits(profile, table) {
  const inTable = (name) => Object.hasOwn(table, name);
  return {
    exclude: profile.missing_mods.filter(inTable),
    ...(profile.mods_mode === "owned_only" && { only_mods: profile.owned_mods.filter(inTable) }),
  };
}
