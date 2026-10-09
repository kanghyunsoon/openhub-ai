# OpenHub AI

OpenHub AI is an open-source, project-aware lifecycle manager for AI coding tools. It reads your project, recommends MCP servers and agent tools that fit it, and installs, verifies, updates and rolls them back, with a plan you approve before anything runs.

## Demo

![OpenHub AI desktop app showing the DISCOVER, PROJECT, FOR YOU and INSTALLED areas](docs/images/desktop.png)

`pnpm demo` walks through the whole flow on the bundled [demo project](examples/demo-project/) (React + Spring Boot + PostgreSQL + Claude Code): Analyze → Existing tools → Recommend → Install preview → Adopt → Releases → Impact → Update preview → Discover → Benchmark preview. The demo uses fixture data, makes no network requests and starts no processes. Install, update and benchmark stop at the plan: the demo declines the approval.

## Why OpenHub

AI coding tools are easy to find and hard to keep right. OpenHub answers three questions for a specific project:

1. What does this project need, and what is already configured?
2. Will this tool work here, with this client and this machine?
3. Can it stay safe after installation, through updates and rollbacks?

OpenHub is not an app store. It recommends from a curated Registry, explains every recommendation, and never treats a recommendation, a release note or a score as permission to run something.

## Core Features

- **Project analysis**: languages, frameworks, databases, infrastructure and AI clients from manifests and config files. Read-only; nothing in your project is executed.
- **Recommendations**: capability gaps for this project, ranked by Project Fit, with a separate **OpenScore**. OpenScore reflects repository maintenance, activity and community signals; it is not a security or code-quality rating.
- **Installation**: npx, uvx and Docker backends for Claude Code, Codex and Cursor, with targeted config edits and a plan digest you approve.
- **Lifecycle**: Version State, artifact locks, MCP health checks, updates that are reverted if the health check fails, and rollback to the previous revision with its own approval.
- **Adopt**: register MCP servers you already configured, without changing the config file.
- **Release intelligence**: release notes, a deterministic summary (Breaking, Security, Compatibility, Performance, Fix, Other) and an update impact verdict. An optional AI summary is display-only.
- **Discover**: New for your project, Trending, the Verified Registry and Unverified Candidates. About Trending: Not historical star growth: a deterministic score combining current popularity with recent release and repository activity. It does not rate security or code quality. Candidates are UNVERIFIED drafts and can never be installed, adopted or updated.
- **Benchmark**: start an MCP server six times and measure startup, initialize and tools/list times, after approval and without calling any tool.

## How It Works

Discover → Recommend → Install → Verify → Update → Rollback

1. **Discover**: the project scanner builds a profile with evidence; the Registry and catalog provide the candidates.
2. **Recommend**: gaps are matched against Registry tools and explained. Installed tools are identified by name and package.
3. **Install**: a plan lists the exact command, the config files it writes and the approvals it needs. You approve it in an interactive terminal or a native desktop dialog. The plan is rebuilt right before execution; if anything changed, it stops with `PLAN_STALE`.
4. **Verify**: Prepared, Configured and Detected states, plus an MCP health check that starts the server in an isolated temporary directory.
5. **Update**: the new version is resolved and pinned, the config entry is replaced, the health check runs, and Version State changes only if it passes. Otherwise the previous config is restored.
6. **Rollback**: returns to the previous revision with a separate plan and approval.

## Quick Start

Requirements: Node.js 24.15 or later. Backends you plan to use (npx, uvx or Docker) must be on PATH.

Install the CLI from a release package and look at a project:

```sh
npm install -g ./openhub-ai-0.1.1.tgz
openhub --version
openhub registry list
openhub project scan ./my-project
openhub project recommend ./my-project
openhub doctor
```

Desktop: download the Windows x64 installer or the Linux x64 AppImage from the release. The Windows installer is **unsigned**, so Windows SmartScreen or Smart App Control may warn before it runs. There is no macOS release artifact; macOS users can build from source (see [Supported platforms](docs/supported-platforms.md)).

From source:

```sh
pnpm install
pnpm test
pnpm openhub project scan examples/demo-project
pnpm demo
pnpm desktop
```

## Supported Clients and Backends

| | Supported |
| --- | --- |
| AI clients | Claude Code, Codex, Cursor (project and user scope) |
| Install backends | npx, uvx, Docker; Pinokio for OpenHub-generated scripts |
| Platforms | Windows x64 (NSIS installer, unsigned), Linux x64 (AppImage); macOS from source only |

Pinokio support targets pterm 0.0.25. Default tests use a fake pinokiod; real Pinokio integration runs only when OPENHUB_E2E=1. OpenHub never runs third-party Pinokio scripts; it only shows them.

## Security and Approval Model

- Every change goes through a plan, a human approval and a re-check of the plan right before execution. There is no `--yes` or auto-approve option.
- Commands run without a shell, from a fixed executable and argument list. Config edits are targeted, atomic and reverted on failure.
- Secrets are never stored. OpenHub records environment variable names, not values, and never writes tokens to plans, results, logs or caches.
- User-level config files are read only when you pass `--include-host`.
- Recommendations, scores, release notes, impact verdicts, AI summaries and discovery candidates are information, not approval.

Release artifacts come with CycloneDX SBOMs and `SHA256SUMS`. Syft finds no components in the Linux AppImage or the CLI package and cannot read inside Electron's app.asar; bundled JavaScript dependencies are covered by the dependency SBOMs. Because the Windows executable is branded as OpenHub AI, Syft may not identify it as Electron; the Electron version is verified from the dependency SBOM, the running app and the official Electron distribution.

See [Security model](docs/security-model.md), [Approval model](docs/approval-model.md), [Discovery trust](docs/discovery-trust.md), [LLM privacy](docs/llm-privacy.md) and [Release process](docs/release-process.md).

## CLI

| Command | What it does |
| --- | --- |
| `openhub project scan <path>` | Project profile with evidence |
| `openhub project recommend <path>` | Recommendations with Project Fit, OpenScore and reasons; installs nothing |
| `openhub install <toolId>` | Install plan → approval → install |
| `openhub adopt <toolId>` | Register an already configured tool |
| `openhub lifecycle status` | Version State, drift, artifact lock and health |
| `openhub update <toolId>` / `openhub rollback <toolId>` | Update or roll back with health check |
| `openhub releases <toolId>` / `openhub impact <toolId>` | Release notes, deterministic summary, update impact |
| `openhub discover --view trending` | Discover views (new, trending, verified, candidates) |
| `openhub candidate prepare <candidateId>` | Local Registry contribution package; writes nothing to GitHub |
| `openhub benchmark <toolId>` | Approved startup benchmark, no tool calls |
| `openhub doctor` | Environment, backends, Registry, metadata and Version State check |

Run `openhub --help` for every option.

## Desktop

The desktop app has four areas: **PROJECT** (choose and analyze a folder), **FOR YOU** (recommendations and install plans), **DISCOVER** (New for your project, Trending, Verified Registry, Unverified Candidates, tool details) and **INSTALLED** (status, updates, health checks, rollback, Adopt, Benchmark, release notes and Pinokio previews). A seven-step guide appears until you pick a project. Approvals are native dialogs; untrusted text is shown as plain text.

## Architecture

A TypeScript monorepo: `packages/core` holds the analyzer, Registry, recommendation, installer, lifecycle and release logic; `apps/cli` and `apps/desktop` (Electron) are thin front ends over it; `registry/` holds the curated Manifests. See [Architecture](docs/architecture.md) and [Troubleshooting](docs/troubleshooting.md).

## Contributing

Contributions to the code and to the Registry are welcome. See CONTRIBUTING.md for the development setup, tests and the Candidate → Manifest process, and SECURITY.md for reporting vulnerabilities.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
