# Known issues in v0.2.1

v0.2.1 is **not released yet**. This page describes the limits of the code on main that is planned for v0.2.1 and is updated together with that code. Issues of the published v0.2.0 and their fixes are in the [v0.2.0 known issues](known-issues-v0.2.0.md); the scope of this release is in the [v0.2.1 release notes](release-notes/v0.2.1.md).

## Summary

| Issue | Status | What you can do |
| --- | --- | --- |
| Serena: no new installs | By design in v0.2.1; re-support tracked in #59 | Keep or remove your existing entry; recovery still works |
| Memory MCP: no new installs | By design in v0.2.1; storage fix tracked in #69 | Before your client starts it again, back up `memory.jsonl` and set `MEMORY_FILE_PATH` to an absolute path; recovery still works |
| Postgres MCP Pro: first Health on Windows is close to the time limit | Not fixed; measured about 15 s of 20 s | Run Health again |
| Unpinned npx tools (Chrome DevTools MCP, Playwright MCP) download the package during their first Health | Known limit; not measured; tracked in #70 | Run Health again |
| Context7 entries installed before v0.2.1 stay unpinned until you update them | By design (no automatic change) | Update to the reviewed 4.1.0 or choose another exact version |
| Recovery of interrupted operations is CLI only | By design in v0.2.1 | Run the command the Installed view shows |
| Environment limits during Health and benchmark are not a sandbox | Known limit | See below |
| npm configuration (`node-options` in `.npmrc`) can still add Node.js options | Known limit; tracked in #63 | Check `npm config get node-options` |
| Index or registry URL with credentials in the environment | Health and benchmark refuse to start the server | Move it to `uv.toml` or `.npmrc` |
| Tools that relied on undeclared environment variables during Health | Health may now fail | Declare the variable in the Manifest, or rely on your client |
| Custom Registries: some uvx command forms are refused | By design in v0.2.1 | Write options with a space |
| Custom Registries: unpinned uvx tools may build from source | Known limit; only pinned tools are prepared | Pin the package and every `--with` dependency to exact versions |
| Carried over from v0.2.0 | Cursor and macOS not verified, Kubernetes 0.0.67 only, unsigned installer, AppImage via FUSE not tested | See the release notes |

## Serena: no new installs

- **What happens:** Serena needs a dependency (`proxy-tools`) that is only published as source code. v0.2.1 does not build source code that OpenHub cannot verify, so Serena was removed from the Verified Registry. Install, update, rollback, Health, repair, adopt and benchmark refuse it with this reason, also when a custom Registry or a Manifest with another name installs the same package.
- **If you already use Serena:** your client configuration and Version State are not changed or deleted. `openhub lifecycle status` shows the entry as withdrawn with a link to #59. Your client can still start it as before, which means the client builds `proxy-tools` from source on a first start, a build OpenHub did not review. OpenHub just does not manage the tool any more.
- **Interrupted Serena operation:** `openhub lifecycle recover serena` still works; it does not need the Registry entry.
- **Removing it:** follow the manual removal steps in the README (back up the client configuration file first).
- **Status:** re-support is tracked in [#59](https://github.com/kanghyunsoon/openhub-ai/issues/59). A Windows Prepare failure seen once in six tries during earlier Serena testing was never explained; it is not a v0.2.1 path any more.

## Memory MCP: no new installs

- **What happens:** Memory MCP stores memories in `memory.jsonl` inside its package folder in the npx cache unless `MEMORY_FILE_PATH` is set. A new upstream version under the unpinned command replaces that folder and deletes the file, and an update or rollback to another version starts the server without the earlier memories (both reproduced). Memory MCP was removed from the Verified Registry. Install, update, rollback, Health, repair, adopt and benchmark refuse it with this reason, also when a custom Registry or a Manifest with another name installs the npm package `@modelcontextprotocol/server-memory`. Other servers from the shared `modelcontextprotocol/servers` repository are not affected.
- **If you already use Memory MCP:** your client configuration, Version State and memory file are not changed, moved or deleted. `openhub lifecycle status` shows the entry as withdrawn with a link to #69. OpenHub does not start the server any more, but your client can, and OpenHub does not control that. Back up `memory.jsonl` before the next start. A file that was already deleted cannot be recovered by OpenHub.
- **Protect your memories yourself.** Nothing in v0.2.1 moves, copies or protects the file for you, and your client still starts Memory MCP with the old configuration, so the same loss can still happen if you do nothing. Before your client starts it again:
  1. Find the file: `memory.jsonl` under `<npm cache>/_npx/<folder>/node_modules/@modelcontextprotocol/server-memory/dist/` (`npm config get cache` prints the npm cache folder). Each command form and version has its own folder, so there can be more than one file.
  2. Copy it to a folder outside the npm cache.
  3. Set `MEMORY_FILE_PATH` for this server to the **absolute** path of the copy. Versions 2026.x and 1.0.0 read and write the same file at an absolute path. Do not use `~` (versions before 1.0.0 do not expand it) or a relative path (it is resolved inside the package folder, which changes with the version).
- **Already deleted files:** a memory file that was already deleted (for example by a new upstream version or by clearing the npm cache) cannot be recovered by OpenHub.
- **After you set `MEMORY_FILE_PATH` in the client entry:** `openhub lifecycle status` shows the entry as `config-drift` next to the withdrawn notice. This is expected: OpenHub does not update or repair this tool any more and does not overwrite your setting.
- **Interrupted Memory MCP operation:** `openhub lifecycle recover memory-mcp` still works; it does not need the Registry entry.
- **Removing it:** follow the manual removal steps in the README (back up the client configuration file first). Removing the client entry does not delete the memory file.
- **Status:** a stable storage path outside the npm cache and an approved copy of existing memories are tracked in [#69](https://github.com/kanghyunsoon/openhub-ai/issues/69).

## Postgres MCP Pro: first Health on Windows

- **Symptom:** the first Health check after installing Postgres MCP Pro on Windows took about 15 seconds of the 20 second limit in our measurement (Linux: about 3 seconds). On a slower machine, disk or network it may stop with `startup-timeout`.
- **What you can do:** run Health again (Installed → Health Check, or `openhub lifecycle health postgres-mcp`). The packages were prepared before the configuration was written, so later starts are faster (about 6.5 seconds in the same measurement).
- **Update and rollback:** a different version has its own startup time. In our test an older version (0.2.1) needed about 31 seconds on Windows, so its Health check failed and OpenHub restored the previous configuration and Version State. This is the intended safe behavior, not data loss.
- **Status:** not fixed. The 20 second limit is not raised to hide this.

## Unpinned npx tools: the first Health downloads the package

- **Which tools:** Chrome DevTools MCP (`chrome-devtools-mcp@latest`) and Playwright MCP (`@playwright/mcp@latest`). Their Registry command has no exact version, so OpenHub does not download them at install (the plan says "launch-on-demand" and shows `floating-artifact`).
- **What happens:** the first Health check (like the first start by your client) runs npx, which looks up the newest version, downloads it with its dependencies into the npx cache and then starts the server. All of this counts against the 20 second startup limit.
- **Measured:** Chrome DevTools MCP and Playwright MCP were **not measured**. Context7 had the same problem before v0.2.1 pinned it: with an empty npm cache its first start took about 15.8 seconds on one Windows development PC and 6.4–8.2 seconds on Linux, and in an independent test one first Health on Windows stopped with `startup-timeout` after about 29 seconds (the retry took about 3 seconds). A slow network, disk or antivirus scan makes `startup-timeout` more likely.
- **Context7 in v0.2.1:** pinned to `@upstash/context7-mcp@4.1.0` and prepared after approval, before any client file is written, so its first Health starts the prepared package. Entries installed by an earlier version keep their unpinned command until you update them; the update plan prepares 4.1.0 (or the exact version you enter), runs Health and keeps your configuration if either step fails. Adopt needs the reviewed command; an entry with another version or no version is not adopted.
- **What you can do:** run Health again. A failed standalone Health check changes no configuration; a failed Health during an update restores the previous configuration and Version State. Later starts use the downloaded package, but an unpinned tool downloads again whenever a newer version is published.
- **Status:** a strategy for preparing or pinning the remaining unpinned tools (resolve an exact version in the plan, then approve, prepare and write that version) is tracked in [#70](https://github.com/kanghyunsoon/openhub-ai/issues/70). The 20 second limit is not raised.

## Recovery is CLI only

- The desktop app shows an interrupted operation (`interrupted-update`) and the exact command, how to get the CLI, and how to confirm the result. It does not recover by itself. Run `openhub lifecycle recover <toolId>` in a terminal and approve the plan.

## Environment limits during Health and benchmark

Health checks and benchmarks pass only an allowlisted environment to the MCP server. This keeps unrelated secrets in your shell away from it, but:

- It is **not a sandbox**: the server runs as your user and can read your files, including configuration files that contain secrets, and use the network.
- The package source used when a tool was prepared is not permanently linked to later Health checks.
- The contents of `uv.toml` and `.npmrc` are not part of the approved plan.
- npm's own `node-options` setting (in your user or global `.npmrc`, or `npm_config_node_options` during npx Prepare) is applied by npm to the processes it starts. The rule "variables that change which code runs are never passed" is about environment variables and does not cover this. Only someone who can already change your `.npmrc` or environment can use it. If you did not set it yourself, `npm config get node-options` should print `null`. Tracked in [#63](https://github.com/kanghyunsoon/openhub-ai/issues/63).
- Credentials hidden in a URL path cannot be told apart from an ordinary path and are not detected.
- When your client (Claude Code, Codex, Cursor) starts the server, the client decides the environment, not OpenHub.

See the [security model](security-model.md).

## Index or registry URL with credentials

- **Symptom:** Health or benchmark refuses to start a server because a package index or registry setting in your environment (for example `UV_INDEX_URL` or `NPM_CONFIG_REGISTRY` with a user and password in the URL) cannot be passed unchanged. OpenHub does not fall back to the public index.
- **What you can do:** put the index and its credentials in `uv.toml` or `.npmrc` and remove them from the environment variable, then make a new plan.

## Tools that read undeclared environment variables

- **Symptom:** a tool's Health check passed in v0.2.0 only because it read a variable from your environment that its Manifest does not declare. In v0.2.1 that variable is not passed during Health, so Health may fail.
- **What you can do:** for Registry tools, report it so the Manifest can declare the variable. How your client starts the server is not affected.

## Custom Registries: uvx command forms

- **Symptom:** a custom Registry Manifest's uvx command is refused with `MANIFEST_COMMAND_REJECTED`. There are two different reasons:
  - **The package cannot be identified** from the Manifest: URLs, paths, VCS sources, wheel or archive files, `--with-editable` and `--with-requirements`. Options that `uvx --help` in uv 0.12.3 does not list are refused for the same reason, because OpenHub cannot tell whether they take a value. Options added by later uv versions are refused until they are reviewed.
  - **The package can be identified, but the form is outside OpenHub's Prepare and update handling:** `--from=package`, `--with=package`, `-wpackage`, `-w=package`, combined short flags such as `-qw`, comma-separated `--with` lists and `--`. uvx itself accepts these, and OpenHub reads the packages in them (a withdrawn tool written this way is still recognized and refused as withdrawn). OpenHub's Prepare, update and version checks only work on options written with a space, so these forms are refused rather than handled partly.
- **What you can do:** write options with a space, for example `uvx --from package==1.2.3 --with dependency==4.5.6 command`, and use package names, not URLs, paths or files.

## Custom Registries: unpinned uvx tools

- **What happens:** only uvx tools pinned to exact versions (`--from package==X.Y.Z` and every `--with dependency==A.B.C`) are prepared with wheels only and started with `--no-build`. An unpinned uvx tool is not prepared: it is downloaded when it first starts, and neither the client configuration nor Health and benchmark add `--no-build`, so uv may build a package from source that OpenHub did not review. The install plan marks it as a floating artifact and asks for that approval.
- **What you can do:** pin the package and every `--with` dependency to exact versions. In the Verified Registry the only uvx tool, Postgres MCP Pro, is pinned.

## Carried over from v0.2.0

- Starting tools from Cursor is not verified on any platform.
- Nothing is verified on macOS and there is no official macOS artifact.
- Kubernetes MCP Server is limited to version 0.0.67.
- The Windows installer is unsigned; how SmartScreen or Smart App Control reacts has not been observed.
- The Linux AppImage is tested by extracting it; starting it directly through FUSE is not tested.
- The Verified Registry has 7 tools; the earlier 25–40 target is carried over.
