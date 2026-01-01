import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { CONFIG_SCOPES, INSTALL_BACKENDS, INSTALL_CLIENTS, canonicalize } from "../installer/plan";
import { resultStepSchema } from "../installer/result";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { LIFECYCLE_OPERATIONS, LIFECYCLE_PLAN_CHANGE_KINDS } from "./plan";
import { HEALTH_STATUSES } from "./state";

/**
 * LifecycleResult v1(TASK-043, §9). update·rollback·health 실행 결과(메모리 객체).
 * - 실패한 update·rollback은 config를 원본 byte로 되돌리고(compensated) Version State를 바꾸지 않는다.
 * - Health를 승인으로 생략한 결과는 health.status "skipped"이며 healthy로 표현하지 않는다.
 * - 절대 경로·token·URL credential이 들어가면 schema가 거부한다. env는 이름만 있다.
 */

export const LIFECYCLE_RESULT_SCHEMA_VERSION = 1;
export const LIFECYCLE_RESULT_STATUSES = [
  "updated",
  "rolled-back",
  "health-checked",
  "up-to-date",
  "resolution-failed",
  "approval-required",
  "stale",
  "preparation-failed",
  "config-failed",
  "health-failed",
  "state-commit-failed",
  "rollback-failed",
] as const;
export type LifecycleResultStatus = (typeof LIFECYCLE_RESULT_STATUSES)[number];

const text = z.string().min(1).max(400);
const strings = (value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
};

export const lifecycleResultSchema = z
  .strictObject({
    schemaVersion: z.literal(LIFECYCLE_RESULT_SCHEMA_VERSION),
    operation: z.enum(LIFECYCLE_OPERATIONS),
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    toolId: text,
    backend: z.enum(INSTALL_BACKENDS),
    status: z.enum(LIFECYCLE_RESULT_STATUSES),
    code: z.string().max(60).optional(),
    changed: z.array(z.enum(LIFECYCLE_PLAN_CHANGE_KINDS)).optional(),
    artifact: z.strictObject({ from: text.nullable(), to: text.nullable() }),
    targets: z.array(
      z.strictObject({
        client: z.enum(INSTALL_CLIENTS),
        scope: z.enum(CONFIG_SCOPES),
        file: text,
        serverName: text,
        configApplied: z.boolean(),
        configRestored: z.boolean(),
        revisionBefore: z.number().int().min(1).nullable(),
        revisionAfter: z.number().int().min(1).nullable(),
      }),
    ),
    steps: z.array(resultStepSchema),
    health: z
      .strictObject({
        status: z.enum(HEALTH_STATUSES),
        reason: z.string().max(60).nullable(),
        toolCount: z.number().int().min(0).nullable(),
        environmentUnverified: z.boolean(),
        checkedAt: z.iso.datetime().nullable(),
      })
      .nullable(),
    /** 실패 후 config를 원본 byte로 되돌렸는지(보조 표시). */
    compensated: z.boolean(),
    stateCommitted: z.boolean(),
    retryable: z.boolean(),
    requiredEnv: z.array(z.strictObject({ name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), status: z.literal("unchecked") })),
    warnings: z.array(z.strictObject({ code: text, message: text })),
    nextActions: z.array(text),
  })
  .superRefine((result, ctx) => {
    for (const found of strings(result)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "LifecycleResult에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type LifecycleResultV1 = z.output<typeof lifecycleResultSchema>;

export function serializeLifecycleResult(result: LifecycleResultV1): string {
  return JSON.stringify(canonicalize(lifecycleResultSchema.parse(result)), null, 2) + "\n";
}

