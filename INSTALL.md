# Install instructions

**If you are an assistant:** do the steps below in order and tell the person what you changed. The person's request covers steps 2 and 3. Ask first before installing Node or Git, replacing an existing entry, or doing step 4. Don't ask for passwords, and never read or send anything from the person's Warframe install. If you can't run commands, as in normal chat, you can't install this: tell the person to paste the same request into Claude Code or the Code tab in Claude Desktop, or to use [the other way](#without-claude-code).

## 1. Check what's needed

`node --version` must show 18 or newer, and `git --version` must work. `npx` needs Git to download from GitHub. If either is missing, tell the person and offer to install it.

## 2. Download and test it

```bash
npx -y github:pregamer189/warframe-builds-mcp#release --version
```

This should print a version number, possibly with some npm notices. It can take a minute the first time. If it fails, show the person the error and stop.

## 3. Add it to the app

**Claude Code:** run `claude mcp get warframe-builds`. If it already exists, show the person what it points to and ask whether to replace it. Otherwise:

```bash
claude mcp add --scope user warframe-builds -- npx -y github:pregamer189/warframe-builds-mcp#release
```

Then check that `claude mcp list` shows it connected. If it doesn't, show the person the error and stop.

If the `claude` command isn't found, as can happen in the Code tab, back up `~/.claude.json` and add the entry from below to its top-level `mcpServers`.

**Other apps:** back up the app's MCP config file, then add this to it. Check the app's documentation if you can't find the file.

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

Claude Code and normal Claude Desktop chats have separate settings. If Claude Desktop is installed, ask whether the person wants the builder in normal chats too. Its settings are in `claude_desktop_config.json`, in `~/Library/Application Support/Claude/` on Mac and `%APPDATA%\Claude\` on Windows. Create the file if it doesn't exist.

If they say yes, make a backup copy next to the file and tell them where it is. Then add this under `mcpServers`, creating that section if needed, and keep all their other settings. Claude Desktop doesn't load the shell's PATH, so on Mac use the full path from `which npx`, and put the folders from `which node` and `which git` in `PATH`. Windows can use the `cmd` form above without `env`.

```json
"warframe-builds": {
  "command": "/full/path/to/npx",
  "args": ["-y", "github:pregamer189/warframe-builds-mcp#release"],
  "env": { "PATH": "/folder/with/node:/folder/with/git:/usr/bin:/bin" }
}
```

On Mac, check it the way Claude Desktop will start it. This should print a version number:

```bash
env -i HOME="$HOME" PATH="/folder/with/node:/folder/with/git:/usr/bin:/bin" /full/path/to/npx -y github:pregamer189/warframe-builds-mcp#release --version
```

Tell them to quit and reopen Claude Desktop, and to restore the backup if it reports a problem with the file. If the path contains a Node version, as it does with nvm, warn them that removing that version stops the builder working in normal chats until the path is updated.

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

In Claude Code, run `claude mcp remove warframe-builds -s user`. In Claude Desktop, remove the `warframe-builds` entry from `claude_desktop_config.json`, or remove the extension if you installed the file. Then delete the `.warframe-builds` folder in your home folder. It holds your profile and any downloaded game data.
