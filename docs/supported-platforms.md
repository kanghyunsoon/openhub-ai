# Supported platforms

| Platform | Release artifact | Notes |
| --- | --- | --- |
| Windows x64 | NSIS installer | **Unsigned.** Windows SmartScreen or Smart App Control may warn before it runs. |
| Linux x64 | AppImage | Needs a desktop session (X11 or Wayland). |
| macOS | none | No Developer ID signing or notarization, so there is no macOS release artifact. Building from source is not blocked. |
| Any OS with Node.js 24.15+ | CLI package (`.tgz`) | `npm install -g <tgz>` |

## Clients

Claude Code, Codex and Cursor, in project scope and user scope. OpenHub never writes `~/.claude.json`.

Install support is not the same as run verification. The app shows, per client and OS, whether OpenHub actually ran the tool from that client's configuration. Today: Cursor is **not verified** on Windows and Linux; on macOS nothing is verified (platform-unverified); Kubernetes MCP Server is verified for Claude Code and Codex on Windows and Linux and is limited to version 0.0.67.

## Backends

npx, uvx and Docker must be on PATH. `openhub doctor` shows what was found. Pinokio support targets pterm 0.0.25. Default tests use a fake pinokiod; real Pinokio integration runs only when OPENHUB_E2E=1.

## macOS from source

```sh
pnpm install
pnpm desktop
```

macOS GUI apps started from Finder or the Dock do not inherit environment variables from your shell profile. If MCP servers need environment variables (for example API keys) or npx is not found, start the app from a terminal so it inherits your shell environment, or set the variables for GUI apps with `launchctl setenv NAME value` and restart the app. The same applies to `OPENAI_API_KEY` for the optional AI summary.
