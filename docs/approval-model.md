# Approval model

## Plans

Each operation has its own plan type with a schema version: install plans, lifecycle plans (update, rollback, health), adopt plans, benchmark plans and Pinokio plans. A plan is serialized as canonical JSON and identified by its SHA-256 digest.

A plan lists:

- the target client, scope and config file;
- the backend and the exact command;
- the files it changes and how;
- network use and artifacts it may download;
- required environment variable names (never values);
- warnings and the approval requirements.

## Approval requirements

Every plan has a `base` requirement. Some situations add explicit requirements that must each be confirmed, for example:

| Requirement | When |
| --- | --- |
| `floating-artifact` | the package or image version is not pinned |
| `user-scope-config` | a user-level config file will be written |
| `fallback-backend` | the preferred backend is unavailable |
| `client-env-parse-risk` | a client may not parse environment references |
| `health-gate-skipped` | the tool needs environment variables OpenHub cannot check, and you choose to skip the health check |
| `identity-strong-match` | adopt matched by package but the server name differs |
| `artifact-fetch` | a benchmark may download the pinned artifact |

## Execution

1. The plan is shown.
2. You confirm in an interactive terminal (type the tool ID, then answer each requirement) or in a native desktop dialog.
3. Right before execution the plan is rebuilt. If its digest differs from the approved one, execution stops with `PLAN_STALE` and you are asked again.
4. The approval is consumed and cannot be reused.

## Health and rollback

- Updates write Version State only after the health check passes. A failed health check restores the previous config and leaves Version State unchanged; there is no "apply anyway".
- A skipped health check is recorded as not verified, never as healthy.
- Rollback is a separate plan with its own approval. Automatic rollback does not exist.

## Not approvals

Recommendations, OpenScore, Trending, release summaries, impact verdicts, AI summaries, identity matches and discovery candidates inform your decision. None of them approve anything.
