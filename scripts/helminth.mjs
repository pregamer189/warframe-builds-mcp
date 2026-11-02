// Reads the wiki's Helminth page: which abilities can be subsumed, what they're for, and the slots some of them are limited to.
// https://wiki.warframe.com/w/Helminth

const plain = (text) => text
  .replace(/\{\{[A-Za-z]+\|([^}|]+)(?:\|[^}]*)?\}\}/g, "$1").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/data-sort-value="[^"]*"\s*\|?/g, "").replace(/'{2,}/g, "").replace(/<ref[\s\S]*?<\/ref>/g, "").replace(/<[^>]+>/g, "; ").replace(/\s+/g, " ").trim();
const list = (text) => plain(text).split(/; | ?, ?/).map((item) => item.trim()).filter((item) => item && item !== "—" && item !== "N/A");
const between = (page, from, to) => {
  const start = page.indexOf(from);
  return start < 0 ? "" : page.slice(start, page.indexOf(to, start));
};

function scalingFlags(page) {
  const flags = {};
  const table = between(page, "==== Power Scaling ====", "==Invigoration==");
  for (const [, index, ability] of table.matchAll(/\|\s*ability(\d+)\s*=\s*([^\n|]+?)\s*\n/g)) {
    if (flags[ability]) continue;
    const has = (stat) => new RegExp(`\\|\\s*ability${index}${stat}\\s*=\\s*t\\b`).test(table);
    flags[ability] = ["strength", "duration", "range"].filter(has);
  }
  return flags;
}

export function importHelminth(page) {
  const scaling = scalingFlags(page);
  const subsumes = {};
  const table = between(page, "===Subsumable Ability Checklist===", "==== Power Scaling ====");
  for (const row of table.split(/\n\|- data-rowid=/).slice(1)) {
    const lines = row.split("\n").filter((line) => line.startsWith("|") && !line.startsWith("|}"));
    const cells = lines.join("||").replace(/^\|/, "").split(/\|\||\n\|/).map((cell) => cell.replace(/^\|?\s*data-sort-value="[^"]*"\s*\|/, "").trim());
    const [frame, ability, augments, roles, damage, note] = cells.map((cell) => cell.replace(/^\|\s*/, ""));
    const reads = plain(note ?? "").replace(/^20px ALTERED: /, "Changed when subsumed: ").replace(/^20px /, "").replace(/Ability (Strength|Efficiency|Duration|Range)(?=[\d+])/g, "").replace(/ ?; ?/g, "; ");
    // A row can hold more than one ability, such as Jade's.
    for (const name of plain(ability ?? "").split("; ").filter(Boolean)) {
      subsumes[name] = {
        from: plain(frame),
        roles: list(roles ?? ""),
        damage: list(damage ?? ""),
        augments: list(augments ?? ""),
        scales_with: scaling[name] ?? [],
        ...(reads && reads !== "—" && { note: reads }),
      };
    }
  }
  // A few damage buffs can only replace a matching buff on Warframes that already have one.
  const restriction = between(page, "===Damage buff restrictions===", "===Metamorphosis===");
  const [abilities, slots] = restriction.split("can only replace the following");
  const restrictions = {
    abilities: [...(abilities ?? "").matchAll(/\{\{A\|([^}|]+)/g)].map((match) => match[1]),
    replaces: Object.fromEntries([...(slots ?? "").split("Abilities and Warframes")[0].matchAll(/\{\{WF\|([^}|]+)\}\}'s \{\{A\|([^}|]+)/g)].map((match) => [match[1], match[2]])),
  };
  return { subsumes, restrictions };
}
