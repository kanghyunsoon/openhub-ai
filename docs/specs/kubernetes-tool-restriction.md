# Kubernetes MCP Server: per-tool restriction config (design, v0.2.0 follow-up)

Part of [v0.2.0](v0.2.0.md). Status: **Proposal**, not implemented. Kubernetes MCP Server stays a Discovery Candidate until this lands; PR #7 (read-only Manifest) stays Draft and is not merged.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**.

## Why (Fact, from the PR #7 verification)

- `npx -y kubernetes-mcp-server --read-only --toolsets core` exposes 13 tools, all `readOnlyHint=true`. `--toolsets core` removes `configuration_view`, which otherwise returned kubeconfig bearer tokens, client keys and passwords (verified with a synthetic kubeconfig).
- `resources_get` with `kind: Secret` returned the Secret's `data` unredacted (verified against a local fake Kubernetes API server with one synthetic Secret). Read-only mode does not stop this: reading a Secret is a read.
- Upstream can deny resource kinds only through a TOML config file (`--config <file>`, or `--config-dir`): `[[denied_resources]]` with `group`, `version`, `kind`. Relative paths are resolved against the server's working directory (upstream README). A Manifest v1 `command` can carry flags but OpenHub has no way to create or own such a file.
- `pods_log` and `nodes_log` can return secrets that workloads print. No server option covers this; cluster RBAC is the real boundary.

## Decision (already in force)

- Do not register Kubernetes MCP Server in the Verified Registry until Secret access can be denied by OpenHub-managed configuration and that denial is verified with `tools/call`.
- Do not raise or relax any existing limit to get there.

## Proposal

1. **Manifest: declared tool configuration (additive, Manifest v1).** A new optional block, for example:

   ```yaml
   install:
     options:
       command: "npx -y kubernetes-mcp-server@<X.Y.Z> --config {toolConfig}"
   toolConfig:
     format: toml
     content: |
       read_only = true
       toolsets = ["core"]
       [[denied_resources]]
       group = ""
       version = "v1"
       kind = "Secret"
   ```

   `content` is fixed text reviewed with the Manifest (no templating, no environment values, no user input). `{toolConfig}` is the only placeholder, and only OpenHub fills it.
2. **OpenHub writes and owns the file.** Written as a normal plan step after approval and before client config writes, with the same atomic write, compensation and symlink/junction checks as client configs. Its digest goes into the InstallPlan, so a changed Manifest config makes an approved plan `PLAN_STALE`. Lifecycle drift detection covers it like a client config entry. Rollback restores it with the config.
3. **Plan display.** The preview shows the generated config verbatim and states plainly: the server acts with the kubeconfig's current context and the permissions of that user; OpenHub does not read the kubeconfig; Secret reads are denied by server config, but logs can still contain secrets, so a read-only RBAC user is recommended.
4. **Exact version.** Pin the npm package so npx Prepare applies and the config is verified against a known server version (`denied_resources` semantics can change between releases).

## Open Questions (need a Decision before implementation)

- **Where the file lives and how the client config refers to it.** OpenHub does not persist absolute paths in plans and results (D-016 kept `cmd` relative for the same reason). Options: (a) project scope `.openhub/tool-config/<tool>.toml` referenced by a relative path, which needs each client's working directory for stdio servers to be measured (Claude Code, Cursor, Codex; not yet measured); (b) user scope under `~/.openhub/`, which needs an absolute path in the client config and an exception to the no-absolute-path rule for that one argument; (c) upstream adds an environment variable or inline option that avoids the file. No option is chosen here.
- Whether `toolConfig` is a general Manifest feature or limited to an allowlist of reviewed tools.
- Whether Health should start the server with the generated config (it should, so Health checks what the client runs; needs the same file at Health time).

## Verification plan (for the implementation PR)

- Fake Kubernetes API server with one synthetic Secret and one ConfigMap, synthetic kubeconfig with a fake token, no real cluster or credentials.
- `tools/list`: every tool `readOnlyHint=true`, no `configuration_view`, no destructive tool.
- `tools/call`: `resources_get` and `resources_list` for `Secret` are refused; the same calls for `ConfigMap` work; the fake token and Secret data appear nowhere in output, plan, result or logs.
- The config file bytes equal the Manifest content; tampering with the file shows as drift; a Manifest change makes the approved plan `PLAN_STALE`; failure to write it leaves client configs untouched.
- Windows and Linux E2E (`OPENHUB_E2E=1`), plus the `registry-remote.yml` sandbox job.

## Not covered

- Secrets printed in pod or node logs (RBAC).
- Real clusters, managed Kubernetes authentication plugins (exec credentials), macOS.

