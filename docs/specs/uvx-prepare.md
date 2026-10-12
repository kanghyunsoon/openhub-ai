# uvx Prepare (v0.2.1 design)

Status: **design approved** (2026-10-11); source-build section revised twice on 2026-10-12. After the second #45 review, **reviewed source builds are blocked in v0.2.1** until a policy decision is made. Implementation: #45 (Draft). Companion to [npx Prepare](npx-prepare.md).

Labels: **Fact** (measured), **Decision** (approved), **Open** (known limit, not blocking).

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

## Decisions

| # | Decision |
| --- | --- |
| D1 | Prepare only exact versions: `--from <pkg>==X.Y.Z` and every `--with` also `==X.Y.Z`. Floating specs stay launch-on-demand. |
| D2 | Registry Manifests for uvx tools are pinned to reviewed versions (postgres-mcp `0.3.0` with `mcp==1.30.0`; serena-agent `1.7.0` after verification), which turns on Prepare and the exact update flow. The pins are made in the Registry PR (#39), not in the engine PR. |
| D3 | Wheels only by default (`--no-build`). There is no automatic fallback to a source build. **v0.2.1: `source-build-reviewed` is blocked** (`UVX_SOURCE_BUILD_DISABLED` at plan time, at Prepare time and in Registry validation), because the build whose result the client uses cannot be verified. See "Reviewed source build: blocked in v0.2.1". The Manifest list format (name, exact version, `pypi-sdist`, sha256) is kept for a later decision. |
| D4 | Order: plan → approval → **Prepare** → offline verify → client config write → Health. A Prepare or verify failure means zero config changes and Version State unchanged. |
| D5 | Health startup limit stays 20 s. Prepare has its own limit of at most 10 min (600 000 ms, same as npx Prepare). |
| D6 | On timeout, failure or cancel, the uv process tree is killed and its exit confirmed (same mechanism as npx Prepare). If the exit cannot be confirmed, the result says so. |
| D7 | No version change after approval: the plan digest covers the Prepare argv, and the runner re-checks that the spec and `--with` pins equal the launch target. A Manifest change → `PLAN_STALE`. |
| D8 | Child environment is an allowlist (below). AI/API keys, tokens, cloud credentials and database URLs are never passed. Package-source settings from environment variables **and from the user/system `uv.toml`** are fingerprinted into the plan (without credentials), so a change between approval and run → `PLAN_STALE`. No credentials in logs, results or the plan. |
| D9 | OpenHub never deletes uv cache entries. |

## Design

### When it applies (same rule as npx Prepare)

| Case | Prepare |
| --- | --- |
| Install, uvx Manifest pinned to `pkg==X.Y.Z` (and all `--with` pinned) | yes |
| Install, floating uvx Manifest, or extra uv flags before the command | no (launch-on-demand, as today) |
| Update / rollback to an exact version | yes |
| Rollback to an unlocked version, Health only, npx, Docker | no change |

### Plan step

`{ id: "uvx-prepare", kind: "run", executable: "uvx", args: [<"--no-build" unless source build>, "--compile-bytecode", "--from", "<pkg>==<X.Y.Z>", ...("--with", "<dep>==<A.B.C>"), "python", "-c", "pass"], cwd: "isolated", network: true, timeoutMs: 600000 }`, with `artifact.preparation: "uv-cache"`.

- The spec and `--with` pins must equal the plan's launch target. The plan schema checks this, and the runner checks it again right before running. A different version, index flags or extra arguments → plan rejected.
- The build flag comes from a reviewed Manifest field, never from the user:

  ```yaml
  install:
    options:
      command: "uvx --from serena-agent==1.7.0 serena start-mcp-server"
      prepare:
        build: source-build-reviewed      # default: wheels-only; blocked in v0.2.1
        sourceBuild:
          - { package: proxy-tools, version: 0.1.0, source: pypi-sdist, sha256: ccb3751f529c047e2d8a58440d86b205303cf0fe8146f784d1cbcd94f0a28010 }
  ```

  `wheels-only` (default) → `--no-build`. `source-build-reviewed` → blocked in v0.2.1 (plan blocker, Prepare refusal, Registry validation issue). The parser still checks the list (missing or malformed sha256 rejected, duplicates rejected after PEP 503 name normalization, unknown keys and non-exact versions rejected) so a future decision does not need a schema change.
- Verify: `uvx --offline [--no-build] --from … --with … python -c pass` must succeed (network forbidden), so the client's later start finds the same environment.

### Reviewed source build: blocked in v0.2.1 (revised 2026-10-12, second review)

**Decision now in the code (#45):** `source-build-reviewed` is **blocked**. The plan gets `UVX_SOURCE_BUILD_DISABLED`, the Prepare runner refuses the step before any download or process (defence in depth), and Registry validation rejects a Manifest that uses it. Wheels-only Prepare is unchanged. A policy decision is needed before source builds come back (options at the end of this section).

Measured with uv 0.12.3 on Windows. Test package: serena-agent 1.7.0, whose dependency `proxy-tools` 0.1.0 is sdist-only (`setup.py`, no `pyproject.toml`). Each case used a fresh `UV_CACHE_DIR`.

| Step | What happens | Can OpenHub verify it? |
| --- | --- | --- |
| 1. sdist hash | The reviewed sdist sha256 can be checked twice: against PyPI's JSON and against the downloaded bytes. | **Yes.** Fact: matched `ccb3751f…a28010`. |
| 2. Build dependencies | `uv build` creates an isolated build environment and installs the PEP 517 fallback `setuptools>=40.8.0` from the index. At the time of testing that resolved to setuptools 84.0.0, with its vendored packages, and then ran `setup.py`. | **Yes, for `uv build`.** With `--build-constraints` holding `setuptools==84.0.0 --hash=…`, a wrong hash fails even without `--require-hashes`. `--require-hashes` also rejects unpinned build requirements. |
| 3. First wheel | `uv build --wheel` on the verified file produces `proxy_tools-0.1.0-py3-none-any.whl`. | **Yes,** if steps 1 and 2 are pinned. |
| 4. Client cache preparation | The client later runs `uvx --from serena-agent==1.7.0 …` without OpenHub's options. On a cache without a build of the PyPI sdist, it resolves on its own and builds `proxy-tools` again: it downloads the sdist and installs setuptools. | **No.** See the next row. |
| 5. Integrity of that second build's inputs | `uvx` does **not** check hashes. A wrong sdist hash in `--constraints` still built and exited 0. So did a wrong setuptools hash in `--build-constraints`, a wrong hash in `--with-requirements`, and runs with `UV_REQUIRE_HASHES=1` or `UV_VERIFY_HASHES=1`. `uvx --help` has no `--require-hashes`. | **No.** |
| 6. Reusing the reviewed wheel instead | After `uvx --no-build --find-links <reviewed wheels>`, the client's own command does not reuse that environment: `--offline` fails, and `--no-build` fails asking for a build of `proxy-tools`. | **No,** not without changing the client's launch command. |

So the earlier two-phase design (verified first build, then a second `uvx` build to fill the client's cache) verified the first build's inputs but **not** the second. The second build is the one whose result the client uses.

Two guards from the earlier design are not security gates and must not be described as one:

- **`--no-build-package`** only forbids building the packages it names. It does not check the inputs of the package that is still allowed to build.
- **`Built name==version`** lines are read after the build has already run. They detect a mismatch; they do not prevent build code from running.

**Client launch command for pinned wheels-only tools (v0.2.1, #45 review):** the command OpenHub writes into the client configuration starts with `--no-build`, for example `uvx --no-build --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted`. Prepare, verify, Health, Benchmark and the client therefore run the same pinned packages with the same build rule.

- If the client re-resolves (cache cleaned with `uv cache clean` or `prune`, a different cache, a new machine), it downloads wheels again but **does not build** anything. A tool that needs a source build fails with uv's "Wheels are required … building from source is disabled" message instead of running an unreviewed build. Measured with uv 0.12.3 on Windows and Linux, empty cache: `uvx --no-build --from serena-agent==1.7.0 serena start-mcp-server` fails without a `Built` line; the same command without `--no-build` (the v0.2.0 form) builds `proxy-tools==0.1.0`; the postgres client command with `--no-build` starts and answers MCP `initialize` both offline after Prepare (`UV_OFFLINE=1`) and on an empty cache.
- Only pinned commands that OpenHub prepares get the flag. Floating (launch-on-demand) commands are written as the Manifest has them; there is no automatic fallback that adds or removes the flag at run time.
- Compatibility: a Version State entry recorded before this change (pinned, without `--no-build`) still reads as managed and in sync. Health and Benchmark run it with `--no-build` added; update writes the new form; rollback restores the recorded version and adds `--no-build`. Released v0.2.0 data has no such entries (the Registry uvx tools on `main` are floating), so this path is covered by tests only.
- Adopt: for a pinned wheels-only Manifest, the reviewed standard entry includes `--no-build`. An existing entry without it is a different launch (it may build from source) and is not adopted (`ADOPT_ENTRY_UNSUPPORTED`).

**Still true for every uvx tool:** the client runs its own `uvx` with its own environment and uv settings. OpenHub cannot stop a user or another tool from editing the client entry and removing `--no-build`; status then reports config drift.

**Existing exposure, unchanged by this PR:** the Registry serena Manifest on `main` is still floating (`uvx --from serena-agent …`, launch-on-demand). Installing it writes that command, and on its first start the **client** builds `proxy-tools` from source with whatever setuptools the index serves. OpenHub has not reviewed or verified that build. Pinning serena is #39, which depends on this decision.

**Options for the policy decision:**

1. **Keep source builds blocked.** Serena stays unavailable as a pinned tool. Separately decide whether the floating serena Manifest stays installable with an explicit notice that the client builds from source, or is removed from install.
2. **Reviewed wheel store.** OpenHub builds the wheel with steps 1–3 fully hash-pinned and stores it in an OpenHub-managed folder. The client launch command becomes `uvx --no-build --find-links <that folder> --from …`, so the client never builds. Cost: an absolute path in client configuration, a new artifact that update, rollback, repair and drift must manage, and Windows/Linux verification.
3. A uv feature that verifies hashes for `uvx` / `uv tool run`: not available in uv 0.12.3.

The Manifest format (`sourceBuild` entries with `package`, `version`, `pypi-sdist`, `sha256`; duplicates rejected) and the plan field `sourceBuild` are kept, so a later decision does not need a schema change.

### uv configuration files (revised 2026-10-12)

- **Fact (uv docs "Configuration files"; checked with uv 0.12.3):** `uvx` ignores `uv.toml` and `pyproject.toml` in the current directory, but reads the user file (Windows `%APPDATA%\uv\uv.toml`, otherwise `$XDG_CONFIG_HOME/uv/uv.toml` or `~/.config/uv/uv.toml`) and the system file (Windows `%PROGRAMDATA%\uv\uv.toml`, otherwise `$XDG_CONFIG_DIRS/uv/uv.toml` or `/etc/uv/uv.toml`). An `index-url` in the user file was used by `uvx`. `UV_CONFIG_FILE` points to another file; `UV_NO_CONFIG` (`--no-config`) disables discovery.
- Prepare must use the same settings as the client, so OpenHub does **not** add `--no-config`. It reads the same files instead (paths from the allowlisted environment, read-only, at most 1 MiB), plus `UV_CONFIG_FILE` if set, and passes `UV_CONFIG_FILE`, `UV_NO_CONFIG` and `XDG_CONFIG_DIRS` to uv so Prepare and the client read the same files.
- Every key except a short list that cannot change package sources (`cache-dir`, `no-cache`, `native-tls`, concurrency, `link-mode`, `compile-bytecode`, `python-preference`, `python-downloads`, `preview`, `required-version`, …) counts as a package-source setting: indexes, `find-links`, `no-index`, constraints and overrides, `no-build` and `no-binary`, `exclude-newer`, and keys added by future uv versions. This errs toward treating a file as relevant.
- Fingerprint: those keys, with `user:password@` removed from URLs and the values of keys whose name contains password, token, secret or credential dropped, hashed together with the index environment variables. The file text, its path and credentials are never in the plan, results or logs. A change after approval → `PLAN_STALE`. A password-only change does not change the fingerprint. A `uv.toml` that only sets, for example, `cache-dir` leaves the plan unchanged.
- Any package-source setting → the plan carries `index: { custom: true, digest }` and the `uvx-custom-index` notice.
- An unreadable or invalid `uv.toml` blocks the uvx Prepare plan (`UVX_CONFIG_UNSUPPORTED`). uv itself could not use it either.

### Cache

- Prepare must fill the **same** uv cache the client will use, so it cannot run in an isolated cache. OpenHub does not set `UV_CACHE_DIR`; uv picks the user's default, as the client will.
- OpenHub never deletes uv cache entries. A failed Prepare is retried with a new plan and approval; uv itself replaces incomplete entries.
- Open: a client started with a different `UV_CACHE_DIR` (set in its own environment) would not see the prepared environment. Health still runs, so the risk is a slow first client start, not a wrong one.

### Child environment (allowlist, like `npmChildEnv`)

- Passed: `PATH` and OS/system directories, temp and home directories, locale, XDG directories, proxy variables, `SSL_CERT_FILE` / `SSL_CERT_DIR` / `REQUESTS_CA_BUNDLE`, the `UV_*` settings that select the cache, Python and index (`UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON`, `UV_INDEX`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_INDEX_STRATEGY`, `UV_NATIVE_TLS`, `UV_INSECURE_HOST`), `UV_INDEX_<NAME>_USERNAME` / `_PASSWORD`, and `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL`.
- Not passed: AI provider keys, `GITHUB_TOKEN` / `GH_TOKEN`, cloud credentials, database URLs such as `DATABASE_URI`, MCP connection strings, `PYTHONPATH`, `PYTHONSTARTUP`, and every other user variable.
- Index credentials (`UV_INDEX_<NAME>_USERNAME` / `_PASSWORD`, credentials in an index URL) are passed only if the user already configured them for uv. They are never logged, never in results, never in the plan.
- Index fingerprint (D8): the plan records whether a custom index is set and a sha256 over the index variable names and their URLs with user/password removed. Password variables contribute only their names. A change between approval and run gives a different plan digest → `PLAN_STALE`. A custom index adds the `uvx-custom-index` notice.
- `uv.toml` settings are part of the same fingerprint (see "uv configuration files").
- Open: an index set only in the client's own environment (for example in the client's MCP entry or its launcher) is not visible to OpenHub.

### Approval text (draft)

| ID | English | 한국어 |
| --- | --- | --- |
| (notice, all uvx Prepare) | OpenHub will download and install the Python packages for this exact version into uv's cache before writing the client configuration. The MCP server is not started during this step. | 클라이언트 설정을 쓰기 전에 이 정확한 버전의 Python 패키지를 uv 캐시에 내려받아 설치합니다. 이 단계에서는 MCP 서버를 실행하지 않습니다. |
| `source-build` (only for `source-build-reviewed` Manifests; never shown in v0.2.1 because those plans are blocked) | Some packages of this tool are only available as source and are built on your computer. Building runs third-party build code. OpenHub reviewed this tool's dependency list, but not the build code itself. | 이 도구의 일부 패키지는 소스로만 제공되어 내 컴퓨터에서 빌드됩니다. 빌드 과정에서 제3자 빌드 코드가 실행됩니다. OpenHub는 이 도구의 의존성 목록은 검토했지만 빌드 코드 자체는 검토하지 않았습니다. |

### TOCTOU and version changes

- Only exact versions are prepared. The verify step runs offline, so it cannot pull a different version.
- Open: a re-uploaded or yanked release is not detected by uv without hash checking. Hash locking per tool is not part of v0.2.1. `uvx` does not verify hashes even when they are given (see the source-build section).
- The plan digest covers the Prepare argv. A Manifest change between approval and run → `PLAN_STALE`.

## Resolved questions

1. Floating uvx Manifests → (a) pin to reviewed exact versions (D2).
2. serena's `proxy-tools` source build → first allowed under D3, then **blocked in v0.2.1** after measurement (second review); policy decision pending.
3. Prepare limit → at most 10 min (D5).

## Not covered

macOS. Hash locking. Tools that need system libraries to build.

