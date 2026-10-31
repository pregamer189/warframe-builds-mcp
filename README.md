# warframe-builds-mcp

An MCP server that calculates Warframe and weapon builds. It runs on Node 18+ with no dependencies.

## Tools

| Tool | What it does |
| --- | --- |
| `list_warframes` | Lists Warframes and their rank 30 base stats |
| `list_weapons` | Lists weapons and their base stats |
| `search_mods` | Finds mods by name, effect or weapon type |
| `warframe_build` | Final stats, ability stats, armor mitigation and mod capacity |
| `weapon_build` | Elements, crit, burst and sustained DPS, and mod capacity |

## Install

```bash
claude mcp add --scope user warframe-builds -- node "$HOME/warframe-builds-mcp/server.mjs"
```

User scope makes the server available in every project.

## Accuracy

`data.json` was written from memory and has not been checked against the game or the wiki, so numbers may be wrong or out of date. Correct the file directly, or pass `base_stats` to a build tool for a one-off override.

## Limits

- The dataset is small: 6 Warframes, 4 weapons and 35 mods.
- Melee weapons are not supported.
- DPS is calculated before enemy armor, faction damage, status ticks and conditional bonuses.

## Test

```bash
npm test
```
