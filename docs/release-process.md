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
2. Review the draft Release, its `SHA256SUMS`, SBOMs and `release-coverage.json`.
3. Publish the draft. npm publishing is not part of this workflow.
