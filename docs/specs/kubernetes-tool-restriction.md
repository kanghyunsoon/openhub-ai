# Kubernetes MCP Server: tool restriction config (design, v0.2.0 follow-up)

Part of [v0.2.0](v0.2.0.md). Status: **Decision** for storage location, security policy and Windows client launch (2026-10-10); implemented on `feat/kubernetes-tool-config` (not merged). Kubernetes MCP Server stays a Discovery Candidate until that pull request and PR #7 (pinned Manifest using it) are approved; PR #7 stays Draft.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**.

## Why (Fact, from the PR #7 verification)

- `npx -y kubernetes-mcp-server --read-only --toolsets core` exposes 13 tools, all `readOnlyHint=true`. `--toolsets core` removes `configuration_view`, which otherwise returned kubeconfig bearer tokens, client keys and passwords (verified with a synthetic kubeconfig).
- `resources_get` with `kind: Secret` returned the Secret's `data` unredacted (verified against a local fake Kubernetes API server with one synthetic Secret). Read-only mode does not stop this: reading a Secret is a read.
- Upstream can deny resource kinds only through a TOML config file (`--config <file>`, or `--config-dir`): `[[denied_resources]]` with `group`, `version`, `kind`. Relative paths are resolved against the server's working directory (upstream README). A Manifest v1 `command` can carry flags but OpenHub has no way to create or own such a file.
- `pods_log` and `nodes_log` can return secrets that workloads print. No server option covers this.

## Decision

### Scope

- `toolConfig` is implemented first as an **allowlist**: only Manifests whose tool ID is in a fixed list in OpenHub's source (initially `kubernetes-mcp-server`) may declare it. Any other Manifest with `toolConfig` fails Registry validation. An arbitrary Registry Manifest can never make OpenHub create files.
- The content is fixed, reviewed TOML in the Manifest. No templating, no user input, no environment values, no secrets, no paths.

### Storage location

Never inside the project. OpenHub-managed directory, logical root `~/.openhub/tool-config/`:

| Scope | File |
| --- | --- |
| user | `~/.openhub/tool-config/user/<toolId>/config.toml` |
| project | `~/.openhub/tool-config/project/<projectKey>/<toolId>/config.toml` |

`projectKey` is the same stable identifier Version State already uses: sha256 of the project's real path (`projectKeyFor`, M5). The real path itself is never written to documents, plans or results.

### Absolute paths

- Plans and results carry only: a logical file ID (`tool-config:<scope>:<toolId>`), the scope, the sha256 digest of the content, the expected prior state (absent, or the digest of the existing file) and the change (create, replace, unchanged).
- The Manifest command uses one placeholder, `--config {toolConfig}`. The plan's client config value keeps the placeholder as is, so plan digests contain no machine paths.
- The one place an absolute path is written is the MCP client config file itself (the `--config` argument), because the client must start the server with it. It is computed when the client config is written and is not propagated to InstallPlan, LifecyclePlan, InstallResult, LifecycleResult, RecommendationReport, logs or caches.
- Right before writing the client config and right before Health, OpenHub recomputes the path and re-checks it: under the real `~/.openhub/tool-config/`, no symlink or junction on any component, file digest equals the approved digest.
- Configured verification compares the client entry with the placeholder substituted by the recomputed path.

### File writing rules

- No file before approval. The file is written by an approved plan step.
- Atomic write (temporary file in the same directory, then rename), owner-only permissions where the OS supports them (`0600` file, `0700` directories on POSIX; on Windows the default per-user profile ACL of the home directory).
- symlink/junction check on the target and every parent below the logical root; refuse if any is a link or resolves outside.
- Relative path tricks are impossible by construction (tool IDs and project keys are validated identifiers), and are checked again.

### Flow and failure handling

Install: plan → approval → Prepare → **tool config write + verify** → client config write → Health.

- New file vs existing file are distinguished in the plan (expected prior state). An existing file with a different digest from the plan's expectation is `PLAN_STALE` (no write).
- On any later failure, only files OpenHub changed in this run are restored: a file it created is removed, a file it replaced gets its original bytes back. Version State is not changed.
- The content digest is part of the plan; a Manifest change after approval makes the plan `PLAN_STALE`.
- Update and rollback use the same step, prior-state check and compensation. Rollback restores the previous revision's content digest.
- Health starts the server with the same argv as the client (placeholder substituted with the same file). A Health run without the file present and matching is a Health failure, not a skip.
- Drift: Lifecycle status reports `tool-config-drift` when the file's digest differs from Version State, and `tool-config-missing` when it is absent.

### Moved or copied projects

A copied or moved project has a different `projectKey` on the new path or machine, and its client config may point to a file that does not exist there. Lifecycle status detects this (`tool-config-missing`, or the client entry's `--config` path differs from the recomputed path), and the fix is a normal approved plan that regenerates the local file and rewrites the client entry (`openhub lifecycle repair <toolId>`, implemented in `feat/kubernetes-tool-config`). Nothing is regenerated silently.

### Kubernetes policy

Pinned `kubernetes-mcp-server@<X.Y.Z>` with `--read-only --toolsets core --config {toolConfig}` and:

```toml
read_only = true
toolsets = ["core"]

[[denied_resources]]
group = ""
version = "v1"
kind = "Secret"
```

- Secret reads denied by server config; `configuration_view` absent; create, update, delete, scale and exec tools absent.
- The plan states: the server uses the kubeconfig's current context with that user's permissions; OpenHub does not read the kubeconfig; Secret reads are denied by server configuration, but pod and node logs can still contain secrets; cluster RBAC is the final boundary, so a read-only RBAC user is recommended.

### Windows client launch (Decision, 2026-10-10)

- Tools with a tool config do not use the D-016 `cmd /d /c npx` wrapper on Windows. The client starts `node.exe` with npm's `npx-cli.js` directly (the same launch OpenHub's Health and Prepare already use), so home and install paths with spaces, parentheses, `&`, `%`, `!`, `^` or Hangul are passed without re-interpretation. 8.3 short paths are not used. Other npx tools keep the D-016 contract unchanged.
- Plans and Version State store only `command: "node"`, first argument `{npxCli}`, and `--config {toolConfig}`. The absolute paths are written only into the client config, computed when it is written.
- The launcher is accepted only if: `node.exe` and `<same dir>/node_modules/npm/bin/npx-cli.js` are regular files, `node_modules/npm/package.json` has `name: "npm"`, and no path component is a symlink or junction. Nothing is executed to check it. If it cannot be verified, nothing is written (`MANUAL_SETUP_REQUIRED`).
- Paths with quotes, control characters, `..`, UNC prefixes or wildcard characters are refused (`MANUAL_SETUP_REQUIRED`).

## Implementation (Fact, feat/kubernetes-tool-config)

- Policy: `REVIEWED_TOOL_CONFIGS` holds the exact reviewed command (`npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config {toolConfig}`) and TOML. The parsed TOML must equal the reviewed value (comments and whitespace aside): `read_only = false`, a missing or changed Secret rule, `toolsets` with `config`, unknown keys, substitutions, paths and malformed TOML are all refused. Checked at Registry validation, before writing the file and before Health. Updates and rollbacks to versions not in the reviewed list are blocked (`TOOL_CONFIG_VERSION_UNREVIEWED`).
- InstallPlan v1 and LifecyclePlan v1 gain a `tool-config` step (logical file ID, scope, content, content digest, expected prior state, create/replace/keep) and the `tool-config` approval requirement. LifecyclePlan gains the `repair` operation. Version State gains optional `toolConfig` (file ID, scope, digest). All additive; schemaVersion stays 1; schema digests recorded in `test/fixtures/m7-final/schema-digests.json`.
- Order: approval → npx Prepare → tool config write and re-read → client configs → (Version State) → Health with the same file → state commit.
- Compensation restores only files changed by this run and only if the file still holds the bytes this run wrote; otherwise the result is a failure (`COMPENSATION_INCOMPLETE` / `rollback-failed`), never success. This conflict check also applies to ordinary client config writes now.
- Version State records the digest of the entry actually written (with absolute paths), so status does not report drift for path-only differences.
- Status adds `tool-config-missing`, `tool-config-drift` and `tool-config-relocated` (a moved or copied project whose client entry equals another project's record). `openhub lifecycle repair <toolId>` rebuilds them after approval and runs Health; nothing is repaired automatically.

## Verification results (Fact)

- Unit and integration tests (network 0): policy refusals, locations, link checks, atomic writes, stale detection, permission failure, restore conflicts, Windows path handling and launcher checks, install with three clients, PLAN_STALE after approval, replace of an existing file, compensation on a client config failure, drift, missing, health blocking, repair, relocated repair, rollback blocking and unreviewed update blocking.
- Real E2E (`kubernetes-tool-config.e2e.test.ts`, `OPENHUB_E2E=1`): approved install with real npm Prepare into a home path containing spaces, parentheses, `&` and Hangul (npm itself under `C:\Program Files\nodejs`); the three client configs hold `node.exe` + `npx-cli.js` + `--config <file>`; approved Health `healthy` (13 tools); running each client's exact command against a synthetic Kubernetes API: Secret `resources_get`/`resources_list` refused ("resource not allowed"), no Secret request reaches the API, ConfigMap readable, `configuration_view`, delete, create and exec tools unknown, fake bearer token and Secret value absent; drift detected, Health blocked, approved repair restores the file and Health passes again. Linux: `registry-remote.yml` sandbox job.
- Real clients (optional `OPENHUB_E2E_REAL_CLIENTS=1`, isolated client config directories): Claude Code 2.1.258 `claude mcp list` started the server from the OpenHub-written entry and reported "Connected". Codex CLI 0.147.0 `codex mcp list` read the same command and arguments (it does not start servers). Cursor was not installed; not verified.

## Merge conditions and follow-ups (2026-10-10)

- **Same-project repair for Codex (fixed)**: when a client entry differs from Version State only in OpenHub-managed paths (`--config` under `~/.openhub/tool-config/…/config.toml`, or `node.exe` + `npx-cli.js`), repair replaces the block that is in the file now, but only if that entry still has the digest checked at approval. Every other field is compared strictly; any other drift stays `CONFIG_DRIFT`. Unrelated TOML and other MCP entries are preserved. Regression tests: path-only change for Codex, Claude Code and Cursor repaired; changed arguments, changed security flags and an unmanaged `--config` path refused; a change after approval is `PLAN_STALE`; an external change during compensation is not overwritten (`rollback-failed` / `CONFIG_RESTORE_FAILED`).
- **Compatibility**: the v0.1.1 InstallPlan, LifecyclePlan and Version State goldens (`test/fixtures/v0.1.1-compat`) parse under the new schemas and serialize to the same bytes and digests. Existing Registry goldens (launch specs, artifacts, plans, state for the 8 tools) are unchanged.
- **Client verification levels**: Claude Code — server started from the OpenHub-written entry ("Connected"). Codex — launch verified: Codex loaded the OpenHub-written project config from a trusted project, started the server and its tool calls behaved as above (see [client-launcher-status.md](client-launcher-status.md)). Cursor — not verified. A Kubernetes Manifest must not present unverified clients as verified.
- **Update/rollback with a version change**: not verified. Only 0.0.67 is reviewed; other versions stay blocked. The allowlist is not widened for testing.
- **Node.js path change (implemented)**: Version State stores no absolute paths, and an entry whose `node.exe` was moved keeps the same bytes, so status used to report it as consistent and repair reported nothing to repair. Now lifecycle status checks the recorded launcher with the same rules as install (`verifyClientLauncher`, no execution) and reports `client-launcher-invalid`; repair treats that state as repair-needed and rewrites only the launcher after approval; Health is blocked meanwhile. No automatic change. See [client-launcher-status.md](client-launcher-status.md).

## Verification plan (implementation pull request, original)

- Fake Kubernetes API server with one synthetic Secret and one ConfigMap; synthetic kubeconfig with a fake bearer token. No real cluster or credentials.
- `tools/list`: all `readOnlyHint=true`, no `configuration_view`, no destructive or exec tool.
- `tools/call`: `resources_get` and `resources_list` for `Secret` are refused; `ConfigMap` reads work; the fake token and Secret data appear nowhere in output, plans, results, logs or client configs (the client config's `--config` path contains no secret).
- Config file bytes equal the Manifest content; tampering shows as drift; a Manifest change after approval is `PLAN_STALE`; failure after the write restores only what was changed; Version State unchanged on failure.
- Client and Health argv are identical.
- No absolute path in plans, results, reports or logs (existing scanners).
- Windows and Linux E2E (`OPENHUB_E2E=1`), plus the `registry-remote.yml` sandbox job.

## Open Questions

- Whether `toolConfig` should later become a general Manifest feature (needs a review process for fixed content per tool).
- Windows ACL hardening beyond the profile default.

## Not covered

- Secrets printed in pod or node logs (RBAC).
- Real clusters, managed Kubernetes authentication plugins (exec credentials), macOS.

