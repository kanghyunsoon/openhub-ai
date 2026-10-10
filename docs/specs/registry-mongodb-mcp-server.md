# Registry: MongoDB MCP Server verification (v0.2.0 P0-2)

Part of [v0.2.0](v0.2.0.md) P0-2. Manifest: `registry/database/mongodb-mcp-server.yaml`. Install path: [npx Prepare](npx-prepare.md).

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**. All facts measured on 2026-10-10 unless stated.

## Manifest (Decision)

| Field | Value | Why |
| --- | --- | --- |
| Command | `npx -y mongodb-mcp-server@3.0.5 --readOnly --telemetry disabled` | Exact version, so npx Prepare downloads it after approval and before client configs are written. `--readOnly` and `--telemetry disabled` are fixed in every client config. |
| Version | 3.0.5 | Latest stable release (npm and GitHub release, 2026-10-01). `3.1.0-pre.1` exists and is not used. |
| Capabilities | `db-schema-access`, `query-tuning` | collection schema, indexes, `explain`, read queries. Not `sql-query`: the server does not run SQL. |
| Stack | `mongodb` | Existing detector and Need Rule NR-04 (`mongodb` → `db-schema-access`). |
| Environment | `MDB_MCP_CONNECTION_STRING` (required, name only) | OpenHub never reads, checks or stores the value (Health is `environment-unverified` as for other required-env tools). |
| Node | `>=20.19` | Upstream engines `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0`; OpenHub's range format cannot express `\|\|`, so 21.x and 22.0-22.12 are not excluded by this field. |
| Catalog | `addedAt: "2026-10-10"` | Date of acceptance. |

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
| 9 | Supply chain | 3.0.5 was published by GitHub Actions (npm trusted publishing) with an SLSA v1 provenance attestation; npm maintainers are MongoDB accounts. The package itself has no install scripts. Its dependency tree (421 packages) has 7 with install scripts, run by npm during Prepare as they would be on a client's first start: `ssh2` (`node install.js`, optional native crypto binding), `@modelcontextprotocol/ext-apps` (`postinstall` points at a script not shipped in the package and falls back to `echo`), and five optional native modules: `kerberos` and `mongodb-client-encryption` (`prebuild-install`, downloads the prebuilt binary from that package's own GitHub release, else `node-gyp`), `os-dns-native`, `win-export-certificate-and-key`, `cpu-features` (`node-gyp`). Four of the seven are mongodb-js packages. npm receives only the environment allowlist (no API keys, cloud credentials or `MDB_MCP_CONNECTION_STRING`). |
| 10 | Capabilities from real functions | See Manifest table. |

## Read-only behaviour (Fact)

Disposable `mongo:8.0` container bound to 127.0.0.1, synthetic root user and password, one database with 3 documents and 2 indexes. The server was started exactly as the client config starts it, with the connection string in the environment.

- `tools/list`: 20 tools, all `readOnlyHint=true`: aggregate, aggregate-db, atlas-local-connect-deployment, atlas-local-list-deployments, collection-indexes, collection-schema, collection-storage-size, connect, count, db-stats, disconnect, explain, export, find, list-collections, list-connections, list-databases, list-knowledge-sources, mongodb-logs, search-knowledge. Without `--readOnly` there are 31 (insert, update, delete, drop, create, rename tools among them).
- Calls to `insert-many`, `update-many`, `delete-many`, `drop-collection`, `drop-database`, `create-index`, `create-collection`, `rename-collection`: JSON-RPC error "Tool … not found".
- `aggregate` with `$out`, `$merge` (also `$out` to another database) and `aggregate-db` with `$documents` + `$out` / `$merge`: refused, "In readOnly mode you can not run pipelines with $out or $merge stages".
- `find`, `count`, `explain`: work (3 documents).
- After all calls the database is unchanged (document count, no modified documents, collections, index count).

This is enforcement inside the MCP server, not a database permission. A read-only database user is still the real boundary; the Manifest's environment description (shown in the install preview) recommends one.

## Credentials and telemetry (Fact)

- The synthetic password and user name appear in none of: the three client configs, InstallResult, Health result, MCP output for all calls above, or the server's log files. `list-connections` shows only "preconfigured".
- Server log: "Telemetry is disabled." and 0 telemetry events flushed.

## Install, Prepare and Health (Fact)

| Check | Result |
| --- | --- |
| Client-style first start from an empty npm cache, no Prepare | 153 s until `initialize` answered (OpenHub Health limit is 20 s: `timeout`, and an interrupted install leaves a broken entry; see [npx-prepare.md](npx-prepare.md)). |
| With npx Prepare, real Registry Manifest (Windows, real npm, isolated npm cache; `sandbox.e2e.test.ts`) | approval → Prepare + three client configs 155 s → Version State → approved Health `healthy` in 3.0 s, 20 tools (Health limit unchanged). Same test then runs the read-only and credential checks above against the disposable database. |
| Interrupted Prepare (20 s) | only this attempt's entry cleaned, retry installs, reuse passes file checks, a damaged entry is kept (`NPX_CACHE_DAMAGED`) and installs after manual removal. |
| Two concurrent Prepares plus an external `npx` | all finish; the final entry passes the file checks. |
| Windows E2E (`npx-prepare.e2e.test.ts` with the MongoDB command, 3 tests) | 3/3 pass, 958 s in total (several full downloads). |
| Linux | `registry-remote.yml` sandbox job runs the same `sandbox.e2e.test.ts` case (result in the pull request). |

## Risks kept (not blocked by OpenHub)

- `connect` stays available in read-only mode: an agent can connect to another deployment if a connection string is put into the conversation.
- `search-knowledge` and `list-knowledge-sources` contact a MongoDB-hosted knowledge service when called.
- `export` writes query results to files on the local disk (read-only for the database, not for the file system).
- `atlas-local-*` list and connect to local Atlas deployments.
- Data returned by `find`/`aggregate` goes to the agent; the server marks it as untrusted user data.

