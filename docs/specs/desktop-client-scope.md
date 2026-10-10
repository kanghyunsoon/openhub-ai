# Desktop client selection (v0.2.0 P0-3 PR C, part 1)

Part of [v0.2.0](v0.2.0.md) (UX-4) and the PR C plan in [desktop-repair.md](desktop-repair.md). Labels: **Fact**, **Decision**, **Proposal**.

## Split (Decision)

PR C is split into independent pull requests:

| Part | Scope | Status |
| --- | --- | --- |
| C1 (this) | Client selection in the install flow: Claude Code, Codex, Cursor, supported OS, verification level per OS, install only the selected clients. Project scope only. | this PR |
| C2 | User scope: project default, user optional with `user-scope-config` approval and a preview of the user files; Desktop lifecycle status, Health and repair for user-scope entries (approval, compensation and `PLAN_STALE` unchanged). | next |
| C3 | Recommendation diagnosis: stack not detected, no need rule, no verified Registry candidate, client or OS incompatible, no install backend, excluded candidates (Core `diagnoseRecommendation`). | after C2 |

User-scope install and user-scope lifecycle ship together in C2, so the Desktop never installs something it cannot show or repair.

## Flow (Decision)

FOR YOU card → **View install plan** → client choice → **Review plan for selected clients** → install plan preview → approval checkboxes → native approval dialog → result.

- `install:options` (toolId only, must be in the current recommendations) returns, per client: supported by the tool (Manifest `targets`), detected in this project, default selection (supported and detected), and the OpenHub verification level on this OS. It plans, writes and runs nothing.
- Verification level comes from Core `clientVerificationLevel(toolId, client, platform)` (the OS × client table of reviewed tool configs). Tools without a reviewed tool config show `not-recorded` ("No OpenHub run record for this client on <OS> (the Manifest lists it as supported)"). Nothing is shown as verified without evidence.
- The Manifest's supported OS list is shown; if it does not include this OS, the screen says the plan will be blocked.
- Unsupported clients are disabled with the reason. Choosing nothing disables the review button.
- `install:plan(toolId, selection)` plans only the selected clients. A selection is an object with a `clients` property; each value must be in `INSTALL_CLIENTS` and in the Manifest `targets`, at most 6 values, duplicates collapse. Any other value in `clients` → `invalid-selection`, nothing planned. Values that are not a selection object (a path string, a Plan object) are ignored as before (AC-036-01) and the default selection is used. The preload only forwards `clients` as strings.
- Changing the selection after a plan is shown removes that plan from the screen; the user must review again. Only the last plan can be approved and run.
- The default selection keeps the previous behavior (detected and supported clients). A project with no detected client is no longer a dead end: the user can choose clients.

## Verification (Fact)

- `apps/desktop/test/install-clients.test.ts` (main IPC, real Core plans, temporary project, fake probe and executor): options data and no side effects; OS × client levels for `kubernetes-mcp-server` on Windows, Linux, macOS equal Core's table; Codex only writes only `.codex/config.toml` (`.mcp.json` byte-identical); no detected client → choose and plan; invalid selections (outside the allowlist, not supported by the Manifest, not an array, too many) plan nothing and leave nothing to run; path and Plan arguments ignored; re-planning with another selection runs only the last plan; English notes.
- `apps/desktop/test/install-clients-electron.e2e.test.ts` (`OPENHUB_E2E=1`): real Electron window, real clicks through the client screen. Default → `.mcp.json` only; Codex → `.codex/config.toml` only; Codex + Cursor → those two files (Korean UI); none → no plan, no dialog, no run.

