# Troubleshooting

## Start with doctor

```sh
openhub doctor
```

It shows the Node.js version, which backends were found (node, npx, uvx, docker), whether pterm was found, where the Registry and metadata come from and whether Version State is readable. It writes nothing and starts no MCP server.

## Common problems

| Symptom | What to do |
| --- | --- |
| `APPROVAL_REQUIRED` | Changes need an interactive terminal. Run the command in a terminal, or add `--json` to only print the plan. |
| `PLAN_STALE` | Something changed between approval and execution (Registry, config file, backend, version). Review the new plan and approve again. |
| OpenScore shows "—" | No repository metadata. Run `openhub collect` (writes `~/.openhub/cache/metadata.json`). |
| Warning about a corrupt metadata cache | The cache is ignored and the bundled snapshot is used. Run `openhub collect` again. |
| A configured server is "unidentified" | It matches no Registry tool by name and package. OpenHub does not assume it is installed. |
| Health: Not verified | The health check was skipped for a tool that needs environment variables. Run `openhub lifecycle health <toolId>` when they are set. |
| Benchmark is disabled | The artifact is not pinned (artifact-unlocked). Update first to pin it. |
| Windows SmartScreen warning | The installer is unsigned. Verify the file with `SHA256SUMS` from the release before running it. |
| npx or API keys not found by the macOS app | GUI apps do not inherit shell environment variables. See [Supported platforms](supported-platforms.md). |
| Electron binary missing in a source checkout | Run `node apps/desktop/node_modules/electron/install.js` once. |
| `OPERATION_IN_PROGRESS` | Another OpenHub operation (CLI or Desktop) is changing tools, for example an update waiting for Health. Nothing was changed. Try again when it finishes. |

## Interrupted update, rollback or repair (v0.2.1)

If OpenHub was closed or killed while an update, rollback or repair was changing a client configuration, it keeps an operation record (journal) under `~/.openhub/state/journal`. Until it is recovered, the tool shows `interrupted-update` and update, rollback, Health and repair for it are blocked (`INTERRUPTED_OPERATION`).

Recovery is **CLI only in v0.2.1**; the Desktop app shows the warning but has no recovery screen yet. Desktop users run the same commands in a terminal:

1. `openhub lifecycle status` shows, for each interrupted tool, one of:
   - `복구 가능 … openhub lifecycle recover <tool>`: OpenHub's half-written entry can be put back to the previous entry.
   - `복구 가능 … openhub lifecycle recover <tool> --discard`: the configuration is already consistent (the change never happened, was already undone, or the operation completed); only the record is removed.
   - `자동 복구 불가 (<codes>)`: OpenHub will not change anything, for example because the entry was edited outside OpenHub (`EXTERNAL_CHANGE`). Check the file yourself; `openhub lifecycle recover <tool> --json` prints the details.
2. Run the suggested `openhub lifecycle recover` command, read the plan, answer the extra items (user-scope files need their own approval) and type the tool ID. Nothing is written before that, and each approval works once.
3. Check `openhub lifecycle status` again; the tool is `state-consistent`.

Other results:

| Message | Meaning |
| --- | --- |
| `JOURNAL_DAMAGED` | An operation record cannot be read. OpenHub plans nothing and never deletes it. Back up and move the file out of `~/.openhub/state/journal`, check the configuration with `openhub lifecycle status`, then try again. |
| `cleanup-failed` | The configuration was recovered (or left unchanged), but the record could not be removed. Check write access to `~/.openhub/state`, then run `openhub lifecycle recover <tool> --discard`. |
| warning `journal-cleanup-failed` after an update | The operation finished, but its record remains. `openhub lifecycle status` shows whether `--discard` is enough. |

## Reporting

Include the output of `openhub doctor --json` and the command you ran. It contains no tokens or absolute paths. Report security problems privately as described in SECURITY.md.
