# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |
| older | no |

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the affected version, your platform, steps to reproduce and the output of `openhub doctor --json` if it helps (it contains no tokens or absolute paths). We aim to acknowledge reports within a week.

## Security model in short

- **Approval**: install, update, rollback, health check, adopt, benchmark and Pinokio runs need a plan you approve in an interactive terminal or a native desktop dialog. The plan is rebuilt before execution and must match (`PLAN_STALE` otherwise). There is no auto-approve option. See [Approval model](docs/approval-model.md).
- **Execution**: no shell, fixed executable and arguments, isolated temporary directories and time limits for health checks and benchmarks. See [Security model](docs/security-model.md).
- **Secrets**: environment variables are handled by name only; tokens are never stored or logged.
- **Discovery candidates are untrusted**: they are UNVERIFIED drafts, shown as plain text, never installed, adopted or updated. See [Discovery trust](docs/discovery-trust.md).
- **LLM**: the optional AI summary is display-only, sends release note data to `api.openai.com` only after you ask, and reads the API key at that moment without storing it. See [LLM privacy](docs/llm-privacy.md).
- **Pinokio**: support targets pterm 0.0.25. Default tests use a fake pinokiod; real Pinokio integration runs only when OPENHUB_E2E=1. OpenHub runs only scripts it generates from a fixed template and never runs third-party Pinokio scripts. A Pinokio rollback does not guarantee that virtual environments and installed packages return exactly to their previous state.
- **Releases**: the Windows installer is unsigned. Verify downloads with `SHA256SUMS`; SBOMs are published with each release. See [Release process](docs/release-process.md).

## Scope

In scope: the OpenHub CLI, desktop app, core library and Registry Manifests in this repository. Vulnerabilities in third-party MCP servers or tools listed in the Registry should be reported to their maintainers; tell us as well if a Manifest should change.
