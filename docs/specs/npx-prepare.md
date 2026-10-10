# npx Prepare (v0.2.0)

Part of [v0.2.0](v0.2.0.md). Motivation: MongoDB MCP Server could not pass OpenHub's Health Check from an empty npm cache during P0-2 Registry verification.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**.

## Problem (Fact, measured on Windows 11, Node 24.18, npm 11.16)

- npx tools are `launch-on-demand`: OpenHub writes the client config and the package is downloaded the first time something starts it. For large packages that first start is slow: `mongodb-mcp-server` needed 41-250 s to install from an empty npm cache (network variance), then 26-80 s more on the very first start, while later starts took about 5 s.
- The first-start cost is not npm: after a complete install, the first `npx -y mongodb-mcp-server@3.0.5 --version` made one registry revalidation (72 ms) and changed nothing in `node_modules`, yet took 26 s. Opening about 10,600 freshly written files for the first time (Windows real-time scanning and a cold file cache) accounts for it: reading those files once took 169 s, after which the first start took 3.7 s.
- OpenHub's Health Check stops a server that has not answered within 20 s. If that happens during npx's own download, the npx cache entry (`<npm cache>/_npx/<key>`) is left incomplete. npm does not repair it: every later start fails (`ENOENT` or `ERR_MODULE_NOT_FOUND`). Reproduced several times with fresh caches. An entry can even end up with npm's completion file present but files missing (the entry found in a developer's cache).

## Decision

Before writing a client config (install) or replacing it (update, rollback), OpenHub prepares the exact npm package version in the npx cache, as an approved plan step with its own time limit. The Health Check limit stays 20 s.

Flow: plan → approval → **Prepare** → verify → client config write → (MCP start by the client or Health Check).

### When it applies

| Case | Prepare step |
| --- | --- |
| Install, npx Manifest pinned to an exact version (`pkg@X.Y.Z`) | yes |
| Install, npx Manifest not pinned (all npx tools in the current Registry) | no; unchanged `launch-on-demand` (no exact version to prepare) |
| Update (target resolved to an exact version by the resolver) | yes |
| Rollback to a locked previous version | yes |
| Rollback to an unlocked previous version | no (no exact version) |
| Health only | no |
| uvx, Docker | no change (Docker already pulls) |

### What the step does

- Plan step (fixed form, checked by the plan schema and again before running): `{ id: "npx-prepare", kind: "run", executable: "npx", args: ["--yes", "--package=<pkg>@<X.Y.Z>", "--", "node", "--version"], cwd: "isolated", network: true, timeoutMs: 600000 }`. The spec must equal the plan's artifact (install) or launch target (update).
- `npm exec` installs into the same entry the client will use: the npx cache key is the first 16 hex characters of the SHA-512 of the package spec list, so `--package=pkg@X.Y.Z` and the client's `npx -y pkg@X.Y.Z …` share `_npx/<key>` (verified: an offline client-style start reused the prepared entry). The command after `--` is `node --version`; the package's MCP server is not started.
- npm runs dependencies' install scripts during the install (for example `prebuild-install` in MongoDB's tree). This also happens when a client starts the package for the first time; Prepare moves it after approval. The plan notice says so.
- Process start without a shell. Linux/macOS: `npm` / `npx`. Windows: `node.exe` with npm's `npm-cli.js` / `npx-cli.js` (D-016: no `cmd`).
- Steps: ask npm for its cache directory (`npm config get cache`, 30 s); inspect only `_npx/<key>`:
  - verified by OpenHub (`.openhub-prepared` with the spec, npm completion file `node_modules/.package-lock.json`, installed version matches) → reuse, no download;
  - anything else (incomplete, or complete but of unknown origin) → rename it aside, then delete the renamed directory, then download. If it cannot be renamed (in use): a complete entry is reused, an incomplete one makes the step fail without changing anything;
  - after download: check completion file and version, write `.openhub-prepared`, then read the entry's `.js`, `.cjs`, `.mjs`, `.json` and `.node` files once within the remaining time (no execution).
- On failure or timeout: the process tree is ended (`taskkill /T /F` on Windows, process group on POSIX), the step returns within 10 s even if ending the tree hangs, and the incomplete entry created by this attempt is removed. The next attempt starts clean.
- Never touched: other `_npx` entries, the npm content cache, global packages. OpenHub does not run `npm cache clean` or remove `_npx` as a whole.
- Results contain no absolute paths or cache location.

### Contract changes (Fact)

| Contract | Change | Compatibility |
| --- | --- | --- |
| InstallPlan v1 | run step `executable`: `"docker"` → `"docker" \| "npx"`; `artifact.preparation` adds `"npm-cache"`; new warning `npx-prepare` | schemaVersion 1; additive. Existing plans stay valid. Plans for pinned npx Manifests change (none in the Registry today). Schema digest change proven to come only from these two enums |
| LifecyclePlan v1 | shared run step accepts `npx`; npx update/locked-rollback plans gain the prepare step and warning | schemaVersion 1; approved plans from before the upgrade become `PLAN_STALE` on regeneration, as designed |
| InstallResult v1 | `verification.prepared` adds `"cached"` | additive |
| LifecycleStateFile v1 | none | byte-identical golden |
| M5 rule "npx update runs no package manager command" | replaced: npx update runs exactly the two Prepare commands; uvx still runs none | documented in tests |

PLAN_STALE: the prepare arguments are part of the plan digest; a different resolved version or Manifest pin makes the regenerated plan differ (tested).

### Impact on existing flows

- Installer: run steps already execute before config steps and a failed run step skips config writes; npx Prepare uses the same path (tested: on failure no client file is created).
- Update and rollback: preparation already runs before config replacement and Health; a failed Prepare returns `preparation-failed` with config bytes and Version State unchanged and no Health run (tested).
- Health: unchanged (20 s start, 10 s handshake, 45 s total).
- Adopt: unchanged; an adopted entry's later update gets the prepare step.
- Desktop and CLI: pass the Windows npx launcher to install, as lifecycle already did.

## Verification (Fact)

- Unit tests with a fake npm against real temporary directories: cache key equals npm's (four measured keys), fixed argument form, Windows argv without `cmd`, fresh install, reuse, repair of incomplete entries, replacement of unknown entries, in-use handling, failure and wrong-version cleanup, timeout with tree kill, unknown cache location, symlink/junction rejection, other entries untouched, no absolute paths in results.
- Transaction tests: install order (Prepare before config write, `prepared: cached`), failure keeps config absent, PLAN_STALE on a changed pin, update failure keeps config and Version State.
- Real E2E (`OPENHUB_E2E=1`, isolated npm cache and home; `packages/core/test/registry/npx-prepare.e2e.test.ts`, also run by the `registry-remote.yml` sandbox job): Memory MCP pinned — Prepare + install 13 s, Health `healthy` 14 s; interrupted Prepare (1.5 s) cleaned up, retry, repair and reuse all pass.

### MongoDB MCP Server re-verification (Fact; no Manifest in this change)

Run with `OPENHUB_E2E_NPX_COMMAND="npx -y mongodb-mcp-server@3.0.5 --readOnly --telemetry disabled"`, empty npm cache, isolated home, Windows:

| Check | Before npx Prepare | With npx Prepare |
| --- | --- | --- |
| Install from an empty cache | first start had to download: Health `timeout` | Prepare 171 s (download 70-250 s depending on network, plus pre-read), config written after |
| Health Check (20 s limit unchanged) | `timeout`, then broken npx cache entry | `healthy` in 3.3 s, 20 tools |
| Interrupted install | entry left broken, every later start fails | Prepare cut at 20 s returned in 22 s and removed the entry; retry completed (153 s) |
| Version | floating at first start | the exact `3.0.5` entry the client uses (same npx key) |
| `--readOnly` | | 20 tools, all `readOnlyHint`; no insert, update, delete, drop or create |
| `--telemetry disabled` | | passed on the command line |
| Credentials | | fake connection string with password in `MDB_MCP_CONNECTION_STRING`: `list-connections` shows only "preconfigured"; connect attempts to an unreachable host return errors with the address masked; no password, user or host in server output or in the 8 log files the server wrote under the home directory |

The 2026-10-10 run also exposed a defect in this change before it was fixed: when ending the process tree hung, the step did not return. The step now finishes within 10 s of its time limit regardless.

## Not covered (Open Question / Proposal)

- npx Manifests that are not pinned keep `launch-on-demand`. Resolving them to an exact version at install time would change every npx install plan and needs network access while planning (Open Question).
- uvx has the same first-download shape; uv's cache behaves differently and was not measured (Proposal: measure before deciding).
- An entry that OpenHub verified and that is later damaged outside OpenHub is reused as is. A Health failure points to it; deleting that one entry and re-running Prepare fixes it.
