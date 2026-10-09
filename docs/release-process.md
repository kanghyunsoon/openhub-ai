# Release process

This document describes how OpenHub AI release artifacts are built and verified.
A release is always built and checked as a **dry-run** first. Publishing is a separate, manual step.

## What gets built

| Artifact | Platform | Notes |
| --- | --- | --- |
| `openhub-ai-<version>.tgz` | Node.js 24.15+ (any OS) | CLI. Single bundle with the Registry, a metadata snapshot, LICENSE and THIRD_PARTY_NOTICES.md. Install with `npm i -g <tgz>`. |
| `OpenHub-AI-Setup-<version>-x64.exe` | Windows x64 | NSIS installer, **unsigned**. Windows SmartScreen or Smart App Control may warn before running it. |
| `OpenHub-AI-<version>-x86_64.AppImage` | Linux x64 | AppImage. |

There is no official macOS artifact (no Developer ID signing or notarization). Building from source on macOS is not blocked.

## Workflow

`.github/workflows/release.yml` runs on `workflow_dispatch` (inputs `dry_run`, default `true`, and `publish`, default `false`) and on `v*` tag pushes (dry-run build only).
The top-level permission is `contents: read`. Only the `release` job has `contents: write`, and it runs only when `publish == true`, `dry_run == false`, the ref is a SemVer tag `vX.Y.Z` and the tag equals the package version. It creates a **draft** GitHub Release; a maintainer reviews and publishes it. The workflow has no npm publish step and uses no secret other than the job's default `GITHUB_TOKEN`.

| Job | Output | Checks |
| --- | --- | --- |
| `metadata` | metadata snapshot (public GitHub metadata) | - |
| `cli` | CLI tgz | Syft component count, LICENSE/NOTICES in the tgz, clean-prefix install smoke (`--version`, `registry list`, `project scan`) |
| `windows` | NSIS installer, Windows artifact SBOM | Electron provenance, Syft scan, notices, unpacked `--smoke`, NSIS silent install → `--smoke` → uninstall |
| `linux` | AppImage | Syft component count, notices in the extracted AppImage, AppImage `--smoke` under xvfb |
| `sbom` | dependency SBOMs | CycloneDX schema + reference integrity, semantic determinism, bundle inventory ⊆ SBOM |
| `verify` | `SHA256SUMS`, `release-coverage.json` | checksums recomputed, every artifact has its SBOMs and checks |

The same steps run locally with `pnpm pack:cli`, `pnpm pack:desktop` and `pnpm release <command>` (see `scripts/release.ts`).

## SBOMs (CycloneDX JSON)

- **Dependency SBOMs (Layer A, `pnpm sbom --prod`)**: `openhub-cli-dependencies.cdx.json` and `openhub-desktop-dependencies.cdx.json`. Electron is a devDependency, so the Desktop SBOM gets one Electron runtime component taken from the lockfile and the installed `electron` package (property `openhub:source=electron-runtime`).
- **Windows artifact SBOM (Layer B, Syft v1.54.1, checksum-pinned)**: `openhub-windows-artifact.cdx.json`, an inventory of native and runtime binaries in the packaged Windows app (DirectX, SwiftShader, Vulkan, ffmpeg and similar). File metadata is disabled and absolute paths, tokens and credentials must be absent.
- Release SBOMs keep their real `serialNumber` and `timestamp`. Determinism is checked with a semantic digest that ignores only those fields and tool versions.
- SBOMs describe components. `SHA256SUMS` protects file integrity. They are separate files.

### Artifact ↔ SBOM coverage

| Release artifact | Dependency SBOM (pnpm sbom) | Artifact SBOM (Syft) | Other checks | Integrity |
| --- | --- | --- | --- | --- |
| CLI `openhub-ai-<version>.tgz` | `openhub-cli-dependencies.cdx.json` | not shipped (Syft finds 0 components; recorded as `detectedComponents`) | bundle inventory ⊆ dependency SBOM, LICENSE and THIRD_PARTY_NOTICES.md | `SHA256SUMS` |
| Windows x64 NSIS installer | `openhub-desktop-dependencies.cdx.json` (+ Electron runtime) | `openhub-windows-artifact.cdx.json` (native and runtime binaries) | app.asar inventory ⊆ dependency SBOM, Electron provenance, four license notices | `SHA256SUMS` |
| Linux x64 AppImage | `openhub-desktop-dependencies.cdx.json` (+ Electron runtime) | not shipped (Syft finds 0 components; recorded as `detectedComponents`) | app.asar inventory ⊆ dependency SBOM, Electron runtime version, four license notices | `SHA256SUMS` |

`release-coverage.json` records this table for every artifact listed in `SHA256SUMS`, including the Electron evidence for the desktop artifacts. The dry-run fails if any artifact lacks an SBOM or a check.

### Artifact scan limits

- Syft finds **no components** in the Linux AppImage or in the CLI tgz, and it cannot read inside Electron's `app.asar`. These artifacts therefore have no artifact SBOM; the dry-run report records `detectedComponents` for them instead.
- The JavaScript dependencies bundled into `app.asar` and the CLI bundle are covered by the dependency SBOMs. A bundle inventory check fails the release if any bundled package is missing from the dependency SBOM.

### Electron version on Windows

electron-builder renames `electron.exe` to `OpenHub AI.exe` and rewrites its version resource to OpenHub AI. Because of this branding, **Syft may not identify the Electron executable as Electron**. That is expected and is recorded as `syftElectronDetected` in `release-coverage.json`; it is not a release requirement.
The Electron version is verified by three independent checks instead:

1. **Dependency**: the Electron component in the Desktop dependency SBOM equals the lockfile version.
2. **Runtime**: the packaged app's `--smoke` reports `process.versions.electron` (and Chromium and OpenHub versions); it must equal the lockfile version for the unpacked app, the NSIS-installed app and the AppImage.
3. **Official distribution provenance**: the official `electron-v<version>-win32-x64.zip` from the `electron/electron` GitHub release must match that release's `SHASUMS256.txt`, and every file of that archive must be byte-identical in the packaged app, except three intentional changes: `electron.exe` (renamed and branded), `resources/default_app.asar` (replaced by the app) and `version` (removed). The Electron `LICENSE` is compared as `LICENSE.electron.txt`. Any other packaged file must be on an explicit allowlist, and Registry files must pass Registry validation and match the repository.

## License notices

The dry-run opens the real artifacts and fails if a notice is missing: OpenHub `LICENSE` and `THIRD_PARTY_NOTICES.md` in all artifacts, plus `LICENSE.electron.txt` and `LICENSES.chromium.html` in the Windows and Linux desktop apps.

## Publishing (manual)

1. Run the release workflow on the release tag with `dry_run=false` and `publish=true`.
   The `release` job checks that the tag equals the package version and that the eight required assets exist locally (installer, AppImage, CLI tgz, three SBOMs, `release-coverage.json`, `SHA256SUMS`). It then looks up existing Releases for the tag:
   - none: it creates a draft Release with the assets attached;
   - exactly one draft: it reuses that draft, re-uploads the assets and updates its notes;
   - a published Release, or more than one draft: it stops without changing anything.
   Finally it reads the draft back from the GitHub Release API and fails unless every required asset is present exactly once, is fully uploaded and has the local size, and every one of the eight assets has a GitHub digest (`sha256:<64 hex>`) equal to the hash of the local file (and, for the six checksummed files, to `SHA256SUMS`). A missing or malformed digest is a failure. A workflow artifact alone is not enough to pass. Rerunning the workflow for the same tag reuses the same draft instead of creating another one.
2. Open **that** draft from the repository's Releases list (drafts appear only there). Do not use "Draft a new release" or create a Release from the tag page: GitHub allows several Releases per tag, and a second Release starts with no assets.
3. Review the draft Release, its `SHA256SUMS`, SBOMs and `release-coverage.json`.
4. Publish the draft: on the draft's page choose **Edit**, then **Publish release**. From the command line, publish it by id and keep the tag in the same request:
   `gh api -X PATCH "repos/<owner>/<repo>/releases/<draft id>" -f tag_name=vX.Y.Z -F draft=false`.
   npm publishing is not part of this workflow.
5. Publishing triggers `.github/workflows/release-verify.yml`. It checks the published Release: one published Release for the tag, all eight assets present once, uploaded and non-empty, and the GitHub digests of the six checksummed files equal to the published `SHA256SUMS`. It does not claim to verify the digests of `SHA256SUMS` and `release-coverage.json` themselves (there is no independent expected hash for them after publishing; the draft check compared them with the built files). It only reads; a failure means the published Release is incomplete and must be fixed by hand.

   Limitation: this workflow runs with `contents: read`, and a read-only token does not list draft Releases. A leftover draft for the same tag is therefore not visible here; the release job (which has `contents: write`) refuses to run when a published Release or several drafts exist for the tag.

### Editing a draft's notes safely

When a draft Release is updated through the API without `tag_name`, GitHub detaches the draft from its tag (the tag shows as `untagged-…` and the draft URL changes). Always send the tag with the notes:

```sh
gh api --paginate --slurp "repos/<owner>/<repo>/releases?per_page=100" > releases.json
pnpm release github-notes --tag vX.Y.Z --releases releases.json --notes-file notes.md --out notes.json
gh api -X PATCH "repos/<owner>/<repo>/releases/<draft id>" --input notes.json
gh api --paginate --slurp "repos/<owner>/<repo>/releases?per_page=100" > releases.json
pnpm release github-verify --tag vX.Y.Z --releases releases.json --sums SHA256SUMS --expect draft
```

`github-notes` refuses to edit a published Release or a draft whose tag is already detached, and the payload never touches assets.

For v0.1.0 the workflow's draft (with all eight assets) stayed unpublished, and a second Release created for the same tag was published without assets; the assets were then attached by hand. The checks above make both situations fail loudly.
