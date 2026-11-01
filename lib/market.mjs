// Live prices from warframe.market, whose public API needs no login.
import { find, round } from "./data.mjs";
import { request } from "./online.mjs";
import { loadProfile, usedInSavedBuilds } from "./profile.mjs";

const V2 = "https://api.warframe.market/v2";
const V1 = "https://api.warframe.market/v1";
const SPACING_MS = 350; // the API asks for at most 3 requests a second
const MAX_ADVICE_ITEMS = 25;

let queue = Promise.resolve();

// One request at a time, spaced out, with one retry if the API asks to slow down.
function getJson(url) {
  const attempt = async (retry) => {
    const response = await request(url);
    if (response.status === 429 && retry) {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      return attempt(false);
    }
    if (!response.ok) throw new Error(`warframe.market answered with HTTP ${response.status}.`);
    return response.body;
  };
  const run = queue.then(async () => {
    const result = await attempt(true);
    await new Promise((resolve) => { setTimeout(resolve, SPACING_MS); });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

let catalog;
let catalogTime = 0;
const CATALOG_LIFETIME = 3600000;

// Shared while loading, so checking many items at once fetches the list once.
function items() {
  if (!catalog || Date.now() - catalogTime > CATALOG_LIFETIME) {
    catalogTime = Date.now();
    catalog = getJson(`${V2}/items`).then(({ data }) => Object.fromEntries(data.map((item) => [item.i18n?.en?.name ?? item.slug, item])));
    catalog.catch(() => { catalog = undefined; });
  }
  return catalog;
}

function period(rows, rank, subtype) {
  const matching = rows.filter((row) => (rank === undefined || row.mod_rank === rank) && (subtype === undefined || row.subtype === subtype));
  const volume = matching.reduce((sum, row) => sum + (row.volume ?? 0), 0);
  if (!volume) return { volume: 0 };
  const total = matching.reduce((sum, row) => sum + (row.volume ?? 0) * (row.wa_price ?? row.avg_price ?? 0), 0);
  return { volume, average_price: round(total / volume) };
}

export async function marketPrice({ item, rank: askedRank, subtype: askedSubtype }) {
  if (askedRank !== undefined && (!Number.isInteger(askedRank) || askedRank < 0)) throw new Error("rank must be a whole number, 0 or more.");
  const [name, entry] = find(await items(), item, "market item");
  // Ranks sell at very different prices, so they are never mixed. Spare copies are usually unranked.
  const { data: details } = await getJson(`${V2}/item/${entry.slug}`);
  const ranked = Number.isInteger(details.maxRank);
  if (askedRank !== undefined && (!ranked || askedRank > details.maxRank)) throw new Error(ranked ? `${name} goes up to rank ${details.maxRank}.` : `${name} has no ranks.`);
  const rank = ranked ? askedRank ?? 0 : undefined;
  // Relic refinements and similar variants are never mixed either. The first listed is the plain one.
  const subtypes = details.subtypes ?? [];
  if (askedSubtype !== undefined && !subtypes.includes(String(askedSubtype).toLowerCase())) throw new Error(subtypes.length ? `${name} comes as: ${subtypes.join(", ")}.` : `${name} has no variants.`);
  const subtype = subtypes.length ? (askedSubtype === undefined ? subtypes[0] : String(askedSubtype).toLowerCase()) : undefined;
  const query = new URLSearchParams({ ...(rank !== undefined && { rank }), ...(subtype && { subtype }) }).toString();
  const rankQuery = query && `?${query}`;
  const [{ data: orders }, statistics] = await Promise.all([
    getJson(`${V2}/orders/item/${entry.slug}/top${rankQuery}`),
    getJson(`${V1}/items/${entry.slug}/statistics`).catch(() => undefined),
  ]);
  const closed = statistics?.payload?.statistics_closed;
  const sell = orders.sell ?? [];
  const buy = orders.buy ?? [];
  return {
    item: name,
    ...(ranked && { rank, max_rank: details.maxRank }),
    ...(subtype && { subtype, subtypes }),
    lowest_sell_price: sell[0]?.platinum ?? null,
    highest_buy_price: buy[0]?.platinum ?? null,
    sell_prices_listed: sell.map((order) => order.platinum),
    buy_prices_listed: buy.map((order) => order.platinum),
    ...(closed && { sales_last_48_hours: period(closed["48hours"] ?? [], rank, subtype), sales_last_90_days: period(closed["90days"] ?? [], rank, subtype) }),
    url: `https://warframe.market/items/${entry.slug}`,
    note: "Live player listings, in platinum, as of this request. Prices move quickly.",
  };
}

// Plain rules on recent sales: enough to rank what to list first, not a forecast. This is game trading only.
function adviceFor(price) {
  const recent = price.sales_last_48_hours;
  const longer = price.sales_last_90_days;
  if (!longer) return "No sales history came back, so check the listings yourself.";
  if (longer.volume < 10) return "Few sales in 90 days, so expect it to take a while to sell.";
  if (recent?.average_price && longer.average_price && recent.average_price >= longer.average_price * 1.15) return "Selling above its 90-day average, so this is a good time to list it.";
  if (recent?.average_price && longer.average_price && recent.average_price <= longer.average_price * 0.85) return "Selling below its 90-day average, so wait if you can.";
  return "Near its usual price, and it sells regularly.";
}

export async function sellAdvice({ items: wanted }) {
  const profile = loadProfile();
  const list = wanted ?? Object.entries(profile.spare_items).map(([name, count]) => ({ name, count }));
  if (!Array.isArray(list) || !list.length) throw new Error("Nothing to check: pass items, or add spare_items to the profile with update_profile.");
  if (list.length > MAX_ADVICE_ITEMS) throw new Error(`Check at most ${MAX_ADVICE_ITEMS} items at a time.`);
  const results = await Promise.all(list.map(async (entry) => {
    const { name, count = 1, rank, subtype } = typeof entry === "string" ? { name: entry } : entry;
    try {
      const price = await marketPrice({ item: name, rank, subtype });
      const each = price.sales_last_48_hours?.average_price ?? price.sales_last_90_days?.average_price ?? price.lowest_sell_price ?? 0;
      const needed = usedInSavedBuilds(profile, price.item);
      return {
        item: price.item, count, ...(price.rank !== undefined && { rank: price.rank }), ...(price.subtype && { subtype: price.subtype }), lowest_sell_price: price.lowest_sell_price, highest_buy_price: price.highest_buy_price,
        sales_last_90_days: price.sales_last_90_days?.volume ?? null, estimated_value: round(each * count), advice: adviceFor(price),
        ...(needed.length && { warning: `Used by your saved builds: ${needed.join(", ")}. Keep one if you still run them.` }),
      };
    } catch (error) {
      return { item: name, count, error: error.message };
    }
  }));
  return {
    items: results.sort((a, b) => (b.estimated_value ?? -1) - (a.estimated_value ?? -1)),
    total_estimated_value: round(results.reduce((sum, row) => sum + (row.estimated_value ?? 0), 0)),
    note: "Estimates from recent sale prices, in platinum. Trades can still go for less.",
  };
}
