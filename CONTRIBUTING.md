# Contributing to OpenHub AI

Thank you for helping. Code, documentation and Registry contributions are all welcome.

## How work is organized

- **Issues first.** Before writing code, look at the [open issues](https://github.com/kanghyunsoon/openhub-ai/issues) and open pull requests. If nothing covers your idea, open an issue with the template that fits (bug, feature, Registry contribution) and wait for a maintainer to agree on the scope. Small documentation fixes can go straight to a pull request.
- **Milestones.** `v0.2.1` is a stabilization release (no large features); `v0.3.0` collects work that needs design or new verification. An issue without a milestone is not planned yet.
- **Labels.** `good first issue` marks small, self-contained tasks that do not need knowledge of the core architecture. `help wanted` marks tasks where outside help is especially useful, for example testing on hardware or clients the maintainer does not have.
- **Claim before you start.** Comment on the issue that you want to work on it (and roughly when). A maintainer assigns it to you. If an issue is assigned but has had no activity for two weeks, ask in the issue before taking it over.
- **Work that is already in a pull request** is not done a second time from an issue; comment on that pull request instead.

## Branches and pull requests

1. Fork the repository and create a branch from `main`, named after the work, for example `docs/lifecycle-status-values` or `fix/desktop-language-reload`.
2. Keep one topic per pull request. Link the issue in the description (`Closes #123`).
3. Fill in the pull request template: what changed, how you tested it, and the safety checklist.
4. Open it as a draft if you want early feedback.
5. Do not rewrite history after review starts (no force push on a reviewed branch); add commits instead. Merge `main` into your branch if it falls behind.

## Required checks

Run these locally before asking for review:

```sh
pnpm typecheck
pnpm test
pnpm registry:validate
pnpm notices:check
```

On Windows, a full parallel `pnpm test` can time out at about 5 s on slow machines. Rerun the failing files with `pnpm exec vitest run <files> --maxWorkers=2` before reporting a failure.

CI runs four required checks on every pull request: `check` (typecheck, tests, Registry and notices), `codeql`, `secret-scan` and `desktop-e2e`. The desktop Electron tests run only when the change can affect the desktop app.

## Review and merge

- A maintainer reviews every pull request. Changes that touch approvals, process execution, config writes, environment variables or secrets get a security-focused review and may be asked for extra tests.
- A pull request is merged only when all required checks pass, review comments are resolved and the maintainer approves. Pull requests are squash-merged into `main`; nobody pushes to `main` directly.
- Claims in a pull request must match what was run. Write "not tested on macOS" rather than implying support.

## Reporting security problems

Do not open a public issue or pull request with details of an unfixed vulnerability. Use a private advisory: **Security → Report a vulnerability**, as described in [SECURITY.md](SECURITY.md).

## Development setup

- Node.js 24.15 or later
- pnpm 11 (`npm install -g pnpm@11` or Corepack)

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm registry:validate
pnpm notices:check
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm openhub <command>` | Run the CLI from source |
| `pnpm desktop` | Start the desktop app from source |
| `pnpm demo` | Run the deterministic demo on `examples/demo-project` |
| `pnpm pack:cli` / `pnpm pack:desktop` | Build release packages locally |
| `pnpm notices` | Regenerate THIRD_PARTY_NOTICES.md after changing runtime dependencies |

## Tests

- Default tests make no real network requests and start no third-party processes; they use fakes and fixtures.
- Tests that need real Docker or Pinokio run only with `OPENHUB_E2E=1` and are skipped otherwise.
- Contract changes (plans, results, state files, reports) must keep their golden files byte-identical or bump the schema version with a migration.
- Never put real tokens, personal paths or machine-specific data in fixtures. Use obviously fake values.

## Registry contributions

Each tool is a Manifest at `registry/<category>/<name>.yaml` plus an entry in `registry/catalog.yaml`. Run `pnpm registry:validate` before opening a pull request. CI also validates the schema, names, aliases, install backends and catalog dates.

### From a Candidate to a Manifest

1. `openhub discover` finds public candidates and writes UNVERIFIED drafts to `registry-candidates/`.
2. `openhub candidate prepare <candidateId>` writes a local contribution package: a draft Manifest, a diff and pull request text. It writes nothing to GitHub.
3. Review the draft by hand: repository, license, install command, required environment variables, platforms and capabilities. Candidate text is untrusted; do not copy install commands without checking them.
4. Move the Manifest into `registry/`, add it to `catalog.yaml` and run `pnpm registry:validate`.
5. Open a pull request with the generated description.

## Pull requests

- Keep changes focused and include tests.
- Describe user-visible behavior changes, especially anything touching approvals, execution, config writes or secrets.
- See "Branches and pull requests", "Required checks" and "Review and merge" above.
