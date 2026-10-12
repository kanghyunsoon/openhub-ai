# MCP failure scenarios: measurement plan (Doctor / Health / Lifecycle)

Status: **Proposal, measurement not run yet.** Every result cell below is NOT-RUN until a measured run is recorded.

## Why

The question is whether OpenHub's existing status, Health and lifecycle features help when an MCP setup breaks: what it detects, what it can repair safely, and how long that takes. This is **not** a rewrite into a separate "MCP Doctor" product. It uses what exists: `openhub doctor`, `openhub lifecycle status`, Health, update, rollback, repair and recover.

No comparison with other tools (for example Docker MCP Toolkit or ToolHive) is written until the same scenarios have been run on them and the results recorded.

## What exists today (Fact: code and tests)

| # | Scenario | Fault to inject | What OpenHub reports now | OpenHub recovery path | Evidence in tests |
| --- | --- | --- | --- | --- | --- |
| S1 | Server fails to start after an update | Update to a version whose server exits or does not answer | Update Health fails (`HEALTH_FAILED`, reason such as `launch-failed` / `startup-timeout`). The previous config entry is restored; Version State unchanged | Automatic restore of the previous entry within the same approved update; rollback for later failures | `apps/desktop/test/repair.test.ts` "11·12: Health가 실패하면…", `packages/core/test/lifecycle/rollback.test.ts` "AC-044-05" |
| S2 | Client config and Version State disagree | Edit the server entry by hand, or delete it | `config-drift` (entry changed) or `missing-config` (entry gone). Update and rollback blocked (`CONFIG_DRIFT`) | Repair only for OpenHub-managed differences (tool config, Node.js launch path). Other drift: user checks the file; `missing-config`: install again | `packages/core/test/lifecycle/status.test.ts` "AC-038-04", `packages/core/test/lifecycle/plan.test.ts` "AC-040-10" |
| S3 | Project and user scope conflict | Same server in project and user config; or open the home folder as the project | Status lists both scopes separately (user scope only when shown). Project install into a file that is the user file is blocked (`PROJECT_TARGET_IS_USER_CONFIG`) | Choose the intended scope; nothing is rewritten automatically | `apps/desktop/test/user-scope.test.ts`, `packages/core/test/installer/scope-aware.test.ts`, `packages/core/test/installer/v021-scope-overlap.test.ts` |
| S4 | Wrong launch command | Typo in `command`/`args` of an OpenHub-managed entry; or a hand-written entry OpenHub does not manage | Managed: `config-drift`, and Health is not run on a drifted entry. Unmanaged: `untracked-foreign`, not health-checked | Managed: rollback/update blocked until the file is fixed by hand. **Gap:** no way to health-check an unmanaged entry | `packages/core/test/lifecycle/status.test.ts` "AC-038-05", `apps/desktop/test/lifecycle.test.ts` "AC-046-07" |
| S5 | Required environment variable missing | Unset a variable the tool declares (for example `DATABASE_URI`) | Health fails (`launch-failed` / `process-exited` / handshake failure) and marks `environmentUnverified`; the plan named the variable beforehand | User sets the variable and runs Health again. **Gap:** OpenHub does not read env values, so it cannot say "variable X is missing" for certain | `packages/core/test/lifecycle/health.test.ts` "AC-041-04", "AC-041-08" |
| S6 | Update interrupted (app killed during Health) | Kill the process after the config write, before Health finishes | `interrupted-update`; update and Health blocked (`INTERRUPTED_OPERATION`). Desktop shows the exact recover command | `openhub lifecycle recover <tool>` (approved undo or discard) | `packages/core/test/lifecycle/v021-journal-kill.e2e.test.ts`, `packages/core/test/lifecycle/v021-state-concurrency.test.ts` |
| S7 | Node.js moved or reinstalled (Windows direct launch) | Remove or move the recorded `node.exe` / `npx-cli.js` | `client-launcher-invalid`; Health blocked | Approved repair rewrites only the launch path | `packages/core/test/tool-config/client-launcher.test.ts`, `apps/desktop/test/repair.test.ts` "4:" |

## Measurement protocol

Environment for each run:

- A clean user profile or VM per OS (Windows 11 x64, Ubuntu 24.04 x64) with the official release package (packaged app and CLI), not a source checkout.
- A synthetic project. Only fake credentials (for example `postgresql://probe:probe-not-secret@127.0.0.1/test` against a throwaway database). Real tokens are never used.
- One other MCP entry in each client file that OpenHub does not manage, to check preservation.

Steps per scenario:

1. Install the tool with OpenHub and confirm `state-consistent` and Health `healthy`.
2. Record the SHA-256 of every client config file and of `~/.openhub/state/lifecycle.json`.
3. Inject the fault exactly as described, and note the time (T0).
4. Run `openhub lifecycle status --json` and `openhub doctor --json`, and open INSTALLED in the desktop app. Record the state, code and message shown.
5. Follow only the recovery path OpenHub offers (approve plans as a user would). Note the time when status is back to `state-consistent` and Health is `healthy` (T1), or when OpenHub says it cannot recover.
6. Record SHA-256 again. The unmanaged entry must be byte-identical. Report any other file change.
7. Store the evidence: JSON outputs, screenshots and hashes, with no personal paths or secrets.

Recorded per run: OS, OpenHub version, client and version, tool and version, detected (yes/no + state/code), recoverable through OpenHub (yes/partly/no), steps the user had to do by hand, other entries preserved (yes/no), total time T1 − T0, notes.

## Results

| # | Windows | Linux | Detected | Recoverable via OpenHub | Other entries preserved | Time |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | NOT-RUN | NOT-RUN | – | – | – | – |
| S2 | NOT-RUN | NOT-RUN | – | – | – | – |
| S3 | NOT-RUN | NOT-RUN | – | – | – | – |
| S4 | NOT-RUN | NOT-RUN | – | – | – | – |
| S5 | NOT-RUN | NOT-RUN | – | – | – | – |
| S6 | NOT-RUN | NOT-RUN | – | – | – | – |
| S7 | NOT-RUN | n/a (Windows only) | – | – | – | – |

## Known gaps to evaluate (not planned work yet)

- Health for entries OpenHub does not manage (S4): today only managed entries can be health-checked.
- Saying which declared variable is missing (S5) without reading values. Possible approach: report "declared variable not set" by name only, at Health time. Needs a decision, because it means checking whether variables exist.
- Diagnosis when the client itself reports the failure (the client's own logs): out of scope until a client exposes a stable interface.
