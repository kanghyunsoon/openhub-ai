# Architecture

OpenHub AI is a TypeScript monorepo (Node.js 24.15+, pnpm workspace).

| Path | Role |
| --- | --- |
| `packages/core` | All product logic: project analyzer, Registry and catalog loading, recommendation, installer, lifecycle, release intelligence, identity matching, discovery, Pinokio integration, benchmark and path rules |
| `apps/cli` | The `openhub` command. Parses arguments, prints previews and asks for approval in an interactive terminal |
| `apps/desktop` | Electron app. The main process calls the core; the renderer only displays data received through a narrow preload bridge |
| `registry/` | Curated tool Manifests (YAML) and `catalog.yaml` |
| `examples/demo-project` | Fixture project for `pnpm demo` and screenshots |
| `scripts/` | Packaging, release dry-run, metrics and maintenance scripts |

## Data flow

1. **Analyze**: the scanner walks the project with path containment (no symlink escapes) and produces a ProjectProfile with evidence and a deterministic detection confidence. User-level client configs are read only with `--include-host`.
2. **Recommend**: Registry Manifests are matched against capability gaps. The report keeps Project Fit and OpenScore separate and explains every result.
3. **Plan**: install, lifecycle (update, rollback, health), adopt, benchmark and Pinokio operations each produce a versioned plan with a canonical JSON digest.
4. **Approve**: a single approval kernel turns a plan and a human confirmation into a one-time approval. Right before execution the plan is rebuilt; a different digest stops execution (`PLAN_STALE`).
5. **Execute**: backends run without a shell. Client config files are edited with targeted, atomic writes and restored on failure.
6. **Record**: Version State (`~/.openhub/state/lifecycle.json`) stores what OpenHub manages, without absolute paths or secrets.

## Resources at runtime

- Registry: `--dir` or `OPENHUB_REGISTRY`, otherwise the Registry shipped in the package (next to the CLI bundle, or `resources/registry` in the desktop app).
- Repository metadata: `OPENHUB_METADATA`, otherwise `~/.openhub/cache/metadata.json` (written by `openhub collect`; ignored with a warning if corrupt), otherwise the snapshot shipped in the package.
