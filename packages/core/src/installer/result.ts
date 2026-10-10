import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { CONFIG_SCOPES, INSTALL_BACKENDS, INSTALL_CLIENTS, canonicalize } from "./plan";
import { PLAN_CHANGE_KINDS } from "./stale";

/**
 * InstallResult v1(TASK-033, §4). 메모리 객체다. 영속 저장·audit 파일은 만들지 않는다(Version State는 M5).
 * - 확인 상태 이름은 Prepared / Configured / Detected다. "Installed"를 상태 이름으로 쓰지 않는다.
 * - 실행하지 않은 결과(no-op·stale·rejected·approval-required)는 verification이 null이다.
 * - 절대 경로·token·URL credential이 들어가면 schema가 거부한다.
 */

export const INSTALL_RESULT_SCHEMA_VERSION = 1;
export const INSTALL_RESULT_STATUSES = ["succeeded", "no-op", "failed", "partial-compensated", "stale", "rejected", "approval-required"] as const;
export type InstallResultStatus = (typeof INSTALL_RESULT_STATUSES)[number];
/** cached: npx Prepare가 정확한 버전을 npx cache에 받아 두었다(v0.2.0). */
export const PREPARED_STATES = ["launch-on-demand", "pulled", "cached", "failed"] as const;
export type PreparedState = (typeof PREPARED_STATES)[number];

/** 준비 단계가 모두 성공했을 때의 Prepared 상태. */
export function preparedStateOf(preparation: "launch-on-demand" | "pull" | "npm-cache" | undefined): Exclude<PreparedState, "failed"> {
  return preparation === "pull" ? "pulled" : preparation === "npm-cache" ? "cached" : "launch-on-demand";
}

const text = z.string().min(1).max(400);

export const resultStepSchema = z.strictObject({
  id: text,
  status: z.enum(["done", "failed", "skipped", "compensated"]),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(20).nullable().optional(),
  code: z.string().max(60).optional(),
  excerpt: z.string().max(1100).optional(),
});

export const verificationSchema = z.strictObject({
  prepared: z.enum(PREPARED_STATES),
  configured: z.boolean(),
  detected: z.union([z.boolean(), z.literal("skipped")]),
});
export type InstallVerification = z.output<typeof verificationSchema>;

const strings = (value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
};

export const installResultSchema = z
  .strictObject({
    schemaVersion: z.literal(INSTALL_RESULT_SCHEMA_VERSION),
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    toolId: text,
    backend: z.enum(INSTALL_BACKENDS).nullable(),
    status: z.enum(INSTALL_RESULT_STATUSES),
    code: z.string().max(60).optional(),
    changed: z.array(z.enum(PLAN_CHANGE_KINDS)).optional(),
    steps: z.array(resultStepSchema),
    failedStep: text.optional(),
    retryable: z.boolean(),
    configChanges: z.array(
      z.strictObject({ client: z.enum(INSTALL_CLIENTS), scope: z.enum(CONFIG_SCOPES), file: text, serverName: text, applied: z.boolean(), restored: z.boolean() }),
    ),
    /** OpenHub 관리 tool config 변경(v0.2.0, tool config Tool만). 논리 ID만 남긴다. */
    toolConfigChanges: z
      .array(z.strictObject({ fileId: text, scope: z.enum(CONFIG_SCOPES), action: z.enum(["create", "replace", "keep"]), applied: z.boolean(), restored: z.boolean() }))
      .optional(),
    verification: verificationSchema.nullable(),
    requiredEnv: z.array(z.strictObject({ name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), status: z.literal("unchecked") })),
    warnings: z.array(z.strictObject({ code: text, message: text })),
    nextActions: z.array(text),
  })
  .superRefine((result, ctx) => {
    for (const found of strings(result)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "InstallResult에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type InstallResultV1 = z.output<typeof installResultSchema>;

export function serializeInstallResult(result: InstallResultV1): string {
  return JSON.stringify(canonicalize(installResultSchema.parse(result)), null, 2) + "\n";
}
