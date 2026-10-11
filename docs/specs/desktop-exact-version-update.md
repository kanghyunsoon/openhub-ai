# Desktop: update to an exact version (v0.2.0)

Labels: **Fact**, **Decision**. Part of [v0.2.0](v0.2.0.md). The maintainer chose **option A** on 2026-10-11; the comparison below replaces the earlier design draft.

## Background and alternatives (Fact, Decision)

- Problem: the Core real-npm E2E changes memory-mcp 2026.7.4 → 2026.8.31 → 2026.7.4, but pins V1 only in the test. The packaged app uses the bundled Registry, whose memory-mcp Manifest is unpinned, and its Update had no version input, so the packaged RC could show only "unpinned → npm latest exact → previous". Kubernetes MCP Server and MongoDB MCP Server are pinned to one reviewed version.
- Constraints for the RC: it must not edit the Registry, inject a test Registry into the artifact, or change the user's existing MCP entries.
- Options considered:
  - **A (chosen):** an exact-version field for Update in the Desktop, passed to Core as `to`, with the existing approval path. It is a real user capability and lets the packaged RC run install → V1 → V2 → rollback with the bundled Registry. Cost: a new input on an approval path, so it is validated and tested at every boundary.
  - **B (not chosen):** start the packaged app with `OPENHUB_REGISTRY` pointing to a copy of the Registry where only memory-mcp is pinned to V1. No product change, but it proves the path with a test Registry, not with what users get.
  - **C (not chosen):** keep the packaged exact change NOT-RUN and rely on Core evidence only.

## What it does (Decision)

- In INSTALLED, an entry installed with **npx** shows an optional **Target version** field next to Update. Empty means the Registry's version (unchanged behavior). Other backends (uvx, Docker, Pinokio) do not show the field, and the main process rejects a version for them (`version-not-supported`).
- The value must be an exact `X.Y.Z` (no leading zeros). Ranges (`^`, `~`, `>=`, `1.x`), dist-tags (`latest`), pre-release and build suffixes, a `v` prefix, URLs, paths, `npm:` aliases, shell syntax, whitespace and values over 64 characters are rejected **before planning**: no resolver call, no npm, no dialog, no write. `X.Y.Z` is the same form Core treats as a pinned artifact, so the plan always includes npx Prepare.
- Input handling at each boundary: the renderer sends the field **as typed** (no trimming; `" 1.2.3"` and `"   "` are rejected by main). Only a completely empty field means "no version". The preload forwards every value other than `undefined` as `{ version }`, so a number, array, object, `null` or boolean is rejected by main instead of becoming a default update.
- The main process passes the value to Core only as `LifecycleRequest.to`. Everything else is the existing lifecycle path: the same plan preview, approval requirements, native approval dialog, `PLAN_STALE` check, npx Prepare before any client file is written, the Health gate with compensation, and rollback with its own approval.
- Tools with a reviewed tool configuration keep their limit: Kubernetes MCP Server accepts only 0.0.67. Another exact version produces a blocked plan (`TOOL_CONFIG_VERSION_UNREVIEWED`) with no run button; 0.0.67 is up to date.

## Approval dialog (Fact)

For update and rollback the dialog lists, in English or Korean: tool, client, scope and file per target, **Version: current → target**, the preparation command (`npx … --package=<name>@<version>`), tool configuration changes, the Health gate ("if it fails, this run's config changes are reverted and Version State is not changed"), warnings, every approval requirement ID with its text, and the plan digest.

## Plan consistency (Decision)

- Editing the version field clears the shown plan and calls `lifecycle:discard`. The main process drops the remembered plan and increases a discard generation, so a plan request still in flight is not remembered (`superseded`) and an approval given in a dialog that was open during the change is not used (`plan-changed`; no Prepare, Health or write).
- `lifecycle:run` receives the version shown on screen and refuses to open the dialog if it differs from the plan's target, including "no version" versus a version.
- IPC shape: `lifecycle:plan-update(id, { version? })` and `lifecycle:run(id, { version? })`. Other keys are ignored; a non-object second argument is rejected. The other lifecycle channels still take the entry ID only.

## Tests (Fact)

- `apps/desktop/test/exact-version-update.test.ts` (IPC with real files and Version State, unmodified Registry, fake npm that honours the npx Prepare cache contract, injected Health, no network): input validation; uvx rejection; memory-mcp unpinned → 2026.7.4 → 2026.8.31 → rollback to 2026.7.4 → Health with client entry, Version State, npm cache and dialog text checked; up-to-date; Health failure restores files and Version State; discard after planning, during planning and during the dialog; shown-version mismatch; English dialog; Kubernetes limited to 0.0.67; preload and renderer wiring.
- `apps/desktop/test/npx-lifecycle-smoke.test.ts` (OPENHUB_E2E=1, real Electron window): invalid input rejected, then 9.9.7 → 9.9.8 → rollback → Health by clicks.
- The packaged-app RC run (real npm, bundled Registry) is a separate step after this change is merged and new dry-run artifacts exist.
