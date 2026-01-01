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

## Reporting

Include the output of `openhub doctor --json` and the command you ran. It contains no tokens or absolute paths. Report security problems privately as described in SECURITY.md.
