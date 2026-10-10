# Kubernetes MCP Server: tool restriction config (design, v0.2.0 follow-up)

Part of [v0.2.0](v0.2.0.md). Status: **Decision** for storage location and security policy (2026-10-10); implementation in a separate pull request (`feat/kubernetes-tool-config`). Kubernetes MCP Server stays a Discovery Candidate until that implementation and its E2E pass; PR #7 (read-only Manifest) stays Draft and is not merged.

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

## Verification plan (implementation pull request)

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

