// A player's AlecaFrame stats, through the public token they create in its Stats tab. The API has no mods or gear.
import { round } from "./data.mjs";
import { request } from "./online.mjs";
import { alecaframeToken } from "./profile.mjs";

const API = "https://stats.alecaframe.com/api/stats/public";
const RELIC_TIERS = ["Lith", "Meso", "Neo", "Axi", "Requiem"];
// AlecaFrame's docs list values 4 to 6 under the same names as 1 to 3, without saying how they differ.
const REFINEMENTS = ["Intact", "Exceptional", "Flawless", "Radiant", "Exceptional", "Flawless", "Radiant"];
const ENTRY_BYTES = 9;

// Their documented format: a Uint32 count, then for each relic a tier byte, a refinement byte, three name characters and
// a Uint32 count, little-endian.
export function parseRelicInventory(buffer) {
  if (buffer.length < 4) throw new Error("AlecaFrame's relic data was too short.");
  const count = buffer.readUInt32LE(0);
  if (buffer.length < 4 + count * ENTRY_BYTES) throw new Error("AlecaFrame's relic data was shorter than it claimed.");
  return Array.from({ length: count }, (_, i) => {
    const at = 4 + i * ENTRY_BYTES;
    const name = buffer.toString("latin1", at + 2, at + 5).replace(/\0/g, "").trim();
    return { relic: `${RELIC_TIERS[buffer[at]] ?? `Tier ${buffer[at]}`} ${name}`, refinement: REFINEMENTS[buffer[at + 1]] ?? `Refinement ${buffer[at + 1]}`, count: buffer.readUInt32LE(at + 5) };
  });
}

const TRADE_KINDS = ["sale", "purchase", "trade"];
const objects = (list) => (list ?? []).map((object) => ({ name: object.displayName ?? object.name, count: object.cnt ?? 1, ...(object.rank !== undefined && object.rank !== null && { rank: object.rank }) }));

export async function alecaframeAccount({ recent_trades = 10 }) {
  if (!Number.isInteger(recent_trades) || recent_trades < 0 || recent_trades > 100) throw new Error("recent_trades must be a whole number from 0 to 100.");
  const token = alecaframeToken();
  if (!token) throw new Error("AlecaFrame is not connected. In AlecaFrame's Stats tab, create a public link with the data to share, generate its token, and save it with update_profile as alecaframe_public_token, or set ALECAFRAME_PUBLIC_TOKEN. It needs AlecaFrame running on Windows.");
  const query = encodeURIComponent(token);
  const statsResponse = await request(`${API}?token=${query}`);
  if (!statsResponse.ok) throw new Error(`AlecaFrame answered with HTTP ${statsResponse.status}. The token may be wrong, expired or revoked.`);
  const stats = statsResponse.body;
  const points = stats.generalDataPoints ?? [];
  const trades = stats.trades ?? [];
  const relicResponse = await request(`${API}/getRelicInventory?publicToken=${query}`, { read: "arrayBuffer" });
  const relics = relicResponse.ok ? parseRelicInventory(Buffer.from(relicResponse.body)) : undefined;
  const platinum = (kind) => round(trades.filter((trade) => TRADE_KINDS[trade.type] === kind).reduce((sum, trade) => sum + (trade.totalPlat ?? 0), 0));
  return {
    last_update: stats.lastUpdate,
    latest_stats: points.at(-1) ?? null,
    trades_recorded: trades.length,
    platinum_from_recorded_sales: platinum("sale"),
    platinum_spent_on_recorded_purchases: platinum("purchase"),
    recent_trades: trades.slice(Math.max(trades.length - recent_trades, 0)).reverse().map((trade) => ({
      when: trade.ts, platinum: trade.totalPlat, type: TRADE_KINDS[trade.type] ?? trade.type, gave: objects(trade.tx), received: objects(trade.rx),
    })),
    ...(relics ? { relics } : { relics_note: [401, 403].includes(relicResponse.status) ? "This token has no relic access. Generate one with relics selected to see them." : `AlecaFrame's relic list answered with HTTP ${relicResponse.status}.` }),
    note: "AlecaFrame's API covers stats, trades and relics only, so owned mods and gear still come from the profile.",
  };
}
