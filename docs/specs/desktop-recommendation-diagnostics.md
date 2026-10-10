# Desktop recommendation diagnostics (v0.2.0 P0-3 C3)

Part of [v0.2.0](v0.2.0.md) and follows [stack-coverage.md](stack-coverage.md) (Core `diagnoseRecommendation`, P0-1). Labels: **Fact**, **Decision**, **Proposal**.

FOR YOU used to show only "No tools to recommend." when the list was empty. The CLI already printed the Core reason. This change brings the same Core information to the Desktop, in English and Korean, without new scores or invented candidates.

## Sources (Fact)

- `diagnoseRecommendation(profile, report)` gives `emptyReason` (only when there are no recommendations), `unmappedTechs` and `needsWithoutVerifiedTool`.
- `RecommendationReport.needs[].candidates[].excludedBy` gives the Core exclusion codes per candidate: `installed`, `stack-mismatch`, `client-unsupported`, `platform-unsupported`, `runtime-unsatisfied`, `backend-unavailable`.
- `clientVerificationLevel(toolId, client, os)` gives OpenHub's recorded run verification per client and OS, for tools with a reviewed record.

## What FOR YOU shows (Decision)

| Situation | Core source | Shown |
| --- | --- | --- |
| Stack not recognized | `no-stack-detected` | "No language, framework, database or infrastructure was recognized … A README mention is not used as evidence." |
| No need rule for the recognized technologies | `no-mapped-need` | "Technologies were recognized, but none of them is linked to a capability rule yet." |
| No Verified Registry tool | `no-verified-tool` | "This project needs capabilities, but the Verified Registry has no tool for them." |
| Everything already covered | `all-satisfied` | "Every needed capability is already covered by an installed tool." |
| Candidates exist but all excluded | `candidates-excluded` | the reason plus the excluded list below |
| Recognized technology without a rule | `unmappedTechs` | "Recognized, but not linked to any capability rule yet: jest" (also when there are recommendations) |
| Excluded candidate | `excludedBy` | "Name (capabilities): reason · reason" for: already installed (duplicate), stack mismatch, client unsupported, OS unsupported (Manifest), runtime not met, no install method on this computer |
| Verification level | `clientVerificationLevel` | one line per recommendation: "Registry listed · OpenHub run check on Linux: Claude Code verified, Codex verified, Cursor not verified", or "Registry listed · OpenHub has not recorded a per-client run check for this tool on Linux" |

- Registry listing and run verification are never shown as the same thing. A notice under the list says so.
- Verification level is information only. Core does not exclude tools because of it, and the Desktop does not present it as an exclusion reason.
- "Install method unavailable" appears only if Core reports `backend-unavailable`. The Desktop FOR YOU call does not probe backends (as before), so on the Desktop the install backend is checked when the install plan is made, not in FOR YOU.
- Capabilities without any registered tool keep the existing "No registered tool" lines.
- The recommendation list, order and Project Fit / OpenScore values are unchanged. Excluded entries come only from the report's candidates and never include a recommended tool.
- Main builds the view from the Profile analysed through the project dialog; renderer arguments are ignored (as before). The renderer writes text with `textContent` only.

## Adding an already-used tool to another client or scope (Decision, review follow-up)

Core (PR #20) decides installs per target (Tool ID + client + scope + server name), but Core's recommendation excludes tools already used in the project (`installed`). Without a second entry point the Desktop would answer `not-recommended` for a tool the Core would let the user add to another client or scope.

- Wording separates recommendation from installation. The `installed` exclusion now reads: "already used in this project, so it is not recommended again. You may be able to add it to another client or scope; the install plan decides after you choose them" (Korean equivalent). The other exclusion reasons are unchanged, and verification level is still not an exclusion reason.
- Only candidates whose single exclusion reason is `installed` get an **Add to another client or scope** button (`addable`). It opens the same client and scope chooser as a normal install, with a note that existing entries are kept and that the plan shows add / no change / conflict per file. No client is preselected.
- Entry paths: (A) `recommended`, the tool is in the recommendation list; (B) `installed-elsewhere`, the tool is a need candidate with status `installed` in a report that main regenerates for the current project on every `install:options` and `install:plan`. Any other tool ID (excluded for stack, client or OS, not a candidate, not in the Registry, not a string) is `not-recommended`; the renderer cannot install arbitrary Registry tools.
- After that check, path B uses the normal flow: Manifest client support and OS shown in the chooser, the selected targets inspected by Core, conflicts blocked, only new targets written, existing targets and Version State kept, approval in the native dialog (`user-scope-config` for user targets). The C1 plan generations, `PLAN_STALE` and project-change invalidation apply unchanged.
- Recommendation scores and order are unchanged; opening the chooser or planning does not change the next recommendation.

## Verification (Fact)

- `apps/desktop/test/for-you-diagnosis.test.ts`: real fixtures for `no-stack-detected` (readme-mentions), `no-verified-tool` (unity-editor-only), unmapped `jest` (jest-app), `stack-mismatch` (python-fastapi: mongodb), `installed` duplicates (claude-mcp: context7, playwright); synthetic profiles for `no-mapped-need`, `all-satisfied`, `candidates-excluded` with OS unsupported, client unsupported and backend unavailable; verification lines for Kubernetes on Linux and macOS and for tools without a record; list and scores equal to the report; every Core empty reason and exclusion code has English and Korean text; IPC ignores renderer arguments; renderer uses no HTML insertion.
- `apps/desktop/test/for-you-electron.e2e.test.ts` (real Electron window, `OPENHUB_E2E=1`): unity-editor-only shows the reason in English and Korean; claude-mcp shows the two duplicate exclusions, the notice and one verification line per recommendation. Added to the Linux desktop-e2e workflow.
- `apps/desktop/test/add-elsewhere.test.ts` (main IPC, real Core plans and files, fake npm, injected Health): after a Cursor project install the tool leaves the list and shows as addable (B), list and scores equal the Core report and do not change after options/plan (M); main rejects other tool IDs; Cursor user added with `user-scope-config`, project and other user entries byte-identical (C, G, N); Codex project added, Cursor entry and its Version State record kept, then Status, Health, tool-config-missing, blocked re-plan and approved repair (D, K); same target → `no-op`, same name with different content → conflict, not approvable, no dialog (E, F); rejection writes nothing (H); file changed after planning → `PLAN_STALE`, external content kept (I); project change → `no-plan` (J); English and Korean texts (L).
- `for-you-electron.e2e.test.ts` (real window): a react-pnpm copy with Playwright in the Cursor project file shows the add button; clicking it adds Codex project (one dialog, Cursor file byte-identical) and Cursor user (`user-scope-config`); the same Cursor project target is "no change" with no dialog; Korean run.
- Real MCP Health (separate from the screen E2E, whose Health is fake): `packages/core/test/registry/kubernetes-tool-config.e2e.test.ts` installs Kubernetes 0.0.67 in the Cursor project, then plans Codex project + Cursor project + Cursor user (add / unchanged / add), writes only the two new targets, runs the real server from both new entries (13 tools, Secret get/list denied, ConfigMap read, no token or secret in the transcript) and a real lifecycle Health on the Codex target (healthy, 13 tools), with a synthetic Kubernetes API and fake credentials.

