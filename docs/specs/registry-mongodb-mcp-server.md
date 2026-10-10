# Registry: MongoDB MCP Server verification (v0.2.0 P0-2)

Part of [v0.2.0](v0.2.0.md) P0-2. Manifest: `registry/database/mongodb-mcp-server.yaml`. Install path: [npx Prepare](npx-prepare.md).

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**. All facts measured on 2026-10-10 unless stated.

## Manifest (Decision)

| Field | Value | Why |
| --- | --- | --- |
| Command | `npx -y mongodb-mcp-server@3.0.5 --readOnly --telemetry disabled --disabledTools export,connect,search-knowledge,list-knowledge-sources,atlas-local-connect-deployment,atlas-local-list-deployments,mongodb-logs` | Exact version, so npx Prepare downloads it after approval and before client configs are written. The flags are fixed in every client config. |
| Default scope | schema, collections, indexes, read queries, `explain` | Connecting to arbitrary deployments, the MongoDB-hosted knowledge service, local file export, local Atlas deployments and server logs are outside OpenHub's default registration and are disabled. |
| Version | 3.0.5 | Latest stable release (npm and GitHub release, 2026-10-01). `3.1.0-pre.1` exists and is not used. |
| Capabilities | `db-schema-access`, `query-tuning` | collection schema, indexes, `explain`, read queries. Not `sql-query`: the server does not run SQL. |
| Stack | `mongodb` | Existing detector and Need Rule NR-04 (`mongodb` → `db-schema-access`). |
| Environment | `MDB_MCP_CONNECTION_STRING` (required, name only) | OpenHub never reads, checks or stores the value (Health is `environment-unverified` as for other required-env tools). The Manifest description asks for a user with only the `read` role. |
| Node | `>=24` | Upstream engines are `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0`. OpenHub's range format has no `\|\|`, and `>=20.19` would also accept 21.x and 22.0-22.12, which upstream does not support. `>=24` excludes only supported versions (20.19+, 22.13+), never accepts an unsupported one. Revisit if the range format gains `\|\|`. |
| Catalog | `addedAt: "2026-10-10"` | Date of acceptance. |

### `--disabledTools` syntax (Fact, measured against 3.0.5)

- The option takes tool names, operation types or categories. Disabled tools are not registered at all (`verifyAllowed` runs before registration), so they are absent from `tools/list` and a direct `tools/call` gets "Tool … not found".
- **The space-separated form shown in the upstream README (`--disabledTools export connect …`) applies only the first name** and silently ignores the rest (19 tools listed instead of 12). The comma-separated single argument (`--disabledTools export,connect,…`) applies all of them. The Manifest uses the comma form; a unit test rejects a space-separated list, and the E2E test asserts the exact tool list so a silent misparse fails.
- The comma form survives the Windows client launch wrapper (`cmd /d /c npx …`, D-016): measured 12 tools through `cmd`.
- Disabling `connect` also removes `disconnect`. The preconfigured connection from `MDB_MCP_CONNECTION_STRING` still works (`connectionId: "preconfigured"`).

### Install plan notice (Decision)

InstallPlan gains a fixed warning `database-credential-scope` for tools in the `database` category with a required environment variable (MongoDB, Postgres): the server acts with the permissions of the connection's user, the server's read-only setting does not reduce database permissions, so use a read-only account. The text is OpenHub's own; Manifest env descriptions are still never copied into a plan (AC-027-06: a description could contain a secret). The warning `code` is free text in InstallPlan v1, so the schema does not change; Postgres plans gain the warning (golden updated).

## Verification criteria (v0.2.0 P0-2)

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Open-source upstream | mongodb-js/mongodb-mcp-server (MongoDB, Inc.). |
| 2 | License | Apache-2.0 (GitHub and npm). |
| 3 | Maintained | Not archived; last push 2026-10-09; releases 3.0.1-3.0.5 in September-October 2026. |
| 4 | Install method | npx, package `mongodb-mcp-server` on npm, exact version 3.0.5. |
| 5 | Clients | stdio server; Claude Code, Cursor and Codex config written and verified by OpenHub's config writers (E2E below). |
| 6 | Permissions and env | One required env name; database access is whatever the connection string's user may do (see risks). |
| 7 | Not a duplicate | New alias `mongodb`; no other MongoDB tool in the Registry. |
| 8 | `registry:validate` | Pass (8 Manifests). |
| 9 | Supply chain | 3.0.5 was published by GitHub Actions (npm trusted publishing) with an SLSA v1 provenance attestation; npm maintainers are MongoDB accounts. The package itself has no install scripts. Its dependency tree (421 packages) has 7 with install scripts, run by npm during Prepare as they would be on a client's first start: `ssh2` (`node install.js`, optional native crypto binding), `@modelcontextprotocol/ext-apps` (`postinstall` points at a script not shipped in the package and falls back to `echo`), and five optional native modules: `kerberos` and `mongodb-client-encryption` (`prebuild-install`, downloads the prebuilt binary from that package's own GitHub release, else `node-gyp`), `os-dns-native`, `win-export-certificate-and-key`, `cpu-features` (`node-gyp`). Four of the seven are mongodb-js packages. npm receives only the environment allowlist (no API keys, cloud credentials or `MDB_MCP_CONNECTION_STRING`). This risk is accepted, not removed: the prebuilt binaries are not verified by OpenHub. |
| 10 | Capabilities from real functions | See Manifest table. |

## Read-only and disabled-tool behaviour (Fact)

Disposable `mongo:8.0` container bound to 127.0.0.1, synthetic root user and password, one database with 3 documents and 2 indexes. The server was started exactly as the client config starts it (same argv as Health), with the connection string in the environment.

- `tools/list`: exactly 12 tools, all `readOnlyHint=true`, none destructive: aggregate, aggregate-db, collection-indexes, collection-schema, collection-storage-size, count, db-stats, explain, find, list-collections, list-connections, list-databases. (With `--readOnly` alone: 20; with no flags: 31.)
- Direct calls to the disabled tools `export`, `connect`, `search-knowledge`, `list-knowledge-sources`, `atlas-local-connect-deployment`, `atlas-local-list-deployments`, `mongodb-logs` and `disconnect`: "Tool … not found".
- Calls to `insert-many`, `update-many`, `delete-many`, `drop-collection`, `drop-database`, `create-index`, `create-collection`, `rename-collection`: "Tool … not found".
- `aggregate` with `$out` or `$merge` and `aggregate-db` with `$documents` + `$out` / `$merge`: refused, "In readOnly mode you can not run pipelines with $out or $merge stages".
- `find`, `count`, `explain`: work (3 documents).
- After all calls the database is unchanged (document count, no modified documents, collections, index count).

This is enforcement inside the MCP server, not a database permission. A read-only database user is the real boundary; the install plan says so (`database-credential-scope`).

## Credentials and telemetry (Fact)

- The synthetic password and user name appear in none of: the three client configs, InstallResult, Health result, MCP output for all calls above, or the server's log files (log path redirected to a temporary directory in the test).
- Server log: "Telemetry is disabled." (asserted by the E2E test) and 0 telemetry events flushed.

## Install, Prepare and Health (Fact)

| Check | Result |
| --- | --- |
| Client-style first start from an empty npm cache, no Prepare | 153 s until `initialize` answered (OpenHub Health limit is 20 s: `timeout`, and an interrupted install leaves a broken entry; see [npx-prepare.md](npx-prepare.md)). |
| With npx Prepare, real Registry Manifest (Windows, real npm, isolated npm cache; `sandbox.e2e.test.ts`) | approval → Prepare + three client configs 384 s (this run; 155 s in an earlier run, download time varies; Prepare limit 600 s) → Version State → approved Health `healthy` in 6.7 s, 12 tools (Health limit 20 s unchanged). The same test then runs the read-only, disabled-tool, credential and telemetry checks above against the disposable database. |
| Linux (`registry-remote.yml` sandbox job, run 38031942692, same `sandbox.e2e.test.ts` case) | Prepare + three client configs 26 s; Health `healthy` in 0.9 s, 12 tools; disabled-tool, read-only, unchanged-data, credential and telemetry checks pass. The job uses `continue-on-error`; the test-level log was checked. |
| npx Prepare E2E with this package (`npx-prepare.e2e.test.ts`, Windows, earlier command without `--disabledTools`; Prepare only uses the package spec, so the added flag does not change it) | empty cache, interrupted Prepare (20 s) + retry, damaged entry kept (`NPX_CACHE_DAMAGED`) + manual removal, two concurrent Prepares plus an external `npx`: 3/3 pass, 958 s in total. |

## Risks kept (not blocked by OpenHub)

- Read-only and disabled tools are server-side policy. A database user with write rights can still be misused if the server or its flags change; use a `read`-role user.
- Data returned by `find`/`aggregate` goes to the agent; the server marks it as untrusted user data.
- Dependency install scripts and unverified prebuilt native binaries during Prepare (criterion 9).
- `--disabledTools` parsing is version-specific; any version change must re-run the exact tool-list assertion.

