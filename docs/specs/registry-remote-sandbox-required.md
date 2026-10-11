# Registry sandbox job no longer hides failures (v0.2.1)

## Change history

| Version | Rule | Source |
| --- | --- | --- |
| M6 (D-025, AC-054-08) | `registry-remote.yml` runs only on `workflow_dispatch` and `schedule`. Both jobs (`remote`, `sandbox`) use `continue-on-error: true`. Not a PR required check. | TASK-054 |
| v0.2.1 (this change) | Same triggers, still not a PR required check. The `sandbox` job no longer uses `continue-on-error`: a failed real install, Health or tool check fails the job and the workflow run. The `remote` job (unauthenticated repository metadata: archived, license, release source) keeps `continue-on-error` as an advisory check, because GitHub API rate limits and upstream metadata changes are outside this repository's control. | v0.2.1 review decision |

AC-054-08 is revised accordingly. The test in `packages/core/test/registry/registry-ci.test.ts` now requires `continue-on-error` on `remote`, its absence on `sandbox`, and `if: always()` on both report steps.

## Why

With `continue-on-error`, a red sandbox job showed a green run. Earlier Registry work had to read test-level logs to know the result (see the MongoDB and Kubernetes Registry specs). A real regression, such as postgres-mcp failing on an empty uv cache in v0.2.1, would not have turned the scheduled run red.

## Failure behavior

- A failing sandbox test fails the "Sandbox install + M5 Health" step, the `sandbox` job, and the workflow run.
- The report steps run with `if: always()`. `sandbox-report.json` and `metrics-report/` are uploaded as `sandbox-report`. The report keeps counts, states and durations only; test names, failure messages, paths and output are dropped (TASK-067).
- `inject_failure` (manual input, default `false`) adds one test that fails on purpose. It exists only to check this behavior. Scheduled runs and normal manual runs set it to an empty value.

## Not changed

- The four required PR checks (`desktop-e2e`, `check`, `codeql`, `secret-scan`) and the ruleset.
- `ci.yml` still does not run remote validation or `OPENHUB_E2E` tests.
