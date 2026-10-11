# Known issues in v0.2.0

These issues affect the published v0.2.0 release. The release and its assets are not changed; fixes ship in a later release. "Fixed on main" means the fix is merged but **not released yet**. "Fix in review" means a pull request is open.

Also see the existing limits in the [v0.2.0 release notes](release-notes/v0.2.0.md): Cursor launches are not verified, macOS is not verified, Kubernetes is limited to `kubernetes-mcp-server@0.0.67`, and the Windows installer is unsigned.

## Installing while switching projects (Desktop)

- **Symptom:** you pick project B while project A's recommendations are shown, then install from the list before B's analysis finishes. The tool can be written into B's configuration.
- **Workaround:** wait until the new project's analysis has finished and the list has refreshed before installing. The approval dialog lists the configuration files it will change; check them before approving.
- **Status:** fixed on main (#34). The dialog also names the target project.

## Using your home folder as the project

- **Symptom:** if the project folder is your home folder (or a link to it), a project-scope install for Cursor or Codex writes `~/.cursor/mcp.json` or `~/.codex/config.toml`, which are your user-scope files, without the user-scope approval.
- **Workaround:** do not open your home folder as a project. Choose the actual project folder, or install with user scope on purpose.
- **Status:** fixed on main (#34): blocked with `PROJECT_TARGET_IS_USER_CONFIG`.

## Update interrupted (app closed or killed during Health)

- **Symptom:** after an update, rollback or repair was interrupted, the tool shows `config-drift`. Update and Health are blocked, Rollback has no previous version (for a first update), and Repair only applies to tools with an OpenHub tool config.
- **Workaround:** open the configuration file named in `openhub lifecycle status` and change that server entry back to the command in the tool's Registry Manifest (`registry/<category>/<tool>.yaml` in this repository, `install.options.command`), or remove the entry and install again. OpenHub does not change the file for you.
- **Status:** fix in review (#40): an operation journal and `openhub lifecycle recover <tool>`, which shows the interrupted operation and restores the previous entry only after you approve it and only if the file still matches what OpenHub was writing.

## Running installs or updates at the same time

- **Symptom:** when the CLI and the Desktop app (or two terminals) change tools at the same moment, one Version State record can be lost. That tool then shows as untracked.
- **Workaround:** run one install, update, rollback, repair or Health at a time. If a tool shows as untracked afterwards, register it again with Adopt (Desktop INSTALLED, or `openhub adopt`).
- **Status:** fix in review (#38): only one operation runs at a time; others stop with `OPERATION_IN_PROGRESS` and change nothing.

## Postgres MCP Pro does not start on a new machine

- **Symptom:** on a computer whose uv cache does not already contain the tool, `postgres-mcp` exits with `No module named 'mcp.server.fastmcp'`. The Health check fails, and the client cannot start the server. The cause is that the package accepts the MCP SDK 2.x, which renamed that module.
- **Workaround:** in the client configuration, change the server's arguments to `--from postgres-mcp --with mcp==1.30.0 postgres-mcp --access-mode=restricted` (command `uvx`). On Windows the first Health after that can still time out while uv installs the packages (see below); run Health again.
- **Status:** fix in review (#39).

## Slow first start of uvx tools on Windows (serena, postgres-mcp)

- **Symptom:** on Windows, the first Health right after installing serena or postgres-mcp can stop with `startup-timeout`, because uv downloads and installs the Python packages within the 20 s limit. Later starts are faster (measured: serena about 6 s, postgres-mcp about 10 s).
- **Workaround:** run Health again (`openhub lifecycle health <tool>` or the Desktop button), or start the client once and wait for the server.
- **Status:** design proposal in review (#41, uvx Prepare). Linux was within the limit in our measurements.

## Adopted entries with extra options

- **Symptom:** v0.2.0 Adopt registers an existing configuration entry when its package matches the Registry, even if the entry has options the Registry did not review (for example a different package registry, a missing `--readOnly` or `--read-only`, or `--access-mode=unrestricted`). OpenHub then shows it as managed.
- **Workaround:** if you adopted entries in v0.2.0, compare their command and arguments with the tool's Registry Manifest (`registry/<category>/<tool>.yaml`, `install.options.command`). If they differ, remove the entry and install it again through OpenHub, or keep managing it yourself.
- **Status:** fixed on main (#37): Adopt requires the reviewed arguments.

## Other issues found in v0.2.0

- **Health errors during an update** (for example, the temporary folder cannot be created) can leave the new configuration in place without the usual restore. Check the file if an update ends with an error instead of a result. Fix in review (#36).
- **Damaged `~/.openhub/state/lifecycle.json`**: installs still write the client configuration but cannot record it, so the tool shows as untracked. Restore the file from `lifecycle.json.bak` if it is valid. Fix in review (#36): installs are refused until the file can be read.

