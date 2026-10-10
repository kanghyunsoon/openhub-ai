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
- Fact (unchanged Core behavior): if the tool is already configured in this project, Core reports the install as `already-installed` for a user-scope request too and writes nothing. Installing in user scope first and then in project scope gives two separate entries. Proposal: decide later whether a user-scope request should ignore project-scope installations.

## INSTALLED (Decision)

- By default `lifecycle:status` reads project scope only (D-003). User entries appear from Version State with state `not-inspected`, a note, and no action buttons.
- **Show user scope** is a button in INSTALLED. Turning it on sends `{ includeUser: true }`; only then does Core read the allowlisted user files (`~/.cursor/mcp.json`, `~/.codex/config.toml`). It is also turned on automatically right after a successful user-scope install, which is itself an explicit user action. Project analysis never reads user files.
- Entries are grouped under **Project scope** and **User scope**. The user group is labelled with its wider effect. The same tool installed in both scopes appears as two entries (`project:<client>:<server>` and `user:<client>:<server>`) with their own state and targets.
- Health, update, rollback and repair for `user:` entries are accepted only while user scope is shown in that session. An invented `user:` id otherwise returns `not-managed` and no user file is read. Repair for user entries uses the same Core rules as project entries; user targets require `user-scope-config`.

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
- `apps/desktop/test/user-scope-electron.e2e.test.ts` (`OPENHUB_E2E=1`): real Electron window, real clicks. Client (Codex) → User scope → plan → approval → install → INSTALLED user scope (shown automatically) → Health → main deletes the user tool config → Repair plan → approval → repair → Health. The run is checked in en-US and ko-KR: 4 dialogs, the user file keeps its existing content, and project files and Cursor files are untouched.
- Linux: `.github/workflows/desktop-e2e.yml` runs the desktop Electron E2E files under xvfb on pull requests that touch the desktop or Core, and on manual dispatch. It is not a required check. Electron's sandbox is disabled only in that job, because the runner cannot configure the SUID helper.
- macOS: not verified.

