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

## Verification (Fact)

- `apps/desktop/test/for-you-diagnosis.test.ts`: real fixtures for `no-stack-detected` (readme-mentions), `no-verified-tool` (unity-editor-only), unmapped `jest` (jest-app), `stack-mismatch` (python-fastapi: mongodb), `installed` duplicates (claude-mcp: context7, playwright); synthetic profiles for `no-mapped-need`, `all-satisfied`, `candidates-excluded` with OS unsupported, client unsupported and backend unavailable; verification lines for Kubernetes on Linux and macOS and for tools without a record; list and scores equal to the report; every Core empty reason and exclusion code has English and Korean text; IPC ignores renderer arguments; renderer uses no HTML insertion.
- `apps/desktop/test/for-you-electron.e2e.test.ts` (real Electron window, `OPENHUB_E2E=1`): unity-editor-only shows the reason in English and Korean; claude-mcp shows the two duplicate exclusions, the notice and one verification line per recommendation. Added to the Linux desktop-e2e workflow.

