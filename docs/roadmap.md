# Roadmap

This is the public roadmap for OpenHub AI. It states the product goal, what is already built, and what each version must deliver. Detailed requirements live in versioned specs under [docs/specs](specs/); this file only links to them.

Labels used in OpenHub planning documents:

- **Fact**: verified against the code, tests or a published release.
- **Decision**: confirmed by the maintainer; changing it needs a new decision.
- **Proposal**: planned, not yet confirmed or not yet built.
- **Open Question**: needs a maintainer decision before the related work starts.

## Product goal

OpenHub AI helps a developer pick, install and keep AI coding tools (MCP servers and agent tools) that fit a specific project, without giving up control. For any project it should answer:

1. What does this project need, and what is already configured?
2. Which verified tool covers that need here, with this client and this machine, and why?
3. Can the tool be installed, verified, updated and rolled back safely, with a plan the user approves?

OpenHub is not an app store. A recommendation, a score or a release note is never permission to run anything.

## Current state: v0.1.1 (Fact)

| Area | State |
| --- | --- |
| Project analysis | Languages, frameworks, databases, package managers, infrastructure and AI clients from manifests and config files, with evidence and deterministic detection confidence |
| Recommendations | RecommendationReport v1, capability taxonomy v1 (14 capabilities), Need Rules NR-01 to NR-08, Project Fit and OpenScore kept separate |
| Verified Registry | 7 tools (Playwright MCP, Chrome DevTools MCP, GitHub MCP Server, Context7, Serena, Postgres MCP, Memory) |
| Installation and lifecycle | npx, uvx, Docker and OpenHub-generated Pinokio scripts; plan digest approval; health check; update with automatic revert; rollback with its own approval |
| Release intelligence, Discover, Benchmark | Shipped in v0.1.0 |
| Clients | Claude Code, Codex, Cursor |
| Platforms | Windows x64 (unsigned NSIS), Linux x64 (AppImage); macOS from source |
| Desktop language | Korean only |

Known gaps found while testing v0.1.1 on real project shapes (Fact): Go projects were not recognized at all; Unity and Unreal Engine projects were seen only as C# or C++; Express, NestJS and test frameworks were not recognized; an empty recommendation list did not say why.

## Core user flow

Analyze → Recommend → Plan → Approve → Install → Verify → Update or Roll back

Each step is described in [Architecture](architecture.md) and [Approval model](approval-model.md).

## v0.2.0: coverage and usability (Decision)

Spec: [docs/specs/v0.2.0.md](specs/v0.2.0.md)

- **P0-1 Stack coverage**: recognize Go, Express, NestJS, Jest, Vitest, pytest, Playwright, Unity, Unreal Engine and Kubernetes from project files; connect them to Need Rules; explain empty results. Details: [stack-coverage.md](specs/stack-coverage.md).
- **P0-2 Registry expansion**: grow the Verified Registry from 7 to 25-40 tools, only with tools that pass the verification criteria.
- **P0-3 Desktop UX**: English by default with Korean selectable and persisted, user-scope install, client choice, guidance for empty results.

## v0.3.0 and later (Proposal)

- More stacks, chosen from user reports (for example Django, Flask, Rails, .NET web, Terraform).
- Registry growth past 40 with the same criteria, and a contributor workflow for new Manifests.
- Windows code signing and a macOS release artifact, once signing identities are available.
- Optional per-user preferences for recommendations (never sent anywhere).

## v1.0.0 completion criteria (Proposal)

- The common stacks in the supported list are recognized from files, with fixtures and negative tests for each.
- Every capability with a Need Rule has at least one verified tool, or the gap is stated in the product.
- Install, update and rollback are verified end to end on every supported platform and client.
- Desktop and CLI are available in English and Korean.
- Release artifacts are signed where the platform supports it, with SBOMs and checksums as today.
- No change to the approval model: nothing runs without an approved plan.

## Version dependencies

| Version | Depends on |
| --- | --- |
| v0.2.0 P0-2 Registry expansion | P0-1 taxonomy v2 (new capabilities such as `game-engine-editor` and `kubernetes-operations` need verified tools) |
| v0.2.0 P0-3 Desktop UX | P0-1 empty-result diagnosis; P0-2 for useful results on more stacks |
| v0.3.0 | v0.2.0 taxonomy and Registry criteria |
| v1.0.0 | Signing identities; v0.3.0 coverage |

## Quality and security bar (Decision)

These hold for every version:

- Nothing is installed or updated without an approved plan. Unverified discovery candidates are never installable.
- Recommendations are deterministic for the same input. No LLM ranking.
- Project files are read, never executed. Secrets, absolute paths and URL credentials do not appear in reports, plans or logs.
- Contract changes are versioned. Old data is rejected or regenerated, never silently reinterpreted.
- Every change ships with tests; regressions are not hidden by deleting tests or raising timeouts.
