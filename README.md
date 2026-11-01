# warframe-builds-mcp

An MCP server that calculates Warframe and weapon builds. It runs on Node 18+ with no dependencies.

## Tools

| Tool | What it does |
| --- | --- |
| `list_warframes` | Finds Warframes, with rank 30 and rank 0 stats, polarities and abilities |
| `list_weapons` | Finds primaries and secondaries, with attack modes and stats |
| `search_mods` | Finds mods by name, effect or effect text |
| `warframe_build` | Final stats, ability stats, armor mitigation and mod capacity |
| `weapon_build` | Damage by type, crit, status, burst and sustained DPS, and mod capacity |

Build results list any `not_calculated` effects, such as conditional bonuses, and warn about mod conflicts, weapon or Warframe compatibility, and going over capacity.

## Install

```bash
claude mcp add --scope user warframe-builds -- node "$HOME/warframe-builds-mcp/server.mjs"
```

User scope makes the server available in every project.

## Data

`data.json` is generated, so don't edit it by hand. It covers 119 Warframes, 344 primaries and secondaries, and 798 Warframe and weapon mods. To refresh it after a game update:

```bash
npm run import-data
```

The import stops without writing anything if known values stop matching, which usually means a source changed its format.

| Data | Source |
| --- | --- |
| Base stats, weapon attacks, mod effects, polarity, drain and rank | [WFCD warframe-items](https://github.com/WFCD/warframe-items) |
| Rank 30 stats, magazine, reload, ammo cost and mod conflicts | [Warframe wiki](https://wiki.warframe.com) data modules |
| Rank and drain for mods WFCD only has as a Flawed copy | Warframe wiki mod pages |

Warframe and its game data belong to Digital Extremes. This project is not affiliated with them.

Both sources are community maintained and can lag behind game patches. Neither was checked in-game, and Maglev is flagged as unverified because only its Flawed copy could be found.

## Limits

- Melee weapons, Archwing, Necramech and companion gear are not supported.
- Warframe results exclude arcanes, archon shards, set bonuses, passives and overshields. Jade's second aura slot is not modeled.
- Weapon results cover one attack mode at a time, before enemy armor, faction damage, status ticks, charge time beyond the fire rate, arcanes and conditional bonuses.
- Spool-up weapons such as Soma Prime and Kohm use their fully spooled values.
- Incarnon and alternate modes use the weapon's normal pellet count, magazine and reload.

## Test

```bash
npm test
```
