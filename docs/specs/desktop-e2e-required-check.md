# Desktop E2E as a required check (v0.2.0)

Part of [v0.2.0](v0.2.0.md). Labels: **Fact**, **Decision**, **Proposal**.

## Problem (Fact)

- `desktop-e2e.yml` ran only for pull requests that touched `apps/desktop/**`, `packages/core/src/**` or the workflow (`pull_request.paths`). A required check with a path filter never reports on other PRs, so those PRs would wait forever.
- All Electron files ran in one `vitest` command. A skipped suite (for example `OPENHUB_E2E` missing, or no Electron binary) exits 0, so a job could pass without running any Electron test.
- The file list was hard-coded. `apps/desktop/test/npx-lifecycle-smoke.test.ts` already contained an `OPENHUB_E2E` Electron suite that the Linux workflow never ran.
- The repository had no branch protection and no ruleset on `main` (GitHub API; the maintainer account is admin).

## What the Desktop E2E depends on (Fact)

Checked from imports and paths in `apps/desktop/test/*`, `apps/desktop/src` and `apps/desktop/build.mjs`: Desktop source and tests, Core source and `package.json`, Core test helpers (`packages/core/test/installer/harness.ts`, `process/fake-npm.ts`, `recommendation/helpers.ts`) and fixtures (`packages/core/test/fixtures/**`), `registry/`, `examples/demo-project`, `scripts/stage-registry.mjs` (Desktop build), root `vitest.config.ts`, `tsconfig.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and line-ending settings (`.gitattributes`). No Desktop file imports `apps/cli`, the repository `test/` folder, or any `*.test.ts` file.

## Workflow (Decision)

- Triggers: every `pull_request`, `push` to `main`, and `workflow_dispatch`. No path filter.
- `desktop-e2e / detect changes` writes the changed files (`base...head` for PRs, `before..after` for pushes) and asks `node scripts/desktop-e2e.mjs changes`. Only these paths count as "not needed": `docs/`, root `*.md`, `LICENSE`, `.editorconfig`, `.gitleaks.toml`, `.github/` except this workflow, `packages/*/test/**/*.test.ts`, `apps/cli/`, `test/`. Every other path, including unknown new files, needs the E2E. Diff or classification failures and manual runs always run it.
- `desktop-e2e / electron` runs each Electron E2E file as its own step, in order. All files run even if one fails; any failure fails the job. No `continue-on-error`.
- The last step, `node scripts/desktop-e2e.mjs check e2e-results`, finds every file under `apps/desktop/test` that is switched on by a line-leading `describe/it/test.skipIf(…process.env["OPENHUB_E2E"]…)`, and fails if any of them has no result (not registered in the workflow), or if any result is missing, unreadable, has zero passed tests, or has failed, skipped or todo tests.
- `desktop-e2e` always runs and is the check to require: it fails if change detection failed or if the E2E was needed and did not succeed, and reports "Electron E2E not needed" otherwise.
- `ELECTRON_DISABLE_SANDBOX=1` is set on the E2E job only (GitHub runners cannot set up Chromium's SUID sandbox helper). The app still creates windows with `sandbox: true`.
- Unit tests, including `apps/desktop/test/desktop-e2e-workflow.test.ts` for the classifier, discovery, the check and workflow/file consistency, stay in `CI / check`. Real MCP verification stays in `registry-remote.yml`.

## Required check (Decision, applied after merge)

Ruleset on `refs/heads/main`, enforcement active: required checks `desktop-e2e`, `check`, `codeql`, `secret-scan` from GitHub Actions; pull request required with zero required approvals (single maintainer); "require branches to be up to date" off; repository admin bypass kept for emergency recovery only. The applied ruleset and its ID are recorded in the PR that follows this one.

## Verification (Fact)

- Electron E2E files found: 6 (for-you, i18n, install-clients, npx-lifecycle-smoke, repair, user-scope). Windows run with the same per-file commands: 13 tests passed, 0 skipped, check "6 found, 6 run".
- `desktop-e2e-workflow.test.ts`: docs, other workflows, package test files, CLI and repository tests are "not needed"; Desktop, Core source, helpers, fixtures, Registry, examples, build script, dependencies, shared config, `.gitattributes`, this workflow and unknown files are "needed"; an unregistered new E2E file, missing or broken results, skipped, todo, zero passed and failed results are all rejected.

