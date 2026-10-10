# Desktop E2E as a required check (v0.2.0)

Part of [v0.2.0](v0.2.0.md). Labels: **Fact**, **Decision**, **Proposal**.

## Problem (Fact)

- `desktop-e2e.yml` ran only for pull requests that touched `apps/desktop/**`, `packages/core/src/**` or the workflow (`pull_request.paths`). A required check with a path filter never reports on other PRs, so those PRs would wait forever.
- All Electron files ran in one `vitest` command. A skipped suite (for example `OPENHUB_E2E` missing, or no Electron binary) exits 0, so a job could pass without running any Electron test.
- The repository currently has no branch protection and no ruleset on `main` (checked with the GitHub API; the maintainer account has admin rights).

## Workflow (Decision)

- Triggers: every `pull_request`, `push` to `main`, and `workflow_dispatch`. No path filter.
- Job `desktop-e2e / detect changes` compares `base...head` (pull request) or `before..after` (push). It sets `run=true` when any of these changed: `apps/desktop/`, `packages/core/src/`, `packages/core/package.json`, `registry/`, root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/check-e2e-results.mjs`, or the workflow itself. If the diff cannot be computed, or the run is manual, it runs.
- Job `desktop-e2e / electron` (only when `run=true`) runs each Electron E2E file as its own step, in order: i18n, repair, install clients, user scope, FOR YOU. A failing file does not stop the following files from running; any failure fails the job. No `continue-on-error`.
- The last step, `scripts/check-e2e-results.mjs`, reads each file's vitest JSON result and accepts it only if the file exists, at least one test passed, and failed, skipped and todo are all zero. A skipped Electron suite is a failure.
- Job `desktop-e2e` always runs and is the required check. It fails if change detection failed, or if E2E was needed and did not succeed. It passes with "Electron E2E not needed" when nothing relevant changed.
- `ELECTRON_DISABLE_SANDBOX=1` is set on the E2E job only (GitHub runners cannot set up Chromium's SUID sandbox helper). The app itself still creates windows with `sandbox: true`.
- Unit tests stay in `CI / check`. Real MCP verification stays in `registry-remote.yml` (manual and scheduled sandbox), which is not a required check.

## Required check (Proposal, after this PR is merged)

Apply only after this workflow is on `main`; applying it earlier would block PRs that do not touch the Desktop, because the old workflow does not report on them.

Ruleset for `main` (`refs/heads/main`), enforcement active:

- required status checks: `desktop-e2e`, plus the existing `check`, `codeql` and `secret-scan` (today none of them is enforced);
- "require branches to be up to date": off, to keep single-maintainer merges simple (can be turned on later);
- no bypass actors except repository admins, so a broken runner cannot lock the maintainer out.

The maintainer account has admin rights, so this can be applied through the API or Settings → Rules → Rulesets once approved.

## Verification (Fact)

- `scripts/check-e2e-results.mjs`: a run without `OPENHUB_E2E` (1 skipped) is rejected with exit 1; a real repair E2E run (1 passed) is accepted; a missing result file is rejected.
- Change detection on the last 12 `main` commits marks all of them as needing E2E (they all touched the Desktop or Core); a docs-only change and a change limited to other scripts and `ci.yml` are marked as not needed.
- On this PR the workflow itself changed, so the full Electron run executes (see PR checks). The "not needed" path on GitHub is observed on the first unrelated PR after merge.

