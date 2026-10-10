# Real npx lifecycle E2E (v0.2.0 release check)

Part of [v0.2.0](v0.2.0.md). Labels: **Fact**, **Decision**.

PR #19's npx smoke uses a fake npm. This test checks a real version change before v0.2.0.

## Design (Decision)

- Test: `packages/core/test/registry/npx-lifecycle-real.e2e.test.ts`, only with `OPENHUB_E2E=1` (Windows locally, Linux in the `registry-remote.yml` sandbox job). Not part of the default test run.
- Server: `@modelcontextprotocol/server-memory`, the official reference memory server. It needs no credentials, database, cluster or external service.
- Versions: V1 `2026.7.4` and V2 `2026.8.31`, two exact versions published on npm.
- The real Registry is not changed. The Registry's `memory-mcp` Manifest (`npx -y @modelcontextprotocol/server-memory`, unpinned) is copied in the test's memory and pinned to V1 there; the update target V2 is passed as `to`.
- npm cache: a temporary `npm_config_cache`, removed afterwards. Real npm and real `npx` through the normal OpenHub paths (`nodeExecSpawner`, the Windows npx launcher on Windows).
- Targets: Claude Code project and Codex project, both with an existing user entry (`notes`) and, for Codex, existing top-level TOML that must stay.

## Scenario (Fact, as run)

Install V1 (Prepare V1 into the npm cache, `prepared: cached`, `detected: true`) → Health (real MCP handshake and tools/list: healthy, 9 tools) → Update to V2 (Prepare V2, config replace on both targets, Health healthy, state commit; Version State revision 2, `previous` = V1) → Rollback to V1 (Prepare, config replace, Health healthy, state commit) → lifecycle status `state-consistent` for both → Health healthy. The `notes` entry and the Codex file's existing content are kept after every step.

Windows result (local): install, Health 1.3 s, update 17.2 s (includes downloading V2), rollback 1.5 s (V1 already in the cache), Health 1.3 s; all healthy with 9 tools. Linux result: see the sandbox run linked in the pull request.

## Limits

- This is one tool with two versions. It does not prove that every npx tool's later versions are compatible, and it does not change any Registry Manifest version.
- Kubernetes stays limited to 0.0.67 (unreviewed versions are blocked by the reviewed tool-config policy).

