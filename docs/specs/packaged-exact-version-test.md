# Exact version change in the packaged app (design, v0.2.0 RC)

Labels: **Fact**, **Proposal**, **Open Question**. Design only; no code in this pull request.

## Problem (Fact)

- The Core real-npm E2E checks an exact version change (memory-mcp 2026.7.4 → 2026.8.31 → 2026.7.4), but pins V1 only in the test's memory.
- The packaged app uses the bundled Registry. Its Update has no version input: it resolves the Manifest's own spec. The bundled `memory-mcp` Manifest is unpinned, so the app can show "unpinned → npm `latest` exact → previous unpinned", not an exact V1 → V2 → V1. Kubernetes and MongoDB are pinned to one reviewed version and report up to date.
- The RC must not edit the Registry, inject a test Registry into the artifact, or change the user's existing MCP entries. So the exact sub-step is NOT-RUN in the packaged app today.

## Options (Proposal)

| Option | What changes | Pros | Risks |
| --- | --- | --- | --- |
| A. "Update to a specific version" in the Desktop | INSTALLED gets an optional exact-version field for Update. Main passes it to Core as `to` (Core already supports it). Tools with a reviewed tool config accept only reviewed versions (Kubernetes: 0.0.67), so nothing new is unlocked for them. Same plan preview, native approval, `PLAN_STALE`, Health gate and rollback. | Real user capability (pin to a known version, step back to a specific one). Lets the RC run install → update to V1 → update to V2 → rollback to V1 in the packaged app with the bundled Registry. | New input on an approval path: must be validated (exact semver only, no ranges, tags or URLs) and tested; UI and i18n work. |
| B. Explicit test Registry for the RC | The RC harness starts the packaged app with the documented `OPENHUB_REGISTRY` pointing to a copy of the bundled Registry where only `memory-mcp` is pinned to V1. Shown in the RC report as "test Registry". | No product change. | Not the bundled Registry; it proves the app's version-change path, not what users get by default. Must never be the default and is visible in the report. |
| C. Keep NOT-RUN | Nothing. | No work. | The packaged-app exact change stays unverified at release; only Core evidence. |

Recommendation: A, if a user-facing "choose version" is wanted for v0.2.0 or later; otherwise B for the RC only, clearly labelled. C is acceptable only if the release decision accepts the gap.

## Test plan for A (if approved)

- Unit: exact semver accepted; ranges, dist-tags, URLs, paths and unreviewed versions for tool-config tools rejected before planning; renderer cannot pass anything else.
- IPC: plan shows from/to versions; approval required; `PLAN_STALE` if the target changes; Health failure compensates.
- Packaged RC: install memory-mcp → update to 2026.7.4 → update to 2026.8.31 → rollback to 2026.7.4, real npm and real Health, client entry and Version State checked after each step.

## Open Question

- Is "update to a specific version" a v0.2.0 feature, or should the RC use option B and keep A for a later release?

