# warframe-builds-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant calculate and suggest Warframe builds. Ask things like "what's the best Soma Prime build against Grineer?" or "get Saryn to 175% efficiency with as much strength as possible", and it answers with real game data and shows its numbers.

It needs Node 18 or newer and has no other dependencies. It runs on your computer and makes no network calls.

## Install

**Claude Code**

```bash
claude mcp add --scope user warframe-builds -- npx -y github:pregamer189/warframe-builds-mcp
```

**Claude Desktop, Cursor and other MCP clients.** Add this to the client's MCP config:

```json
{
  "mcpServers": {
    "warframe-builds": {
      "command": "npx",
      "args": ["-y", "github:pregamer189/warframe-builds-mcp"]
    }
  }
}
```

**From a local copy**

```bash
git clone https://github.com/pregamer189/warframe-builds-mcp.git
```

Then point your client at `node /path/to/warframe-builds-mcp/server.mjs`.

## Tools

| Tool | What it does |
| --- | --- |
| `suggest_weapon_build` | Picks the mods that do the most damage to the enemy you name, within capacity, polarities and conflicts. It can also plan Forma |
| `suggest_warframe_build` | Picks mods towards a goal such as strength or effective health, or minimums such as 175% efficiency |
| `weapon_build` | Works out a weapon, Zaw or Kitgun build: damage by type, crit, status, damage over time, DPS and capacity. Melee adds range, heavy attacks and per-combo stance DPS |
| `warframe_build` | Works out a Warframe, companion, Archwing or Necramech build: stats, ability stats, effective health and capacity |
| `list_weapons`, `list_warframes`, `list_modular_parts` | Find weapons, frames, and Zaw and Kitgun parts |
| `search_mods`, `search_arcanes` | Find mods and arcanes by name or effect |
| `data_info` | Shows the version, the data's import date, coverage and limits |

Names forgive case, punctuation and typos. Build results warn about mod conflicts, the wrong weapon class, PvP-only mods and going over capacity, and they list anything the calculator could not include under `not_calculated`.

### Example

```json
{
  "weapon": "Soma Prime",
  "mods": ["Serration", { "name": "Split Chamber", "slot_polarity": "madurai" }, "Vital Sense"],
  "riven": { "effects": { "critChance": 120, "multishot": 90 }, "polarity": "madurai" },
  "arcanes": ["Primary Merciless"],
  "conditionals": true,
  "target": { "faction": "Grineer", "armor": 500 }
}
```

Build inputs also take `exilus`, `stance`, `combo_multiplier`, `status_types_on_target`, `attack`, `catalyst`, `level` (for rank 40 items), `base_stats` and `extra_effects`, which covers buffs from abilities the tool can't see, such as `{ "damage": 50 }`. Zaws and Kitguns replace `weapon` with `zaw: { strike, grip, link }` or `kitgun: { chamber, grip, loader }`.

## What it covers

- **Frames:** 119 Warframes, 32 companions, 5 Archwings and 2 Necramechs.
- **Weapons:** 677 primaries, secondaries, melee, Exalted, Archwing and companion weapons, every Zaw and Kitgun combination, and all their attack modes.
- **Mods:** 1,269 mods including stances, auras, Exilus and PvP-only ones, plus 168 arcanes. You enter Rivens with the stats you rolled.
- **Damage:** elements and combinations in mod order, crit, multishot, status procs, damage over time, enemy armor, faction damage, faction mods, heavy attacks, combo scaling and stance combos.

## Accuracy

Formulas come from the Warframe wiki, and the tests check them against the wiki's worked examples. The data is cross-checked between WFCD and the wiki where both have it, and the import stops rather than writing data if known values stop matching.

**Nothing was checked in-game**, and both sources are community maintained, so they can lag behind patches or contain mistakes. Treat the numbers as well-founded theory.

## Limits

- **Left out of damage:** weak points, shields, armor stripped by status effects, ability buffs (unless passed through `extra_effects`), status duration mods, forced procs and the game's 1/32 damage rounding.
- **Triggered effects:** Galvanized mods and arcanes only count when you set `conditionals: true`, and then always at full stacks. That makes the result a peak, not an average.
- **Listed, not calculated:** set bonuses, most aura effects on squadmates and weapons, and other effects with no fixed number. They appear in `not_calculated`.
- **Melee:** per-combo stance DPS ignores stance slash and status multipliers. Plain `burst_dps` ignores the stance completely.
- **Heavy attacks:** they exclude Bleed and wind-up mods. Many multi-hit classes don't match their listed class multiplier in the sources, and those results are marked `unconfirmed`.
- **Other frames:** companions, Archwings and Necramechs use the stats the sources list, since they publish no rank 30 rule. Necramechs have 12 slots. The tool caps the others at 12 too, as the sources don't confirm their counts, and suggests at most 8 mods for them.
- **Exalted weapons:** Ability Strength scaling isn't included.
- **Suggestions:** they assume you own every mod at max rank, so use `exclude` for any you don't. They only choose mods with effects the calculator can model, and they don't choose arcanes. The search is heuristic, so a better build can exist. Against brute force over each weapon's 15 strongest mods it matched in all 16 cases tested, but a wider 17-mod run found one heavy attack build 4.3% better.
- **Not supported:** Railjack, Necramech melee, vehicles, amps and Operator gear.

## Game data

`data.json` is generated, so don't edit it by hand. A GitHub Action refreshes it weekly when the sources change and the tests still pass. To refresh it yourself:

```bash
npm run import-data
```

## Development

```bash
npm test
```

| Path | Contents |
| --- | --- |
| `server.mjs` | MCP protocol, tool definitions and input checks |
| `lib/` | Calculations: `weapons`, `frames`, `target` (enemies), `mods` (capacity and effects), `suggest` |
| `scripts/` | The data import, and a parser for the wiki's Lua tables |

## License

The code is under the [MIT license](LICENSE). The game data has its own terms, including a non-commercial license on the wiki-derived parts. See [NOTICE.md](NOTICE.md). This project is not affiliated with Digital Extremes.
