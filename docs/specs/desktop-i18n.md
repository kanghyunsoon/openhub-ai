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

Navigation, onboarding, project scan, FOR YOU (badges, scope, capabilities, reasons, OpenScore meaning, empty result), tool detail, DISCOVER (tabs, notices, trend meaning, candidates), install plan preview, native approval dialogs (install, update, rollback, Health, repair), INSTALLED/lifecycle status, Health results, update, rollback, repair, partial failure (`CONFIG_RESTORE_FAILED`, `COMPENSATION_INCOMPLETE`), `PLAN_STALE`, project-changed, error messages, warnings and security notices, Pinokio support notice, dates and numbers.

Coverage tests: every install and lifecycle approval requirement ID, every recommendation reason code, every capability ID, and every warning or blocker code that Core installer, lifecycle and tool-config modules emit has an English sentence.

## Not translated or reduced in English mode (Fact, with Proposal)

| Area | What English mode shows | Needed change (Proposal, additive) |
| --- | --- | --- |
| Adopt and Benchmark plan previews | Core Korean lines (`formatAdoptPlanPreview`, `formatBenchmarkPlanPreview`) | Structured preview items (`{ id, params }`) next to the formatted lines |
| Pinokio plan notices | Core notice text | Notice codes on `PinokioPlan` |
| Release impact reasons | Codes with level, e.g. `version-major (high)` | Reason parameters (`from`, `to`, `runtime`) |
| Release summary items | Upstream release-note text (third-party, usually English) | None; third-party text is shown as is |
| Registry Manifest summaries and validation issues | Authored Manifest text and Core issue sentences | Optional `summary.en` in Manifests; issue codes |
| Desktop metadata-cache warning | Written to stderr only, not shown in the window | Warning code from `loadMetadataSnapshot` |
| Recommendation reasons | Generic sentence per reason code, without names or numbers | Reason parameters (`tech`, `file`, `dependency`) |
| Blockers that name a file | Generic sentence per code | File or entry name as a parameter |
| Failed-step excerpts | Omitted (status and code are shown) | Excerpt code |
| Core `nextActions` | Code-based guidance | Next-action IDs |
| Client launcher reason | Fixed sentence | Reason code |

## Verification (Fact)

- Unit (`apps/desktop/test/i18n.test.ts`): locale resolution, preference storage (atomic, other keys kept, unreadable file untouched), catalog parity, placeholders, no HTML, interpolation is text, all used keys exist, Core code coverage, English install preview, repair status, preview and dialog, Health failure, `PLAN_STALE`, project-changed, FOR YOU in both languages, `noticeEn` display-only.
- Existing Desktop tests force Korean (`test/locale-ko.ts`) and compare against the Korean catalog. Their behaviour assertions are unchanged.
- Electron (`apps/desktop/test/i18n-electron.e2e.test.ts`, `OPENHUB_E2E=1`): real app, temporary userData. First launch with `en-US` → English, 0 Korean characters, 0 missing keys; `ko-KR` → Korean, nothing saved; switching en → ko and ko → en through the real language menu (change event → main saves → reload); relaunch keeps the choice even when the OS language differs.
- The repair Electron E2E pins `ko-KR` and a temporary userData so it does not depend on the developer's saved choice.

## Known limitation (Fact)

The Desktop update smoke (`OPENHUB_SMOKE_UPDATE`) uses a fake spawner that exits 0 without creating an npx cache entry, so npx tools stop at npx Prepare verification (`preparation-failed`). This predates this change (the smoke dependencies are unchanged since v0.1.0; npx Prepare arrived in #8). uvx tools such as `serena` pass install → update → Health → release in both languages.

## Open Questions

- Should CLI output follow the Desktop language, or stay Korean until a later version?
- Which of the proposals above should land first? Recommendation reason parameters have the largest visible effect.

