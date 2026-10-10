# Registry: Kubernetes MCP Server verification (v0.2.0)

Part of [v0.2.0](v0.2.0.md). Manifest: `registry/mcp/kubernetes-mcp-server.yaml`. Tool config design and implementation: [kubernetes-tool-restriction.md](kubernetes-tool-restriction.md). Install path: [npx Prepare](npx-prepare.md).

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**. All facts measured on 2026-10-10 unless stated.

## Manifest (Decision)

| Field | Value | Why |
| --- | --- | --- |
| Command | `npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config {toolConfig}` | Must equal the reviewed command in `REVIEWED_TOOL_CONFIGS` byte for byte; anything else is refused at plan time. Exact version, so npx Prepare downloads it after approval and before client configs are written. |
| Tool config | `read_only = true`, `toolsets = ["core"]`, `[[denied_resources]]` for core `v1` `Secret` | Must equal the reviewed TOML byte for byte. Written by OpenHub under `~/.openhub/tool-config/`, never inside the project. |
| Version | 0.0.67 | Latest release (npm `latest` and GitHub release v0.0.67, 2026-09-18). Only reviewed versions are allowed; update and rollback to any other version are refused (`TOOL_CONFIG_VERSION_UNREVIEWED`). |
| Capability | `kubernetes-operations` | Lists and reads cluster resources, pods, events, logs and metrics. |
| Stack | `kubernetes` | Existing detector (manifests, Helm charts, kustomize) and Need Rule for `kubernetes-operations`. |
| Environment | `KUBECONFIG` (optional, name only) | OpenHub never reads, checks or stores the kubeconfig or its value. The server uses the kubeconfig's current context. |
| Category | `mcp`, `automation` | |
| Alias | `kubernetes` | Canonical MCP server name, unique in the Registry. |
| Catalog | `addedAt: "2026-10-10"` | Date of acceptance. |

### Install plan notices (Decision)

- `tool-config` (fixed text): OpenHub writes the server policy file and passes it with `--config`; the server acts with the kubeconfig user's permissions; OpenHub does not read the kubeconfig; secrets printed in pod or node logs are not blocked; use a read-only RBAC user.
- `client-launch-unverified` (new): one warning per selected client that has not been verified to start the server from an OpenHub-written entry. Codex: configuration recognized only, MCP connection and tool calls not verified. Cursor: not verified. Claude Code has no warning.
- `platform-unverified` (new): shown on macOS, where no real install or run was done.
- The warning `code` is free text in InstallPlan v1, so the schema does not change. Existing tools get none of these warnings (their goldens change only because the Registry digest changed).

## Verification criteria

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Open-source upstream | containers/kubernetes-mcp-server. |
| 2 | License | Apache-2.0 (GitHub and npm). |
| 3 | Maintained | Not archived; last push 2026-10-09; 2152 stars (context, not evidence of safety). |
| 4 | Install method | npx, package `kubernetes-mcp-server` on npm, exact version 0.0.67. |
| 5 | Clients | stdio server. Claude Code, Codex and Cursor configs are written by OpenHub's config writers; verification levels per client below. |
| 6 | Permissions and env | One optional env name. Cluster access is whatever the kubeconfig user may do (see risks). |
| 7 | Not a duplicate | New alias `kubernetes`; no other Kubernetes tool in the Registry. PR #7 (earlier Draft without tool config) is superseded and stays unmerged. |
| 8 | `registry:validate` | Pass (9 Manifests). |
| 9 | Supply chain | The package is a thin `bin/index.js` launcher with six platform-specific optional dependencies (`kubernetes-mcp-server-{linux,darwin,windows}-{amd64,arm64}`, each 0.0.67) that carry the Go binary. npm reports no install scripts for the main package or the checked platform packages (windows-amd64, linux-amd64). The main package and both checked platform packages have SLSA v1 provenance attestations. npm maintainer: one upstream maintainer account. The Go binary itself is not rebuilt or verified by OpenHub. |
| 10 | Capabilities from real functions | See Manifest table. |

## Behaviour with the reviewed config (Fact)

Measured with the real Registry Manifest (`kubernetes-tool-config.e2e.test.ts`, `OPENHUB_E2E=1`) against a local fake Kubernetes API server with a synthetic kubeconfig (fake token and fake certificate data, no real cluster or credentials). The server is started exactly as each client config starts it.

- `tools/list`: 13 tools: events_list, namespaces_list, nodes_log, nodes_stats_summary, nodes_top, pods_get, pods_list, pods_list_in_namespace, pods_log, pods_top, projects_list, resources_get, resources_list. `configuration_view` and all write tools are absent.
- `resources_get` and `resources_list` for `Secret`: refused by the server; the fake API server received no Secret request.
- `resources_get` for a `ConfigMap`: works.
- The fake token and the fake Secret data appear in none of: the client configs, the tool config, InstallPlan, InstallResult, Health result, Version State or MCP output.

## Install, Health, drift and repair (Fact)

| Check | Result |
| --- | --- |
| Windows, real npm and npx | approval → npx Prepare → tool config → Claude Code, Codex and Cursor project configs: 2.3 s (warm cache). Client entries use direct launch `node.exe <npx-cli.js> -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config <tool config>` (no `cmd`). Health `healthy`, 13 tools. |
| Drift and repair | Changed tool config → `tool-config-drift`, Health and update blocked; approved repair → `repaired`, Health `healthy`, same 13 tools. |
| Real clients (`OPENHUB_E2E_REAL_CLIENTS=1`, isolated client homes) | Claude Code 2.1.258 `claude mcp list`: started the server from the OpenHub-written entry, "Connected". Codex CLI 0.147.0 `codex mcp list`: read the same command and arguments (it does not start servers). |
| Linux | `registry-remote.yml` sandbox job on this branch (run recorded in the pull request). |
| Failure and compensation (flow tests on the Registry Manifest) | A client config write failure restores only what this run wrote (existing bytes kept); a tool config that cannot be written (junction in the path) writes no client config; an external change during compensation is not overwritten (`COMPENSATION_INCOMPLETE` / `CONFIG_RESTORE_FAILED`). Same-project path-only repair for Codex, Claude Code and Cursor; changed arguments or security flags refused; change after approval `PLAN_STALE`. |

## Client and platform verification levels (Decision)

| Client or platform | Level | Shown in install plan |
| --- | --- | --- |
| Claude Code | launch verified (server started, "Connected") | no warning |
| Codex | configuration recognized; MCP connection and tool calls not verified | `client-launch-unverified` |
| Cursor | not verified (not installed on the test machine) | `client-launch-unverified` |
| Windows, Linux | install, Health, drift and repair verified | no warning |
| macOS | not verified | `platform-unverified` |

Proposal: when a level changes, update `clientVerification` / `platformVerified` in `REVIEWED_TOOL_CONFIGS` with the evidence, never by assumption.

## Risks kept (not blocked by OpenHub)

- Pod and node logs (`pods_log`, `nodes_log`) can contain secrets printed by workloads. No server option covers this.
- `read_only` and the Secret deny rule are server-side policy. The kubeconfig user's RBAC is the real boundary; the install plan recommends a read-only RBAC user.
- The server uses whatever context is current in the kubeconfig; switching context switches the cluster.
- Managed Kubernetes authentication plugins (exec credentials) and real clusters were not tested.
- Node.js moved or reinstalled on Windows invalidates the absolute `node.exe` / `npx-cli.js` path in client entries; detection (`client-launcher-invalid`) is designed but not implemented ([kubernetes-tool-restriction.md](kubernetes-tool-restriction.md)).
- Version-change update and rollback were not exercised: 0.0.67 is the only reviewed version, and the allowlist is not widened for testing.
