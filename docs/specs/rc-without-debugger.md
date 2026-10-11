# Packaged RC without debugger flags (design, v0.2.1)

Status: **design only**. Packaging options and the v0.2.1 binaries do not change. The current RC stays in use until a replacement is approved and proven.

## Constraints (decided)

- The binary that is released must be the binary that the packaged RC verified, byte for byte. A separate "fuses on" test build is not accepted.
- Electron fuses stay as they are in v0.2.1.
- Goal: a future release can turn off `RunAsNode`, `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable`, and refuse `--remote-debugging-port`, while the RC still exercises the real native approval dialog.

## What the current RC depends on (Fact)

`scripts/rc/packaged-rc.mjs` starts the real packaged app with two debugger entry points:

| Entry point | Used for |
| --- | --- |
| `--remote-debugging-port` (Chrome DevTools Protocol, renderer) | Calls the renderer's `window.__openhub*` functions that the buttons use, and reads results and screen text. |
| `--inspect` (Node inspector, main process) | Replaces `dialog.showMessageBox` with scripted answers (approve, reject, change a file while the dialog is open) and records the dialog title and text. |

With the inspect fuse off and remote debugging refused, neither works. The shipped binary also contains the `--smoke` paths (fake backends, auto-confirming dialog), gated by `--smoke` plus `OPENHUB_SMOKE_*` variables. They are a separate test surface and are listed under Open Questions.

## Proposal: drive the real UI through the operating system's accessibility layer

Run the released binary with no extra flags and interact with it the way a person or a screen reader does.

### Native approval dialog

- **Windows.** Electron's `dialog.showMessageBox` is a standard Win32 task dialog. UI Automation (UIA) can find it as a top-level window of the OpenHub process, read its title and content text, and invoke a button by its accessible name ("Approve" / "승인", "Cancel" / "취소"). Tooling options: PowerShell with `System.Windows.Automation` (part of .NET on Windows, no extra install), or FlaUI. A file change while the dialog is open is done by the harness between "dialog found" and "button invoked", as today.
- **Linux.** Electron uses a GTK message dialog. AT-SPI (the GNOME accessibility bus) exposes it under Xvfb when accessibility is enabled for the session (`at-spi2-core` running, `GTK_MODULES` includes the bridge, or `NO_AT_BRIDGE` not set). The harness finds the dialog by role "alert" or "dialog", reads the label text and activates the button. Tooling: `python3-pyatspi` or `dogtail` in the CI image.
- The harness proves it saw the **real** dialog by checking the process id of the dialog window and the exact strings that OpenHub's approval text builder produces. The dialog content is not taken from the app's own logs.

### Renderer actions

- Chromium builds an accessibility tree when an assistive technology asks for it. On Windows UIA requests it automatically, and on Linux AT-SPI does when accessibility is enabled. Buttons, list items and status text in OpenHub's renderer are standard HTML controls with visible labels, so the harness can click "Install", choose a client and read the plan preview through UIA or AT-SPI without CDP.
- Required app work (later, small): make sure every control that the RC uses has a stable accessible name (`aria-label` where the visible text is not unique), and expose the result area as a live region. No new IPC, no test-only code path.
- `window.__openhub*` stays as it is for the existing Electron E2E (unpackaged, `OPENHUB_E2E`). The packaged RC stops using it.

### Results

The harness checks results from the outside, as today: client config files, `~/.openhub/state/lifecycle.json`, journal files, and the text shown in the window (read through accessibility). It does not need the main process.

## Rollout

1. **Spike, read-only.** On Windows, start the packaged v0.2.x app, open an install plan, and read the native dialog's title, text and buttons through UIA. On Linux, do the same with AT-SPI under Xvfb. Success means the text matches what the current RC records through `--inspect`.
2. **Parallel run.** Add an accessibility-driven variant of one RC step (install approve and reject) next to the current harness for the same artifact. Both must agree for several runs.
3. **Full replacement.** Port the remaining steps. Only then propose a release with fuses off and `--remote-debugging-port` refused, verified by the accessibility RC on the exact release bytes.

## Risks and Open Questions

- Localized button names: the RC sets the app language explicitly, as it does now.
- CI images: Windows runners have UIA. Linux runners need Xvfb, `at-spi2-core` and a session bus; the RC workflow already uses Xvfb for the AppImage.
- Timing: accessibility events are slower than CDP. Steps need explicit waits on window and element appearance, not fixed sleeps.
- The `--smoke` paths in the shipped binary: keep them (gated, fake backends, used by the existing smoke E2E), or move them behind a build-time flag that is identical in every released build. Needs its own decision.
- macOS (no release today) would use the macOS Accessibility API. Out of scope.

