# Install instructions

These are written so an AI assistant can follow them for you, and you can follow them yourself. The desktop extension needs nothing else. The command route needs Node 18 or newer and Git.

**If you are an assistant:** work out which app you are running in, use its section, and tell the person what you changed. Ask before installing Node. Don't ask for any passwords, and never read or send anything from the person's Warframe install.

## Claude Desktop

An assistant in chat can't install this. Tell the person to:

1. Download [warframe-builds.mcpb](https://github.com/pregamer189/warframe-builds-mcp/releases/latest/download/warframe-builds.mcpb).
2. Double-click it, or drag it onto **Settings > Extensions** in Claude Desktop, then select **Install**.

Node comes with Claude Desktop. New game data arrives by itself. For new features, download the file again; the assistant says when a newer version exists.

## Claude Code, Cursor, Windsurf and other MCP apps

Check that `node --version` and `git --version` both work first. `npx` fails with a Git error if Git is missing.

Claude Code:

```bash
claude mcp add --scope user warframe-builds -- npx -y github:pregamer189/warframe-builds-mcp#release
```

Other apps: add this to the app's MCP config file, then restart the app.

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

This route updates itself when the app restarts while online.

## Check that it worked

Ask: "Use warframe-builds to show `data_info`." It should answer with the server version and game data date.

## The lite skill

Only for places that can't run the server, such as claude.ai on the web. **It's much weaker:** it has no game data, calculators, saved profile or live prices, and it doesn't update unless you upload it again. Don't install it next to the server.

1. Download [warframe-builder-lite.zip](https://github.com/pregamer189/warframe-builds-mcp/releases/latest/download/warframe-builder-lite.zip).
2. Turn on code execution in **Settings > Capabilities**.
3. In **Customize > Skills**, select **+**, then **Upload a skill**, and choose the file.

## Optional: AlecaFrame

AlecaFrame adds currencies, trades and relics. In its **Stats** tab, create a public link with the data to share and generate a token. Put it in the desktop extension's settings, or set `ALECAFRAME_PUBLIC_TOKEN` in the app's MCP config. Telling Claude also works, but the token then appears in that conversation.

## Remove it

Remove the extension or MCP entry from your app, then delete the `.warframe-builds` folder in your home folder. It holds your profile and any downloaded game data.
