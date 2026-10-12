## What and why

<!-- One or two sentences. Link the issue: "Closes #123". Work without an agreed issue may be asked to open one first. -->

## How it was tested

<!-- Commands you ran and their result. For UI or real-tool behaviour, say what you actually observed (OS, client, versions). -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm registry:validate`
- [ ] `pnpm notices:check` (if dependencies changed, run `pnpm notices` first)
- [ ] Electron E2E (`OPENHUB_E2E=1`) if the desktop app or its IPC changed

## Safety checklist

- [ ] No real tokens, passwords, connection strings or personal paths in code, tests, fixtures or logs.
- [ ] Changes to approvals, execution, config writes, secrets or environment variables are described above.
- [ ] Plan/result/state contract changes keep goldens byte-identical, or explain the schema change.
- [ ] Nothing is described as verified unless it was actually run and observed.
- [ ] This is not a fix for an undisclosed vulnerability (those go through a private advisory first, see SECURITY.md).
