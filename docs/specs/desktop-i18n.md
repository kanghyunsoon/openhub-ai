# Desktop English and Korean (v0.2.0 P0-3 PR B)

Part of [v0.2.0](v0.2.0.md) (UX-1 to UX-3, D-v2-3). Desktop only: Core and CLI output are unchanged in this phase.

Labels: **Fact**, **Decision**, **Proposal**, **Open Question**.

## Language policy (Decision)

- Order: saved user choice > OS language (`ko` or `ko-*` → Korean) > English. The OS language is the first entry of Electron's preferred system languages, then the system locale.
- This replaces the earlier UX-3 proposal ("Korean when `~/.openhub/` already exists"): the maintainer chose the OS language rule for P0-3. Existing Korean users on a Korean OS keep Korean; users on another OS language get English and can switch once.
- The first launch does not write a choice. A choice is written only when the user changes the language.
- The language menu sits in the header. Changing it saves the choice, then reloads the window, so every screen is drawn again in the new language. There is no timer or polling.
- Stored in `<userData>/preferences.json` as `{ "language": "en" | "ko" }`. Writes are atomic (temporary file, then rename) and keep other keys. If the file is not valid JSON or not an object, OpenHub does not overwrite it and reports `preferences-unreadable`; the language does not change. Unknown values are ignored on read.
- Product names, tool IDs, approval requirement IDs, error codes, paths, command lines, digests and versions are never translated.

## Structure (Fact)

| Part | File | Role |
| --- | --- | --- |
| Catalogs | `apps/desktop/src/i18n/en.ts`, `ko.ts` | 320 stable keys. `ko` is typed against the `en` key set, so a missing key is a type error. |
| Lookup | `apps/desktop/src/i18n/index.ts` | `resolveLocale`, `translate`/`tr` with `{name}` interpolation as plain text, locale-aware `formatDateTime`/`formatDate`/`formatNumber`. A missing key returns the key itself (tests treat that as a failure). |
| Core sentences in English | `apps/desktop/src/i18n/core-en.ts` | Builds English text from Plan, Result and Status **structure** (codes, IDs, fields): approval requirements, warnings, blockers, recommendation reasons, capabilities, Health lines, next actions, trend items. |
| Selection | `apps/desktop/src/i18n/core-text.ts` | Korean: the Core sentence as is (same text as the CLI and goldens). English: `core-en.ts`. |
| Renderer | `renderer/i18n.js`, `data-i18n` attributes, `window.openhubI18n.t` | Text is inserted with `textContent` and attributes only, never as HTML. |
| Preload | `preload.ts` | Exposes `openhubI18n { locale, t, formatDateTime, formatNumber, setLanguage }`. The locale is read synchronously from main before the first paint. |

Decisions:

- No search-and-replace on Korean Core sentences. English text is built from structured data only.
- Core security contracts, Plan contents and Plan digests are not changed for translation. InstallPlan v1, LifecyclePlan v1, LifecycleStateFile v1 and CLI goldens are byte-identical.
- One additive Core field: `ReviewedToolConfig.noticeEn` holds the English text of the reviewed tool-config notice, next to the reviewed policy, so the Desktop does not carry tool-ID constants (AC-061-12). Plans keep using `notice`; `noticeEn` is never serialized into a Plan, a digest, the CLI or a golden (tested).
- The Desktop smoke check for "trend is not a security or quality score" now uses the same rule as the Core AC (`(security|quality|trust) score`, `보안 점수`, …). The English meaning says "It does not rate security or code quality", which is a disclaimer and not a violation.

## Translated in English mode (Fact)

Navigation, onboarding, project scan, FOR YOU (badges, scope, capabilities, reasons, OpenScore meaning, empty result), tool detail, DISCOVER (tabs, notices, trend meaning, candidates), install plan preview, native approval dialogs (install, update, rollback, Health, repair, Adopt, Benchmark), INSTALLED/lifecycle status, Health results, update, rollback, repair, Adopt and Benchmark (preview, approval items, blockers, results, errors), partial failure (`CONFIG_RESTORE_FAILED`, `COMPENSATION_INCOMPLETE`), `PLAN_STALE`, project-changed, error messages, warnings and security notices, Pinokio support notice, dates and numbers.

Coverage tests: every install, lifecycle, Adopt and Benchmark approval requirement ID, every Adopt and Benchmark blocker code, every recommendation reason code, every capability ID, and every warning, blocker or error code that Core installer, lifecycle, tool-config, adopt and benchmark modules emit has an English sentence.

### Adopt and Benchmark (Decision)

These are execution approvals, so English mode never shows the Core Korean preview. `apps/desktop/src/i18n/adopt-en.ts` builds the preview, approval items, blockers, results and errors from AdoptPlan, BenchmarkPlan, AdoptResult and BenchmarkReport fields, in the same order as the Core preview. Approval requirement IDs are unchanged and every ID is listed in the native dialog. The Benchmark preview states, from the plan: the number of server starts (warm-up + measured), the startup, handshake, per-run and total limits, that each run starts third-party code in an isolated temporary directory without a shell, that no MCP tool is called, that environment variables are passed by name only, and that Benchmark is not a Health Check (Version State and the recorded Health status do not change). Korean mode is unchanged (Core sentences).

### Warnings are never dropped (Decision)

`warningsEn()` returns one line per Core warning, in order:

- Known codes get an English sentence built from the plan structure. Codes that occur once per item (required environment variables, manual setup targets, existing entries, client and OS verification gaps) are paired by their position among the plan's warnings of the same code, using the same structure Core used to create them. Client and OS verification lines come from Core's `toolConfigVerificationGaps()`, the same function that creates the Korean warnings.
- An unknown code, a warning without a code, a code whose structure count does not match the number of Core warnings, or a single-sentence code that appears with different Core texts keeps its warning ID and the original Core text, prefixed with "(not translated)".
- Only exact duplicates (same code and same text) are shown once.

The same rule applies to lifecycle result warnings and Adopt/Benchmark errors.

## Not translated or reduced in English mode (Fact, with Proposal)

| Area | What English mode shows | Needed change (Proposal, additive) |
| --- | --- | --- |
| Pinokio plan notices | Core notice text | Notice codes on `PinokioPlan` |
| Release impact reasons | Codes with level, e.g. `version-major (high)` | Reason parameters (`from`, `to`, `runtime`) |
| Release summary items | Upstream release-note text (third-party, usually English) | None; third-party text is shown as is |
| Registry Manifest summaries and validation issues | Authored Manifest text and Core issue sentences | Optional `summary.en` in Manifests; issue codes |
| Desktop metadata-cache warning | Written to stderr only, not shown in the window | Warning code from `loadMetadataSnapshot` |
| Recommendation reasons | Generic sentence per reason code, without names or numbers | Reason parameters (`tech`, `file`, `dependency`) |
| Blockers that name a file (install, Adopt, Benchmark) | Generic sentence per code | File or entry name as a parameter |
| Benchmark run failure reasons | Core reason code as is (e.g. `spawn-failed`) | None needed; codes are already language-neutral |
| Failed-step excerpts | Omitted (status and code are shown) | Excerpt code |
| Core `nextActions` | Code-based guidance | Next-action IDs |
| Client launcher reason | Fixed sentence | Reason code |

## Verification (Fact)

- Unit (`apps/desktop/test/i18n.test.ts`): locale resolution, preference storage (atomic, other keys kept, unreadable file untouched), catalog parity, placeholders, no HTML, interpolation is text, all used keys exist, Core code coverage, English install preview, repair status, preview and dialog, Health failure, `PLAN_STALE`, project-changed, FOR YOU in both languages, `noticeEn` display-only, warning preservation (unknown code, unknown security notice, no code, multiple warnings of one code, count mismatch, client and OS warnings on Windows, Linux and macOS, Kubernetes Secret and RBAC notice).
- Adopt and Benchmark (`apps/desktop/test/adopt-i18n.test.ts`): real Core plans, approval kernel and the native dialog interface; English preview, dialog (every approval ID), blockers, results; rejection runs nothing; Korean mode keeps Core sentences.
- Existing Desktop tests force Korean (`test/locale-ko.ts`) and compare against the Korean catalog. Their behaviour assertions are unchanged.
- Electron (`apps/desktop/test/i18n-electron.e2e.test.ts`, `OPENHUB_E2E=1`): real app, temporary userData. First launch with `en-US` → English, 0 Korean characters, 0 missing keys; `ko-KR` → Korean, nothing saved; switching en → ko and ko → en through the real language menu (change event → main saves → reload); relaunch keeps the choice even when the OS language differs.
- Electron Adopt and Benchmark (same file, `OPENHUB_SMOKE_ADOPT=1`): the renderer clicks Adopt, then the Benchmark button that appears in INSTALLED; main's smoke dialog stand-in records title, message and detail and approves; a fake MCP server answers initialize and tools/list (6 starts). English: both dialogs and results have no Korean text and list every approval ID; `ko-KR`: Core Korean sentences.
- The repair Electron E2E pins `ko-KR` and a temporary userData so it does not depend on the developer's saved choice.

## Known limitation (Fact)

The Desktop update smoke (`OPENHUB_SMOKE_UPDATE`) uses a fake spawner that exits 0 without creating an npx cache entry, so npx tools stop at npx Prepare verification (`preparation-failed`). This is a test-environment gap, not an update failure, and predates this change (the smoke dependencies are unchanged since v0.1.0; npx Prepare arrived in #8). uvx tools such as `serena` pass install → update → Health → release in both languages. Follow-up (separate pull request, required before the v0.2.0 release): make the fake npm create the cache entry npx Prepare verifies (as the repair smoke already does) and cover npx install → update → Health → rollback.

## Open Questions

- Should CLI output follow the Desktop language, or stay Korean until a later version?
- Which of the proposals above should land first? Recommendation reason parameters have the largest visible effect.

