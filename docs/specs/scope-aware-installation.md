# Scope-aware installation (v0.2.0, Core)

Part of [v0.2.0](v0.2.0.md) (UX-4). Follows [desktop-user-scope.md](desktop-user-scope.md) (C2), which shipped with a Core limitation that this change removes. Labels: **Fact**, **Decision**, **Proposal**.

## Problem (Fact)

Before this change, `assembleInstallPlan` used `installationStatusFromReport()` to decide whether the whole tool was installed. That status comes from the Recommendation report, which looks at the tool in any client or scope. If the tool already existed in one place (for example the Cursor project file), every install request for that tool became `already-installed`, including requests for a different client or for user scope. Nothing was written, so the user could not add the tool to another client or scope from OpenHub.

## Policy (Decision)

An install target is identified by **Tool ID + client + scope + server name**. Each selected target is judged on its own, and only from that target's own configuration file:

| Target file state | Plan for that target | Written? |
| --- | --- | --- |
| No entry with the server name | **add** (config-patch step) | yes, after approval |
| Same entry already there | **unchanged** | no |
| Entry with the same name but different content | **conflict**, plan blocked with `CONFIG_KEY_EXISTS` | no, never overwritten |
| Claude Code user (`~/.claude.json`) | **manual**, as before (D-013) | no |

- Examples: Cursor project installed → Cursor user can be added; Cursor project installed → Codex project can be added; Cursor user installed → Cursor project can be added.
- "Same entry" means: the entry read from the file, converted back to plan form (`planFormOfEntry`: OpenHub tool-config path → `{toolConfig}`, Windows `node.exe` + `npx-cli.js` → `node {npxCli}`), has the same canonical sha256 as the standard entry this plan would write (`serverEntry`). Any other difference (arguments, env references, extra keys) is a conflict.
- For tools with an OpenHub tool config, the `--config` path must be this project's (or the user's) own OpenHub tool-config file for that scope. An entry copied from another project, which points at that project's tool config, is a conflict, not "unchanged".
- The plan is `already-installed` only when every writable selected target is unchanged. Then there are no steps, no approval items beyond `base`, and running it is a `no-op` (no process, no write, no Version State record).
- With several clients selected, existing identical targets stay as they are and only the new targets get steps. The preview lists every selected file with its own status (add / no change / conflict / manual). Approval items are computed from the targets that will actually be written: `user-scope-config` only if a user target is written, `client-env-parse-risk` only if Claude Code is written, client verification notices only for written clients. Tool-config steps are created only for scopes that are written.
- Failure handling is unchanged: compensation restores only the files this run wrote (receipts), so unchanged targets are never touched. Version State records only applied targets; existing records for unchanged targets stay byte-identical.
- User files are read only for user targets the user explicitly selected (`request.targets`). Project installs do not read user files. Recommendation scores and project analysis are unchanged; `source.recommendation.installationStatus` is still recorded as before and still drives the `installation-unknown` and `unidentified-present` approvals.
- If the recommendation says the tool is installed but the selected target is not, the preview status reads "Already configured for another client or scope" (Korean: "다른 Client·범위에 이미 설정됨") instead of "Already configured".

## Contract (Decision)

- `InstallPlan` stays `schemaVersion: 1`. One optional field is added: `targets[].precondition.entryDigest` (`sha256:<64 hex>`), present only when an entry with the server name exists. Targets without an entry do not have the field, so existing goldens and stored plans are byte-identical and still parse (tested with the M6 golden).
- `entryDigest` is part of the plan digest. If an unchanged target's entry changes after approval, the regenerated plan differs and the run stops with `PLAN_STALE` before writing anything (tested).
- New Core exports: `entryPlanDigest(value)` (same calculation as `configEntryDigest`), `installTargetChange(plan, target)` (add / unchanged / conflict / manual, computed from the plan only), `defaultEntryPlanForm` and an optional `planForm` argument on `inspectConfigTarget`. The entry value itself (paths, arguments) is never stored in the plan.
- Behavior change for existing tests (approved policy, not a schema change): AC-027-09 and AC-028-02 used a report-level "installed" tool with an empty target and expected `already-installed`. They now expect `installable` for a different target and `already-installed` only for an identical entry in the selected target. AC-035-02 (CLI) and AC-038-01 (Version State) wrote a non-standard entry (`npx` with no arguments) and expected `no-op`; they now write the standard entry for `no-op`, and AC-035-02 also checks that a different entry is a conflict (exit 1, no question, no process, file unchanged). AC-032-04 now also expects the `entryDigest` of the conflicting entry.
- The schema digest baseline (`test/fixtures/m7-final/schema-digests.json`, AC-073-09) records the new `installPlanSchema` digest with a note, as earlier additive v0.2.0 changes did.
- Known edge: when no backend is available (`launch` is null) an existing entry cannot be compared, so it is treated as a conflict and the plan is blocked or unsupported, instead of `already-installed` as before.

## Desktop (Decision)

- The install view gives each target a `change` value. The target list marks "no change" and "conflict"; the native approval dialog lists the files that will change, then the unchanged files as "no change". The user-scope warning appears only if a user file is actually written.
- The "No change" message for a user-scope request now says that the selected user configuration already has the same entry (the old text described the removed Core limitation).

## Verification (Fact)

- `packages/core/test/installer/scope-aware.test.ts` (real temporary files, fake npm, no network): the three add examples above; identical entry → `no-op` with zero writes, zero processes and zero Version State records; different entry → `CONFIG_KEY_EXISTS`, not approvable, file unchanged; several clients with one already installed → only new targets written, preview lists all files, an injected Codex write failure restores only the Claude Code file written in this run and leaves Cursor byte-identical; Version State gets only the new target and the old record is unchanged; unchanged entry edited after approval → `PLAN_STALE`, zero writes; schema compatibility; tool config: own path → unchanged, copied entry from another project → conflict, adding another client does not recreate the existing tool config (`keep`).
- `apps/desktop/test/i18n.test.ts`: English preview shows add, no change and conflict per target and translates the conflict warning only for the conflicting target.
- `apps/desktop/test/user-scope.test.ts`: project install first, then the same tool in user scope is installed (previously `no-op`); re-requesting the same user target is `no-op` with the user file and Version State unchanged; another client in user scope is still installable.

