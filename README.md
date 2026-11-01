# warframe-builds-mcp

A Warframe builder companion for Claude and other AI assistants. Ask for "a spore nuker Saryn", "the best Soma Prime for level 150 Heavy Gunners on Steel Path", "a build from the mods I own" or "what should I sell?", and it works from real game data and shows its numbers. It's free and open source, and runs on your computer.

## Install

Paste this into [Claude Code](https://claude.com/product/claude-code), or the Code tab in Claude Desktop. Other assistants that can run commands, such as Cursor, work too.

```text
Install and set up the Warframe builder for me by following https://raw.githubusercontent.com/pregamer189/warframe-builds-mcp/main/INSTALL.md
```

It checks what you need, installs the server and offers to add it to your normal Claude Desktop chats as well. Then start a new conversation and say "Set up my Warframe builder". Normal chat can't run commands, so it can't do the install itself. If you can't use Claude Code, [INSTALL.md](INSTALL.md#without-claude-code) has another way.

It updates itself when your app restarts.

### On claude.ai or your phone

The server runs on your computer, so it can't run there. [A lite skill](INSTALL.md#the-lite-skill) gives general advice instead, but it's much weaker: no game data, calculators, saved mods or live prices, and it doesn't update by itself. Use it only if you can't use the server.

## What it does

- **Builds from synergies.** `explore_synergies` hands the assistant the ability text, augments, and fitting mods and arcanes for anything in the game data, including new items. The assistant reasons about combinations, then checks each one. The server teaches it this routine through `build_guide`.
- **Calculators.** Damage by type, crit, status, damage over time, DPS, capacity, Warframe stats and effective health. Enemies scale with level and Steel Path.
- **Mod suggestions.** The most damage for a named enemy, or minimums such as 175% efficiency with as much strength as possible, including where to put Forma.
- **Your account.** A local profile holds the mods you have or lack, your Rivens, spare items and saved builds, and suggestions respect it.
- **Selling.** Live prices and recent sales from warframe.market, with a warning before you sell a mod a saved build uses.
- **AlecaFrame.** Optional currencies, trades and relics, using a public token you create.

## Tools

| Tool | What it does |
| --- | --- |
| `build_guide` | Tells the assistant how to use the rest, and offers setup the first time. It calls this first |
| `explore_synergies` | Gathers ability text, augments and matching mods and arcanes for a theme |
| `suggest_weapon_build` | Picks the mods that do the most damage to the enemy you name, within capacity, polarities and conflicts. It can also plan Forma |
| `suggest_warframe_build` | Picks mods towards a goal such as strength or effective health, or minimums such as 175% efficiency |
| `weapon_build` | Works out a weapon, Zaw or Kitgun build. Melee adds range, heavy attacks and per-combo stance DPS |
| `warframe_build` | Works out a Warframe, companion, Archwing or Necramech build |
| `get_profile`, `update_profile` | Show and change your saved mods, items, Rivens and notes |
| `save_build`, `delete_saved_build` | Keep the builds you like |
| `market_price`, `sell_advice` | Live prices, and what to sell first |
| `alecaframe_account` | Your AlecaFrame currencies, trades and relics |
| `list_weapons`, `list_warframes`, `list_enemies`, `list_modular_parts` | Find weapons, frames, enemies, and Zaw and Kitgun parts |
| `search_mods`, `search_arcanes` | Find mods and arcanes by name or effect |
| `data_info` | Shows the version, data date, coverage and limits |

Names forgive case, punctuation and partial names such as "Bramma", and typos get suggestions. Results put problems such as mod conflicts or going over capacity first, and list anything the calculator could not include under `not_calculated`.

### Example

```json
{
  "weapon": "Soma Prime",
  "mods": ["Serration", { "name": "Split Chamber", "slot_polarity": "madurai" }, "Vital Sense"],
  "riven": { "effects": { "critChance": 120, "multishot": 90 }, "polarity": "madurai" },
  "arcanes": ["Primary Merciless"],
  "conditionals": true,
  "target": { "enemy": "Heavy Gunner", "level": 50, "steel_path": true }
}
```

Build inputs also take `exilus`, `stance`, `combo_multiplier`, `status_types_on_target`, `attack`, `catalyst`, `level` (for rank 40 items), `base_stats` and `extra_effects`, which covers buffs from abilities the tool can't see, such as `{ "damage": 50 }`. Zaws and Kitguns replace `weapon` with `zaw: { strike, grip, link }` or `kitgun: { chamber, grip, loader }`.

## What it covers

- **Frames:** 119 Warframes, 32 companions, 5 Archwings and 2 Necramechs.
- **Weapons:** 677 primaries, secondaries, melee, Exalted, Archwing and companion weapons, every Zaw and Kitgun combination, and all their attack modes.
- **Mods:** 1,269 mods including stances, auras, Exilus and PvP-only ones, plus 168 arcanes. You enter Rivens with the stats you rolled.
- **Enemies:** 997, with armor, health and base level.

## Your data and the network

Your profile stays in `.warframe-builds` in your home folder, and is only readable by you on Mac and Linux. What you tell the assistant, and what tools return, goes to your AI provider like the rest of the conversation.

The server contacts three places:

- **GitHub**, at most once a day, for newer game data. It only downloads data and a version number, never code, and checks the data before using it.
- **warframe.market**, when you ask for prices. It sends the item's name.
- **AlecaFrame**, when you ask for your stats. It sends your public token.

Set `WARFRAME_BUILDS_OFFLINE=1` to turn all of this off. It never reads the game or its files, and never logs in to your Warframe account. AlecaFrame's API has no owned mods or gear, so those come from what you tell the profile.

## Accuracy

Formulas come from the Warframe wiki, and the tests check them against the wiki's worked examples. The data is cross-checked between WFCD and the wiki where both have it, and the import stops rather than writing data if known values stop matching.

**Nothing was checked in-game**, and both sources are community maintained, so they can lag behind patches or contain mistakes. Treat the numbers as well-founded theory. Synergy builds go further: they're the assistant's reasoning from game text, so test them in the Simulacrum.

## Limits

- **Left out of damage:** enemy health and time to kill, weak points, shields, armor stripped by status effects, ability buffs (unless passed through `extra_effects`), status duration mods, forced procs and the game's 1/32 damage rounding.
- **Ability numbers:** `warframe_build` lists each ability's values at your build's stats, such as Spores' starting damage. They aren't damage to an enemy, as armor, factions, stacking and the ability's own caps aren't applied. Kill speed isn't calculated.
- **Triggered effects:** Galvanized mods and arcanes only count when you set `conditionals: true`, and then always at full stacks. That makes the result a peak, not an average.
- **Listed, not calculated:** set bonuses, most aura effects on squadmates and weapons, and other effects with no fixed number. They appear in `not_calculated`.
- **Melee:** per-combo stance DPS ignores stance slash and status multipliers. Plain `burst_dps` ignores the stance completely.
- **Heavy attacks:** they exclude Bleed and wind-up mods. Many multi-hit classes don't match their listed class multiplier in the sources, and those results are marked `unconfirmed`.
- **Other frames:** companions, Archwings and Necramechs use the stats the sources list, since they publish no rank 30 rule. Necramechs have 12 slots. The tool caps the others at 12 too, as the sources don't confirm their counts, and suggests at most 8 mods for them.
- **Exalted weapons:** Ability Strength scaling isn't included.
- **Enemy levels:** only armor scales here. Steel Path adds 100 levels, though Archwing and a few other modes differ.
- **Status builds:** `status_dps` counts damage over time only, with no credit for Viral or other debuffs. Pass `armor_strip` to see stripped armor.
- **Incarnon Forms:** their own ammo and evolution perks aren't in the sources, so trust `burst_dps` over `sustained_dps`.
- **Suggestions:** they assume mods are at max rank, and that you own any the profile doesn't rule out. They only choose mods with effects the calculator can model, and they don't choose arcanes. The search is heuristic, so a better build can exist. Against brute force over each weapon's 15 strongest mods it matched in all 16 cases tested, but a wider 17-mod run found one heavy attack build 4.3% better.
- **Not supported:** Railjack, Necramech melee, vehicles, amps and Operator gear.

## Game data

`data.json` is generated, so don't edit it by hand. A GitHub Action refreshes it weekly when the sources change and the tests still pass, and installed copies download it within a day. To refresh it yourself:

```bash
npm run import-data
```

## Development

Installs follow the `release` branch, which CI moves forward only after every test passes on `main`. A new version in `package.json` and `manifest.json` also publishes the installable file for people without Claude Code, and the lite skill.

```bash
npm test
```

| Path | Contents |
| --- | --- |
| `server.mjs` | MCP protocol, tool definitions and input checks |
| `lib/` | Calculations: `weapons`, `frames`, `target` (enemies), `mods` (capacity and effects), `suggest`, plus `synergy`, `profile`, `market`, `alecaframe` and `update` |
| `lib/build-guide.md` | The guidance `build_guide` returns. Change how builds are made here |
| `manifest.json` | Packaging for the installable file |
| `skills/` | The lite skill, for places that can't run the server |
| `scripts/` | The data import, and a parser for the wiki's Lua tables |

## License

The code is under the [MIT license](LICENSE). The game data has its own terms, including a non-commercial license on the wiki-derived parts. See [NOTICE.md](NOTICE.md). This project is not affiliated with Digital Extremes.
