# Contributing to OpenHub AI

Thank you for helping. Code, documentation and Registry contributions are all welcome.

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
- Run typecheck, tests, Registry validation and the notices check locally.
- Describe user-visible behavior changes, especially anything touching approvals, execution, config writes or secrets.
- Security issues: follow SECURITY.md instead of opening a public pull request.
