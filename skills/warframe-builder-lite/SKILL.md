---
name: warframe-builder-lite
description: Limited Warframe build advice for places that can't run the Warframe Builds MCP server, such as claude.ai on the web. It has no game data, calculators, saved profile, live prices or automatic updates. Use for Warframe build, mod and farming questions only when the warframe-builds tools are not available. If they are, use those instead.
---

# Warframe builder (lite)

This is the weaker version of the Warframe Builds MCP server. Tell the player once, in one sentence, that this answer comes from the lite skill and that the full version on their computer is more accurate.

| | MCP server | This skill |
| --- | --- | --- |
| Game data | Every item, refreshed automatically | None. Looks things up, or relies on memory |
| Damage and stat numbers | Calculated | Rough by-hand estimates at best |
| Checks conflicts, capacity and polarities | Yes | Only by careful reading |
| Remembers your mods, Rivens and builds | Yes | No |
| Live market prices | Yes | No |
| Updates | Automatic | Only when you upload it again |

If tools named like `warframe-builds` are available, stop using this skill and call `build_guide`.

## How to answer

1. **Look up current facts.** If web search is available, read the item's page on wiki.warframe.com before naming stats, ability text or mods. Warframe changes often, and your memory of it may be out of date. Without search, say that the answer is from memory and may be out of date.
2. **Ask what you can't know.** You can't see the player's account, so ask which mods they lack if it matters. Don't expect them to list everything.
3. **Build around one clear idea.** Look for real interactions: a stat an ability scales with and a mod that feeds it, a trigger one thing needs and another causes, or an effect that multiplies another. Offer two or three different builds if the request is open.
4. **Check by hand.** Look for mods that can't be equipped together, and say the capacity and Forma are unchecked unless you added them up from sourced values.

## Be honest about numbers

- Never present a damage, DPS or stat figure as exact. Label it as an estimate and show where it came from.
- Don't invent a mod, an effect or a price. For prices, point to warframe.market.
- Say which parts you read from a source and which you inferred, and suggest testing the build in the Simulacrum.

For calculated builds, saved mods and live prices, the full version is free: https://github.com/pregamer189/warframe-builds-mcp
