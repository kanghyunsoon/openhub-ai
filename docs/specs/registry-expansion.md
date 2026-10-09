# Registry expansion (v0.2.0 P0-2)

Part of [v0.2.0](v0.2.0.md). This is the single source for how tools enter the Verified Registry, how they are checked, and the record for each batch.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question** (see [Roadmap](../roadmap.md)).

## Goal (Decision)

Grow the Verified Registry from 7 tools to 25-40, in reviewable batches. A batch adds only tools that pass every criterion below. A smaller batch is acceptable; padding is not.

## Verification criteria (Decision)

A tool enters the Registry only when all of these are checked and recorded in this document:

1. Real open-source project with a public upstream repository.
2. License identified (SPDX). No license, or a license that forbids redistribution, is a rejection.
3. Maintained: not archived, recent commits or releases.
4. Install method works with an existing backend (npx, uvx, Docker), with an exact package or image name whose registry metadata points back to the upstream repository.
5. Supported clients checked against the tool's own documentation. Where upstream does not document a client, the record says so.
6. Required permissions and environment variable names recorded (names only, never values).
7. What the tool can do when called, split into read and write operations; destructive operations identified.
8. Not a duplicate of an existing Manifest or alias.
9. `pnpm registry:validate` passes.
10. Supply-chain review: package provenance, no install scripts, no unrelated runtime dependencies, no hidden network or file access at startup.
11. Capabilities assigned from the tool's real functions, using taxonomy IDs only.
12. Real launch: OpenHub writes the client config and its Health Check (MCP `initialize` + `tools/list`) passes, from an empty and from a warm package cache.

Stars are context, not evidence of safety. A README install command is not proof that installation works.

Decision (security defaults): if a tool can run in a read-only or non-destructive mode through a command-line flag, the Manifest command fixes that flag. Modes that need an environment variable value cannot be set by OpenHub (OpenHub handles environment variable names only), so such tools are registered only if their default mode is already safe.

## How a batch is verified (Fact)

- **Registry facts**: GitHub API (license, archived, last push) and npm or PyPI metadata (version, license, repository link, install scripts, provenance attestation).
- **Tool inventory**: each server is started with an isolated home directory, an empty or synthetic kubeconfig and no credentials; a probe sends `initialize` and `tools/list` and records each tool's `readOnlyHint` and `destructiveHint`. No tool is called.
- **OpenHub end to end**: `packages/core/test/registry/sandbox.e2e.test.ts` (runs only with `OPENHUB_E2E=1`, in the `registry-remote.yml` sandbox job and locally): install plan, approval, real config writes for Claude Code, Cursor and Codex (project scope), Version State record, health plan and approval, then the real Health Check through `npx`. Locally on Windows the home and AppData directories were redirected to a temporary directory and the npm cache was a new empty directory for the cold-cache run.
- **Recommendation impact**: the same CLI run against the Registry before and after the batch, on the P0-1 fixtures.

## Batch 1 (2026-10-09/10)

Focus: Kubernetes, MongoDB, MCP reference servers.

| Candidate | Result | Main reason |
| --- | --- | --- |
| containers/kubernetes-mcp-server | **Registered** | All criteria met; read-only mode by flag |
| mongodb-js/mongodb-mcp-server | Deferred | Fails criterion 12 from an empty cache (see record) |
| Flux159/mcp-server-kubernetes | Not registered | Read-only mode needs an environment variable value; default exposes 14 destructive tools; same capability as the registered tool |
| benborla/mcp-server-mysql | Not registered | No npm provenance; unrelated runtime dependencies (`@ai-sdk/openai`, `mcp-evals`); loads `.env` from the working directory |
| designcomputer/mysql_mcp_server | Not registered | Arbitrary SQL execution with no read-only mode; reads `.env` from the working directory |
| Reference servers (filesystem, git, fetch, time, sequential-thinking, everything) | Not registered | No matching capability or overlap with client built-ins (see below) |
| mcp-server-sqlite (PyPI) | Not registered | Moved to the archived reference servers; last release 2025-04; no source link in package metadata |

Registry after batch 1: 8 tools. No taxonomy change was needed (`kubernetes-operations` already exists in taxonomy v2).

### containers/kubernetes-mcp-server (registered)

| Item | Record |
| --- | --- |
| Upstream | github.com/containers/kubernetes-mcp-server, Apache-2.0, not archived, last push 2026-10-09 |
| Package | npm `kubernetes-mcp-server` 0.0.67 (published 2026-09-18). A small Node launcher plus a Go binary from six platform packages (`kubernetes-mcp-server-{linux,darwin,windows}-{amd64,arm64}`), all pointing to the same repository with SLSA provenance attestations. No install scripts. |
| Backend | npx: `npx -y kubernetes-mcp-server --read-only`. The version floats like the other npx tools; OpenHub's resolver pins it at install time (floating-artifact approval). |
| Clients | Claude Code and Cursor are documented upstream. Codex is not documented upstream; it is a standard stdio server and the OpenHub sandbox test writes and verifies the Codex project config. |
| Platforms | Windows, macOS, Linux (amd64 and arm64 binaries) |
| Environment | `KUBECONFIG` (optional, name only). The server uses the current context of the user's kubeconfig. OpenHub never reads or edits the kubeconfig. |
| Permissions | Whatever the kubeconfig credentials allow in the cluster. Cluster RBAC is the real boundary. |
| Tools, default | 20 tools; destructive: `pods_delete`, `pods_exec`, `resources_create_or_update`, `resources_delete`, `resources_scale`; not read-only: `pods_run` |
| Tools, `--read-only` (what OpenHub installs) | 14 tools, all `readOnlyHint=true`: configuration_view, events_list, namespaces_list, nodes_log, nodes_stats_summary, nodes_top, pods_get, pods_list, pods_list_in_namespace, pods_log, pods_top, projects_list, resources_get, resources_list |
| Read-only is not "no sensitive data" | `resources_get` can read Secret objects if RBAC allows; `pods_log` and `nodes_log` return logs; `configuration_view` returns kubeconfig details (whether credentials are redacted was not verified). Use a least-privilege context. |
| Install vs cluster access | Installing only writes the client config. At startup the server does not contact the cluster (verified with an unreachable API server address); it contacts the cluster only when a tool is called. It refuses to start without a kubeconfig that has a current context, so the Health Check needs one. |
| Duplicates | None in the Registry. Alias `kubernetes`. |
| Capability | `kubernetes-operations`; `appliesTo.stacks: [kubernetes]` |
| Health Check (OpenHub) | `healthy`, tool count 14. Empty npm cache: test finished in about 15 s (under the 20 s startup limit); warm cache: about 1.4 s. |
| Unverified | Behaviour against a real cluster (not used); redaction in `configuration_view`; Linux and macOS runs (expected in the `registry-remote.yml` sandbox job). |

### mongodb-js/mongodb-mcp-server (deferred)

Facts collected:

- Apache-2.0, not archived, npm `mongodb-mcp-server` 3.0.5 with SLSA provenance, no install scripts. Node `^20.19 || ^22.13 || >=24`.
- Default: 31 tools including `delete-many`, `drop-collection`, `drop-database`, `drop-index`, `rename-collection`, `update-many`, `insert-many`, `create-index`. `--readOnly` leaves 20 `readOnlyHint` tools (find, aggregate, collection-schema, collection-indexes, explain, export and others).
- Telemetry is on by default; `--telemetry disabled` turns it off. `search-knowledge` and `list-knowledge-sources` query a MongoDB-hosted knowledge service when called.
- Credentials: `MDB_MCP_CONNECTION_STRING`; without it the agent would have to pass a connection string to the `connect` tool.
- Capability fit: `db-schema-access` and `query-tuning` (`explain`, indexes). Not `sql-query`.

Why deferred (criterion 12):

- From an empty npm cache, `npx -y mongodb-mcp-server` needed 90-110 s to install (many dependencies, several deprecated). OpenHub's Health Check startup limit is 20 s, so the first Health Check ends in `timeout`.
- The timeout stops npx in the middle of installing. The npx cache entry is left incomplete, and every later start fails with `ERR_MODULE_NOT_FOUND` until that cache entry is removed. Reproduced twice with fresh npm caches. Agent clients that stop a slow first start could hit the same state.
- With the package fully installed beforehand, the server starts in about 4-5 s and the handshake passes.

What would unblock it (Proposal, needs a decision; timeouts are not raised to hide this): an npx "prepare" step that installs the package into the cache before the first launch and Health Check, with its own limit and a clean failure, or registering through a backend whose prepare step downloads ahead (Docker pulls at install, but the Manifest Docker launch cannot pass `--readOnly`, and read-only through `MDB_MCP_READ_ONLY` would need an environment variable value).

### MCP reference servers (modelcontextprotocol/servers)

The active packages are published with provenance (npm) or from the same repository (PyPI, MIT). None is registered in batch 1:

| Server | Reason |
| --- | --- |
| memory | Already in the Registry (`memory-mcp`). |
| filesystem | Needs absolute directory arguments, which Manifests cannot carry; file editing overlaps what Claude Code, Codex and Cursor already do; broad write access. |
| git | No git capability in the taxonomy; agents run git directly; D-010 keeps `git` from creating needs. |
| fetch | Fetches arbitrary URLs; no matching capability (`library-docs` is served by Context7). |
| time, sequential-thinking | No matching capability. |
| everything | Test server for MCP clients. |

## Game editor tools (Decision)

Unity and Unreal Engine MCP servers stay discovery candidates and are not added to the Verified Registry until OpenHub can support and verify the whole flow: server install, guidance for the editor plugin, checking required settings, checking the editor connection, confirming manual steps, and clear errors when the connection fails. The `game-engine-editor` need from P0-1 stays visible as a need without a verified tool.

## Candidate list (Fact as of 2026-10-10: license, archived flag, last push; everything else Proposal until verified)

| Area | Upstream | License | Status | Likely backend | Capability | Still to verify |
| --- | --- | --- | --- | --- | --- | --- |
| Database | mongodb-js/mongodb-mcp-server | Apache-2.0 | active | npx | db-schema-access, query-tuning | deferred: first-launch install time (batch 1) |
| Infrastructure | Flux159/mcp-server-kubernetes | MIT | active | npx | kubernetes-operations | not registered in batch 1 |
| Infrastructure | hashicorp/terraform-mcp-server | MPL-2.0 | active | Docker | new capability needed | taxonomy (no Terraform stack yet) |
| Infrastructure | grafana/mcp-grafana | Apache-2.0 | active | Docker or binary | new capability needed | token scope |
| Game development | CoplayDev/unity-mcp | MIT | active | uvx plus Unity package | game-engine-editor | candidate only (Decision above) |
| Game development | CoderGamester/mcp-unity | MIT | active | npx plus Unity package | game-engine-editor | candidate only (Decision above) |
| Game development | chongdashu/unreal-mcp | none | last push 2025-04 | n/a | game-engine-editor | rejected: no license |
| Database | redis/mcp-redis | MIT | active | uvx | new capability needed | taxonomy (no Redis stack yet) |
| Database | supabase/mcp | Apache-2.0 | active | npx | db-schema-access | token scope |
| Database | neondatabase/mcp-server-neon | MIT | active | npx | db-schema-access | remote vs local mode |
| Database | benborla/mcp-server-mysql, designcomputer/mysql_mcp_server | MIT | active | npx, uvx | db-schema-access, sql-query | not registered in batch 1 |
| Docs | microsoft/markitdown (MCP package) | MIT | active | uvx | library-docs or new | package name of the MCP server |
| Docs | firecrawl/firecrawl-mcp-server | MIT | active | npx | new capability needed | requires a hosted API key |
| Backend/API | postmanlabs/postman-mcp-server | Apache-2.0 | active | npx | new capability needed | API key |
| Observability | getsentry/toolkit (Sentry MCP) | NOASSERTION | active | npx or remote | issue-tracking | license file, remote-only mode |
| Collaboration | sooperset/mcp-atlassian | MIT | active | uvx or Docker | issue-tracking | token handling |
| Collaboration | microsoft/azure-devops-mcp | MIT | active | npx | issue-tracking, pull-request-review | auth flow |
| Collaboration | makenotion/notion-mcp-server | MIT | active | npx | new capability needed | token scope |
| Security | semgrep/mcp | MIT | archived | n/a | security scanning | rejected: archived; check the maintained successor |
| Browser | executeautomation/mcp-playwright | MIT | last push 2025-12 | npx | browser-automation | overlap with Playwright MCP |
| Browser | BrowserMCP/mcp | Apache-2.0 | last push 2025-04 | npx plus extension | browser-automation | maintenance, extension install |
| Cloud | awslabs/mcp, cloudflare/mcp-server-cloudflare | Apache-2.0 | active | uvx, npx or remote | new capability needed | many servers per repo; scope per server |
| Design | GLips/Figma-Context-MCP | MIT | active | npx | new capability needed | API key |

## Taxonomy (Decision)

v0.2.0 is not released yet, so capabilities needed by tools registered during v0.2.0 are added inside `taxonomyVersion` 2, following the same rules (append only, no meaning changes, no duplicates, based on real tool functions, Registry, schema and golden tests updated). After v0.2.0 ships, any taxonomy change raises the version. Capabilities are added only for tools being registered, not for candidates.

## Open Questions

- Should OpenHub add an npx prepare step (download ahead of first launch) so that large npx packages such as MongoDB MCP Server can pass the Health Check? This is a change to the M4 `launch-on-demand` behaviour and needs a decision.
- Should `verification` move from `community` to `verified` for batch tools once the `registry-remote.yml` sandbox job passes on main?
