// Mechanics players reported in videos that the game's text doesn't explain, checked against later patch notes and the wiki.
import { readFileSync } from "node:fs";

const { checked_through: CHECKED, rules: RULES } = JSON.parse(readFileSync(new URL("./special-rules.json", import.meta.url), "utf8"));
const ORDER = { no_later_change: 0, changed: 1, disputed: 2, contradicted: 3, fixed: 4 };
const NOTE = `Player reports, not calculated and not tested by this server. Patch notes and the wiki were checked through ${CHECKED.patch} (${CHECKED.date}), and later patches were not. no_later_change means nothing found contradicts it, not that it's proven. For changed, the report describes the old behaviour and later_patch the new. Don't rely on contradicted or fixed rules.`;

const normal = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const baseName = (name) => normal(name).replace(/ (prime|umbra|vandal|wraith|prisma|kuva|tenet)$/, "");
const named = (rule, wanted) => rule.subjects.some((subject) => {
  const candidate = baseName(subject);
  return candidate === wanted || normal(subject) === wanted;
});
const sorted = (rules) => [...rules].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.surprising - a.surprising || b.tested_in_video - a.tested_in_video);

const brief = ({ subjects, status, reported, later_patch, source }) => ({ subjects, status, reported, ...(later_patch && { later_patch }), uploaded: source.uploaded });

// The rules that name any of these items exactly, for adding to a build or synergy result. Build tools get a short form,
// as they're often called many times in a row.
export function rulesFor(names, { limit = 12, short = false } = {}) {
  const wanted = [...new Set(names.filter(Boolean).map(baseName))];
  const matches = sorted(RULES.filter((rule) => rule.status !== "fixed" && wanted.some((name) => named(rule, name))));
  if (!matches.length) return {};
  return {
    special_rules: matches.slice(0, limit).map(short ? brief : (rule) => rule),
    ...(matches.length > limit && { more_special_rules: matches.length - limit }),
    special_rules_note: short ? `${NOTE} Use special_rules for sources and detail.` : NOTE,
  };
}

export function specialRules({ query, status, surprising_only = false, limit = 20 }) {
  const words = normal(query ?? "").split(" ").filter(Boolean);
  const matches = sorted(RULES.filter((rule) => {
    if (status && rule.status !== status) return false;
    if (surprising_only && !rule.surprising) return false;
    const haystack = normal([...rule.subjects, rule.text_says, rule.reported, rule.build_impact].join(" "));
    return words.every((word) => haystack.includes(word));
  }));
  return { total: matches.length, rules: matches.slice(0, Math.min(limit, 60)), note: NOTE, checked_through: CHECKED };
}
