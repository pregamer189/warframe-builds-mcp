# Install instructions

**If you are an assistant:** do the steps below in order and tell the person what you changed. Ask before installing anything or changing a config file. Don't ask for passwords, and never read or send anything from the person's Warframe install. If you can't run commands, as in normal chat, you can't install this: tell the person to paste the same request into Claude Code or the Code tab in Claude Desktop, or to use [the other way](#without-claude-code).

## 1. Check what's needed

`node --version` must show 18 or newer, and `git --version` must work. If either is missing, tell the person and offer to install it.

## 2. Download and test it

```bash
npx -y github:pregamer189/warframe-builds-mcp#release --version
```

This should print a version number. It can take a minute the first time.

## 3. Add it to the app

**Claude Code:** run `claude mcp get warframe-builds`. If it already exists, leave it as it is and tell the person. Otherwise:

```bash
claude mcp add --scope user warframe-builds -- npx -y github:pregamer189/warframe-builds-mcp#release
```

Then check that `claude mcp list` shows it connected.

**Other apps:** add this to the app's MCP config file.

```json
{
  "mcpServers": {
    "warframe-builds": {
      "command": "npx",
      "args": ["-y", "github:pregamer189/warframe-builds-mcp#release"]
    }
  }
}
```

On Windows, if the app can't start `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "github:pregamer189/warframe-builds-mcp#release"]`.

## 4. Offer it in normal Claude Desktop chats

Claude Code and normal Claude Desktop chats have separate settings. If `claude_desktop_config.json` exists, ask whether the person wants the builder in normal chats too. It's in `~/Library/Application Support/Claude/` on Mac and `%APPDATA%\Claude\` on Windows.

If they say yes, make a backup copy of the file. Then add this under `mcpServers`, and keep everything else in the file exactly as it is. Claude Desktop doesn't load the shell's PATH, so on Mac use the full path from `which npx`, and put the folders from `which node` and `which git` in `PATH`. Windows can use the `cmd` form above without `env`.

```json
"warframe-builds": {
  "command": "/full/path/to/npx",
  "args": ["-y", "github:pregamer189/warframe-builds-mcp#release"],
  "env": { "PATH": "/folder/with/node:/folder/with/git:/usr/bin:/bin" }
}
```

Tell them to quit and reopen Claude Desktop, and to restore the backup if it reports a problem with the file.

## 5. Finish

Tell the person it's installed, and that the tools only appear in a new conversation. Give them this to say there: **"Set up my Warframe builder"**. The builder then asks about their playstyle and mods. Don't try to do this yourself in the current conversation.

It updates itself when the app restarts while online.

## Without Claude Code

If you only use Claude Desktop and can't use Claude Code, download [warframe-builds.mcpb](https://github.com/pregamer189/warframe-builds-mcp/releases/latest/download/warframe-builds.mcpb) and double-click it, then select **Install**. You don't need Node or Git. New game data arrives by itself, but for new features you have to download the file again. The assistant tells you when there's a newer version.

## The lite skill

Only for places that can't run the server, such as claude.ai on the web. **It's much weaker:** it has no game data, calculators, saved profile or live prices, and it doesn't update unless you upload it again. Don't install it next to the server.

1. Download [warframe-builder-lite.zip](https://github.com/pregamer189/warframe-builds-mcp/releases/latest/download/warframe-builder-lite.zip).
2. Turn on code execution in **Settings > Capabilities**.
3. In **Customize > Skills**, select **+**, then **Upload a skill**, and choose the file.

## Optional: AlecaFrame

AlecaFrame adds currencies, trades and relics. In its **Stats** tab, create a public link with the data to share and generate a token. Set `ALECAFRAME_PUBLIC_TOKEN` in the app's MCP config, or in the settings of the file from [Without Claude Code](#without-claude-code). Telling Claude also works, but the token then appears in that conversation.

## Remove it

Remove the extension or MCP entry from your app, then delete the `.warframe-builds` folder in your home folder. It holds your profile and any downloaded game data.
