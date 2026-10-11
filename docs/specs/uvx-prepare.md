# uvx Prepare (v0.2.1 design, not implemented)

Status: **design for approval**. No code in this change. Companion to [npx Prepare](npx-prepare.md).

Labels: **Fact** (measured), **Proposal**, **Open Question**.

## Problem (Fact)

uvx tools are `launch-on-demand`: OpenHub writes the client config and uv resolves, downloads and installs the packages the first time something starts the tool. On a cold uv cache that work happens inside OpenHub's 20 s Health startup window.

Measured on 2026-10-11 (Windows 11, uv 0.12.3; Linux `node:22-bookworm-slim` with the official uv 0.9.30 binaries, Python 3.12 preinstalled by uv). Each case uses a new, empty `UV_CACHE_DIR`. Handshake = `initialize` + `tools/list`.

| Case | Windows | Linux |
| --- | --- | --- |
| postgres-mcp, real OpenHub Health, first run, test PostgreSQL | `startup-timeout` at 20.5 s (2 of 2) | healthy, 9.0 s |
| postgres-mcp, real OpenHub Health, cache reused | healthy, 9.3–9.9 s | healthy, 1.4–1.6 s |
| postgres-mcp, direct handshake, cold, no Prepare | 21.7 s | 8.7 s |
| serena, direct handshake, cold, no Prepare | 21.9 s | 8.5 s |

So on Windows both uvx tools in the Registry miss the limit on the first Health after install or update. Raising the limit would hide the cost and is not proposed.

## What uv can do (Fact, verified with the real CLI)

Prepare command shape (proposal), with the same `--from`/`--with` set the client will use:

```
uvx [--no-build] --compile-bytecode --from <pkg>==<X.Y.Z> [--with <dep>==<A.B.C> ...] python -c pass
```

- `uvx … python -c pass` creates the tool environment and runs the environment's Python with an empty program. It does **not** import the tool package, so the MCP server code does not run.
- The client's later start reuses that environment: after Prepare, `uvx --offline --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted` (network forbidden) started and answered `tools/list` (Windows 8.0 s first, then 2.4 s; Linux 1.0 s with `--compile-bytecode`). Argument order of `--from`/`--with` does not matter, and the Prepare flags (`--no-build`, `--compile-bytecode`) do not change which environment the client uses.
- `--compile-bytecode` moves Python bytecode compilation into Prepare. serena on Windows: without it, the first start after Prepare took 18.4 s; with it, 11.2 s (then 3.6 s). Prepare itself took 15.5 s.
- `--no-build` refuses to build source distributions, so no third-party build code runs. postgres-mcp prepares with `--no-build` (all wheels). **serena does not**: its dependency `proxy-tools` has no wheel (`Wheels are required for proxy-tools because building from source is disabled`), on both OSes. With building allowed, uv builds `proxy-tools==0.1.0` from source, which runs that package's build backend.
- A floating spec (`--from postgres-mcp`) also prepares, but a later online start may resolve a newer release, so Prepare can only promise the environment for an exact version.

## Proposal

### When it applies (same rule as npx Prepare)

| Case | Prepare |
| --- | --- |
| Install, uvx Manifest pinned to `pkg==X.Y.Z` | yes |
| Install, floating uvx Manifest (postgres-mcp, serena today) | no (see Open Questions) |
| Update / rollback to an exact version | yes |
| Rollback to an unlocked version, Health only, npx, Docker | no change |

### Plan step

`{ id: "uvx-prepare", kind: "run", executable: "uvx", args: [<build flag>, "--compile-bytecode", "--from", "<pkg>==<X.Y.Z>", ...withPins, "python", "-c", "pass"], cwd: "isolated", network: true, timeoutMs: 600000 }`

- The spec and `--with` pins must equal the plan's launch target. They are checked by the plan schema and again right before running. A different version, extra index flags or extra arguments → `PLAN_STALE` / plan rejected.
- The build flag comes from a reviewed Manifest field, not from the user:
  - `install.options.prepare.build: "wheels-only"` (default) → `--no-build`;
  - `"source-build-reviewed"` → no flag, plus an extra approval item (below). serena would need this.
- Order: plan → approval → **Prepare** → verify (`uvx --offline … python -c pass` succeeds) → client config write → Health (unchanged 20 s). If Prepare or the verify fails, nothing is written (`preparation-failed`) and Version State is unchanged.

### Cache

- Prepare must fill the **same** uv cache the client will use, so it cannot run in an isolated cache. OpenHub does not set `UV_CACHE_DIR`; uv picks the user's default, as the client will.
- OpenHub never deletes uv cache entries. A broken entry is retried with `--refresh-package <pkg>` as a separate approved retry.
- Open Question: a client started with a different `UV_CACHE_DIR` (set in its own environment) would not see the prepared environment. Health would still run, so the risk is a slow first client start, not a wrong one.

### Child environment (allowlist, like `npmChildEnv`)

- Passed: `PATH` and OS/system directories, temp and home directories, locale, XDG directories, proxy variables, `SSL_CERT_FILE` / `SSL_CERT_DIR` / `REQUESTS_CA_BUNDLE`, `UV_*` settings that select the cache, Python and index (`UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_NATIVE_TLS`, `UV_OFFLINE`), and `PIP_*` index settings.
- Not passed: AI provider keys, `GITHUB_TOKEN` / `GH_TOKEN`, cloud credentials, database URLs such as `DATABASE_URI`, MCP connection strings, `PYTHONPATH`, `PYTHONSTARTUP`, and every other user variable.
- Index credentials (`UV_INDEX_<NAME>_USERNAME` / `_PASSWORD`, credentials in an index URL) are passed only if the user already configured them for uv. They are never logged or put in the plan.
- Open Question: a private index configured only in `uv.toml` is read by both Prepare and the client, so there is no mismatch. An index set only in the client's own environment is not visible to OpenHub.

### Approval text (draft)

| ID | English | 한국어 |
| --- | --- | --- |
| (notice, all uvx Prepare) | OpenHub will download and install the Python packages for this exact version into uv's cache before writing the client configuration. The MCP server is not started during this step. | 클라이언트 설정을 쓰기 전에 이 정확한 버전의 Python 패키지를 uv 캐시에 내려받아 설치합니다. 이 단계에서는 MCP 서버를 실행하지 않습니다. |
| `source-build` (only for `source-build-reviewed` Manifests) | Some packages of this tool are only available as source and are built on your computer. Building runs third-party build code. OpenHub reviewed this tool's dependency list, but not the build code itself. | 이 도구의 일부 패키지는 소스로만 제공되어 내 컴퓨터에서 빌드됩니다. 빌드 과정에서 제3자 빌드 코드가 실행됩니다. OpenHub는 이 도구의 의존성 목록은 검토했지만 빌드 코드 자체는 검토하지 않았습니다. |

### TOCTOU and version changes

- Only exact versions are prepared. The verify step runs offline, so it cannot pull a different version.
- A re-uploaded or yanked release is not detected by uv without hash checking. Open Question: whether to require `--require-hashes` style locking for uvx tools (would need a lock file per tool).
- The plan digest covers the Prepare argv. A Manifest change between approval and run → `PLAN_STALE`.

## Open Questions (need a decision)

1. Floating uvx Manifests (postgres-mcp, serena) get no Prepare under this rule, so the Windows first Health still times out after **install**. Options:
   - (a) pin both Manifests to reviewed exact versions (postgres-mcp `0.3.0` with `mcp==1.30.0`, serena-agent `1.7.0`), which turns on Prepare and the npx-style exact update flow;
   - (b) resolve the latest version at plan time and prepare that, while the client keeps the floating spec (the first client start could still re-resolve);
   - (c) keep launch-on-demand and document "run Health again on Windows".
   - Recommendation: (a), reviewed per version like Kubernetes `0.0.67`.
2. Whether serena's source build (`proxy-tools`) is acceptable with the extra approval item, or serena should stay without Prepare.
3. Prepare time limit: 10 min like npx Prepare, or shorter for uvx.

## Not covered

macOS. Private indexes. Tools that need system libraries to build.

