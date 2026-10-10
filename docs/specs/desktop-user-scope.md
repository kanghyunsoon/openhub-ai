# Desktop user scope: install, status, Health, repair (v0.2.0 P0-3 C2)

Part of [v0.2.0](v0.2.0.md) (UX-4) and follows [desktop-client-scope.md](desktop-client-scope.md) (C1). Labels: **Fact**, **Decision**, **Proposal**.

User-scope install and user-scope lifecycle ship together, so anything the Desktop installs in user scope can be seen, checked and repaired in the Desktop.

## Install (Decision)

- The client screen gains an install scope: **Project** (default) or **User**. Each client shows the file that the chosen scope writes: project `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`; user `~/.cursor/mcp.json`, `~/.codex/config.toml`.
- Claude Code's user configuration (`~/.claude.json`) is not written by OpenHub (D-013). In user scope Claude Code is disabled with that reason.
- Choosing User shows a warning on the screen: the change is in the home folder, affects every project that uses the selected clients, and needs a separate approval.
- The renderer sends only client names and the scope name (`"project"` or `"user"`), never a path. Main rejects anything else with `invalid-selection` and plans nothing: an unknown or non-string scope, user scope with a client that has no writable user file, or values outside the allowlist.
- Core plans the install as before. User targets add the `user-scope-config` approval. The native approval dialog now lists every file that will change (client, scope, logical path) and, for user targets, states that the home folder changes and that every project using those clients is affected. This applies in English and Korean.
- Plan digest, `PLAN_STALE`, compensation and the plan-consistency rules from C1 are unchanged. Only selected clients' files change. Other entries and keys in the user file are kept; the writer patches only the OpenHub entry.
- Version State records user entries with `projectKey: null`, so the same user entry appears from any project.
- Install decisions are per target (Tool ID + client + scope + server name), see [scope-aware-installation.md](scope-aware-installation.md). A tool already configured in this project can still be installed in user scope. Only when the selected user file already has the same entry is the request `already-installed`; the Desktop shows it as **No change**, never as an install success ("the selected user configuration already has the same entry. No user configuration was written."). The result is `no-op`, and the user file and Version State are unchanged (tested). Before the scope-aware Core change, a project install made every user-scope request `already-installed`.

## INSTALLED (Decision)

- By default `lifecycle:status` reads project scope only (D-003). User entries appear from Version State with state `not-inspected`, a note, and no action buttons.
- **Show user scope** is a button in INSTALLED. Turning it on sends `{ includeUser: true }`; only then does Core read the allowlisted user files (`~/.cursor/mcp.json`, `~/.codex/config.toml`). It is also turned on automatically right after a successful user-scope install, which is itself an explicit user action. Project analysis never reads user files.
- Entries are grouped under **Project scope** and **User scope**. The user group is labelled with its wider effect. The same tool installed in both scopes appears as two entries (`project:<client>:<server>` and `user:<client>:<server>`) with their own state and targets.
- Health, update, rollback and repair for `user:` entries are accepted only while user scope is shown in that session. An invented `user:` id otherwise returns `not-managed` and no user file is read. Repair for user entries uses the same Core rules as project entries; user targets require `user-scope-config`.

## Plan consistency (Decision, review follow-up)

- The lifecycle session keeps two generation numbers: a plan generation, raised by every plan request, and a user-scope generation, raised every time Show user scope changes. Each plan records them together with the project.
- A plan is remembered only if all three are unchanged when planning finishes. Otherwise the response is `superseded` (or `not-managed` if the toggle changed before the user check), and nothing can run.
- Turning user scope off drops pending user plans only. Project plans are not affected by the toggle.
- Before the approval dialog opens and again after it closes, main checks the project (`project-changed`) and, for user entries, that user scope is still shown with the same generation (`plan-changed`). If either changed, the approval is discarded: no run, no file write, no Health. This applies to Health, repair, update and rollback alike.
- The INSTALLED renderer numbers its status requests and draws only the latest response, so a response from before the toggle cannot redraw user buttons after the user hid user scope. This bug was found by the Electron E2E and fixed. Changing the toggle also clears any plan shown on screen.
- IPC tests: (A) a user plan in flight when user scope is turned off is not remembered; (B) user plan → hide → run = `no-plan`, even after showing again; (C) hiding user scope while the repair approval dialog is open → `plan-changed`, no write, no Health, Version State byte-identical; (D) project plans survive toggling, including during planning; (E) user Health with user scope kept shown; (F) project change after or during planning → `project-changed` / `superseded`.

## Verification (Fact)

- `apps/desktop/test/user-scope.test.ts` (main IPC, real Core plans and files, temporary project and home, fake npm meeting the npx Prepare cache contract, injected Health):
  - user files per client, Claude Code user not writable;
  - invalid scope IPC (unknown, non-string, null, path, user + Claude Code) plans nothing;
  - user install: `user-scope-config`, dialog lists `~/.cursor/mcp.json` and the wider-effect warning (Korean and English), the other server and the `theme` key in the user file are kept, Codex user and project files unchanged, Version State has one user entry;
  - rejection writes nothing; a user-file change during approval is `PLAN_STALE` and the external content is kept; an unwritable user file fails without touching other files or Version State;
  - status without user scope reads no user file (`not-inspected`, no buttons, planning refused); with user scope the entry is `state-consistent`; turning it off refuses planning again;
  - user Health; the same user entry is consistent from another project;
  - user and project duplicates are separate and Health runs only the user target;
  - user tool config deleted → repair (needs `user-scope-config`): rejection writes nothing, Health failure reverts and keeps Version State byte-identical, success restores the file and Health passes;
  - a user-file change during repair approval is `PLAN_STALE` and is not overwritten.
- `apps/desktop/test/user-scope-electron.e2e.test.ts` (`OPENHUB_E2E=1`): real Electron window, real clicks, en-US and ko-KR.
  - Path: Client (Codex) → User scope → plan → approval → install → INSTALLED user scope (shown automatically) → Health → main deletes the user tool config → repair with an injected Health failure → repair → Health → Choose project again (another project) → Health of the same user entry → Hide user scope.
  - Checks:
    - The failed repair is reverted: the tool config is still absent.
    - After moving to another project, the same user entry is still `state-consistent`.
    - After hiding, the user entry is `not-inspected` with no buttons.
    - 6 dialogs.
    - The user file keeps its existing content; project files and Cursor files are untouched.
  - Health in this test is a fake: it checks the Desktop flow, not a real MCP server.
- Real MCP Health in user scope (`packages/core/test/registry/kubernetes-tool-config.e2e.test.ts`, `OPENHUB_E2E=1`): real npm and kubernetes-mcp-server 0.0.67 installed for Codex and Cursor in user scope, against a synthetic kubeconfig and a local fake Kubernetes API (no cluster, no credentials).
  - Install keeps the other entries and keys in the user files.
  - Real Health is healthy with 13 tools.
  - Real MCP calls: Secret get and list are refused, the ConfigMap is read, no Secret API request, no fake token in the output.
  - User tool config drift is `not-inspected` while user scope is hidden and `tool-config-drift` when shown.
  - Approved repair (`user-scope-config`) restores the file; real Health and MCP calls pass again.
  - Runs on Windows locally and on Linux in the `registry-remote.yml` sandbox job.
- Linux: `.github/workflows/desktop-e2e.yml` runs the desktop Electron E2E files under xvfb on pull requests that touch the desktop or Core, and on manual dispatch. It is not a required check. Electron's sandbox is disabled only in that job, because the runner cannot configure the SUID helper. The workflow and its individual tests are checked directly before merge.
- macOS: not verified.

