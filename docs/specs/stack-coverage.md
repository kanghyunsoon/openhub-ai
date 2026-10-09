# Stack coverage (v0.2.0 P0-1)

Part of [v0.2.0](v0.2.0.md). This document is the single source for what the project analyzer recognizes, which evidence counts, how detected technologies map to capability needs, and the taxonomy v2 change.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question** (see [Roadmap](../roadmap.md)).

## 1. Supported technologies

Detection reads files only. Nothing in the project is executed. Each item carries evidence (`file`, `type`, `value`) and a deterministic detection confidence (1.0 or 0.9 strong, 0.8 user environment, 0.6 or less weak).

### Already supported in v0.1.1 (Fact)

| Category | IDs |
| --- | --- |
| languages | typescript, javascript, python, java, csharp, rust, cpp |
| frameworks | react, nextjs, vue, spring-boot, fastapi |
| databases | postgresql, mysql, sqlite, mongodb |
| packageManagers | pnpm, npm, yarn, bun, pip, uv, maven, gradle, cargo |
| infrastructure | docker, docker-compose, github-actions, git |
| aiClients | claude-code, codex, cursor |

### Added in v0.2.0 (Fact, implemented on `feat/stack-coverage`)

| ID | Category | Evidence that counts | Evidence type |
| --- | --- | --- | --- |
| `go` | languages | `go.mod` with a valid `module <path>` directive (keyword followed by whitespace; optional quotes and trailing `//` comment; path elements checked; `modulefoo`, commented lines and the block form are not accepted) | manifest (`module <path>`) |
| | | `go.mod` that cannot be read as a module | file-presence (weak) |
| | | `.go` file count | extension-count (supporting only) |
| `express` | frameworks | `express` in a package.json dependency section | dependency |
| `nestjs` | frameworks | `@nestjs/core` dependency | dependency |
| `jest` | frameworks | `jest` dependency, or `jest.config.{ts,js,mts,mjs,cts,cjs,json}` | dependency, config |
| `vitest` | frameworks | `vitest` dependency, or `vitest.config.{ts,js,mts,mjs,cts,cjs}` | dependency, config |
| `pytest` | frameworks | `pytest` in pyproject (including dependency groups) or requirements files, or `pytest.ini` / `conftest.py` | dependency, config |
| `playwright` | frameworks | `@playwright/test` or `playwright` (npm), `playwright` or `pytest-playwright` (PyPI), or `playwright.config.*` | dependency, config |
| `unity` | frameworks | `ProjectSettings/ProjectVersion.txt` with an `m_EditorVersion:` line | config |
| | | `Packages/manifest.json` with at least one `com.unity.*` dependency | manifest |
| `unreal-engine` | frameworks | `.uproject` JSON with `EngineAssociation`, `Modules` or `FileVersion` | config |
| | | `.uproject` that is not valid JSON | file-presence (weak) |
| | | `.uplugin` JSON with `FileVersion` or `Modules` | config |
| `kubernetes` | infrastructure | YAML document whose `apiVersion` is a Kubernetes API group and whose `kind` is a core resource (Deployment, Service, StatefulSet, Job, CronJob, Ingress, ConfigMap and similar) | config |
| | | `kustomization.yaml` with `resources`, `bases` or `kind: Kustomization` | config |
| | | Helm `Chart.yaml` with `apiVersion: v1/v2` and a valid chart name | config |

Decision: test frameworks and game engines are reported in the existing `frameworks` list. ProjectProfile keeps its fields; only new IDs appear.

Decision: Kubernetes is a separate detector (`kubernetes`), registered next to the existing infrastructure detector, as the infrastructure detector's design requires. The detector list in reports and profiles therefore gains `kubernetes`.

## 2. False-positive rules (Decision)

- A C# project (`.cs`, `.csproj`, `.sln`) is not Unity without Unity project files.
- A C++ project (`.cpp`, CMake) is not Unreal Engine without `.uproject` or `.uplugin`.
- A README, docs or comment that mentions a technology is never evidence.
- YAML that does not parse, YAML without both `apiVersion` and `kind` at line start, CRDs and other non-core kinds, GitHub workflow files and Compose files are not Kubernetes evidence.
- Files under excluded paths (dependencies, build output, test fixtures inside a scanned project) are ignored, as before.
- Evidence values keep only safe tokens: versions and names must match strict character sets, values are capped at 200 characters, and reports still reject absolute paths, URL credentials and tokens.
- Malformed manifests never fail the scan. A broken `.uproject` or `go.mod` leaves weak file-presence evidence (confidence below 0.9); a broken Unity `manifest.json` or `ProjectVersion.txt` leaves nothing.
- The same technology found in several files is one item with several evidence entries.

## 3. Taxonomy v2 (Decision)

`taxonomyVersion` goes from 1 to 2 because the capability and tech ID tables changed. RecommendationReport stays `schemaVersion: 1`.

Rules followed:

- No v1 capability ID or tech ID was removed, renamed, reordered or given a new meaning. New IDs are appended.
- New capabilities: `game-engine-editor` (domain `game-dev`) and `kubernetes-operations` (domain `infrastructure`). Both describe what an MCP server would do (drive a game editor; inspect or change cluster resources), not a project type.
- New tech IDs: `go`, `express`, `nestjs`, `jest`, `vitest`, `pytest`, `playwright`, `unity`, `unreal-engine`, `kubernetes`.
- All 7 existing Registry Manifests validate unchanged against v2 (tested).

### Handling taxonomyVersion 1 reports (Decision)

Fact: no code path reads a stored RecommendationReport. The CLI, the desktop app and the installer always build a fresh report with `recommend()` right before using it, and install and lifecycle plans rebuild it again before execution.

Policy: a report with `taxonomyVersion: 1` is rejected by `recommendationReportSchema` at `generatedFrom.taxonomyVersion`. It is never reinterpreted under v2. Anyone holding an old `--json` report must regenerate it with `openhub project recommend`. A test enforces the rejection.

The schema digest of `recommendationReportSchema` changes only through that literal. Setting it back to 1 reproduces the v0.1.1 digest exactly; `test/fixtures/m7-final/schema-digests.json` records both values.

## 4. Need Rules (Decision)

NR-01 to NR-08 are unchanged. New rules start at NR-09.

| Rule | Trigger | Needs |
| --- | --- | --- |
| NR-09 | go | semantic-code-navigation (medium), code-editing (low) |
| NR-10 | express, nestjs | library-docs (medium) |
| NR-11 | playwright | e2e-testing (high), browser-automation (medium) |
| NR-12 | unity, unreal-engine | game-engine-editor (high) |
| NR-13 | kubernetes | kubernetes-operations (medium) |

Decision: Jest, Vitest and pytest get no rule. They are recognized and shown, but there is no verified tool whose capability is "run or understand this unit test framework", and a rule would only produce empty needs or push unrelated tools. They appear in the result diagnosis as recognized but not mapped. Proposal: revisit when P0-2 adds such a tool.

Decision: no rule maps a game engine to general testing, browser or database tools. A Unity project still gets C# code-navigation needs from NR-07, as before.

## 5. Recommendation quality

Measured in four separate layers, each with its own tests:

| Layer | Question | Where |
| --- | --- | --- |
| A Stack detection | Is the stack recognized from real evidence, with no false positives? | `packages/core/test/stack-coverage.test.ts` (A) |
| B Need coverage | Does each recognized stack produce the right needs? | same file (B, C, D) |
| C Registry coverage | Does a verified tool exist for each need? | `needs[].candidates`, `no-candidate` reason |
| D Recommendation | Are the recommended tools relevant, with valid reasons, and nothing unrelated? | same file, CLI tests |

When no tool can be recommended, OpenHub explains which layer is empty instead of adding tools. `diagnoseRecommendation(profile, report)` returns:

| Field | Meaning |
| --- | --- |
| `emptyReason` | Only when there are no recommendations: `no-stack-detected`, `no-mapped-need`, `no-verified-tool`, `all-satisfied` or `candidates-excluded` |
| `unmappedTechs` | Recognized technologies with no Need Rule. Package managers, `git`, `docker` and `docker-compose` are excluded on purpose: they describe the environment and are expected to have no rule. If they are the only technologies and nothing is recommended, `emptyReason` is still `no-mapped-need`. |
| `needsWithoutVerifiedTool` | Open needs with zero Registry candidates |

The diagnosis is derived data. It is not added to RecommendationReport v1, and `--json` output is unchanged. Compatibility and exclusion reasons still come from the existing report fields (`candidates[].excludedBy`, `reasons`).

## 6. Before and after (Fact)

Measured with `openhub project scan` and `openhub project recommend --json` on the fixtures in `packages/core/test/fixtures/projects`, using v0.1.1 (`95ed290`) and this branch, with the shipped Registry (7 tools).

| Project | v0.1.1 detected | v0.1.1 recommended | v0.2.0 detected | v0.2.0 recommended |
| --- | --- | --- | --- | --- |
| Go service | nothing | none | go | Serena |
| Express + PostgreSQL + TS | javascript, typescript, postgresql | Postgres MCP, Serena | + express, jest | Postgres MCP, Serena, Context7 (Express docs) |
| NestJS + TS | javascript, typescript | Serena | + nestjs, vitest | Serena, Context7 (NestJS docs) |
| Unity | csharp | Serena | + unity | Serena; game-engine-editor need shown with no verified tool |
| Unreal Engine | cpp, csharp (weak, Build.cs) | Serena | + unreal-engine | Serena; game-engine-editor need shown with no verified tool |
| Jest app | javascript | Serena | + jest | Serena; jest listed as not mapped |
| Vitest + React + Playwright | javascript, typescript, react | Chrome DevTools, Playwright MCP, Serena, Context7 | + playwright, vitest | unchanged; e2e-testing need now also cites playwright |
| pytest app | python | Serena | + pytest | Serena; pytest listed as not mapped |
| Kubernetes deploy | docker, docker-compose | none | + kubernetes | none; reason `no-verified-tool` for kubernetes-operations (P0-1). P0-2 batch 1 then added Kubernetes MCP Server, which is now recommended ([registry-expansion.md](registry-expansion.md)). |
| README mentions only | nothing | none | nothing | none; reason `no-stack-detected` |
| C# console, C++ CMake | csharp / cpp | Serena | unchanged (no Unity, no Unreal) | unchanged |
| React + Spring monorepo | 9 items | 5 tools | unchanged | unchanged |
| Python FastAPI, React pnpm | unchanged | unchanged | unchanged | unchanged |

Reading the table: the number of recommendations grew only where a verified tool really serves the new need (Context7 for Express and NestJS documentation, Serena for Go code navigation). Unity, Unreal and Kubernetes gained needs, not tools, because the Verified Registry has no tool for them yet; that is P0-2 work.

## 7. Test fixtures (Fact)

Under `packages/core/test/fixtures/projects`: `go-service`, `express-postgres-ts`, `nestjs-app`, `unity-game`, `unreal-game`, `jest-app`, `vitest-app`, `pytest-app`, `k8s-deploy`, `csharp-console`, `cpp-cmake`, `readme-mentions`, `malformed-stack`, `polyglot-monorepo`, plus the existing `react-spring-monorepo` as a regression check.

Existing analyzer goldens changed in two expected ways only: the detector list gains `kubernetes`, and `polyglot-native` (which contains a real `Game.uproject`) is now recognized as Unreal Engine. Recommendation goldens change only `taxonomyVersion` and the detector list. The `pnpm demo` golden changes only in the detector list.

## 8. CLI and desktop impact

- CLI (Fact): `openhub project recommend` prints the reason when there are no recommendations and lists recognized technologies with no Need Rule. `--json` output keeps RecommendationReport v1.
- Desktop (Fact): the PROJECT and FOR YOU views show the new technologies and needs with no code change, because they render the profile and report. Capability labels for the two new capabilities exist.
- Desktop (Proposal, P0-3): show the empty-result reason in FOR YOU. See [v0.2.0](v0.2.0.md#p0-3-desktop-ux).

## 9. Open Questions

- Should Docker and Docker Compose get a Need Rule once a verified container tool exists (P0-2)?
- Should Jest, Vitest and pytest map to a testing capability if P0-2 finds a verified test-runner MCP server?
- Should Go detection also read `go.work` workspaces separately, or is per-module `go.mod` enough?
