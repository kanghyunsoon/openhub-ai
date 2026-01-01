import { z } from "zod";

/**
 * Manifest v1 optional `recommendation` 블록(D-008). schemaVersion은 1로 유지한다.
 *
 * - appliesTo.stacks: 이 Tool이 특정 기술 전용이면 M2 tech ID 목록(생략 = 범용)
 * - identity.mcpServerNames: curated canonical MCP alias. normalized lowercase로만 관리하며
 *   Registry 전체에서 대소문자 무시 기준으로 유일해야 한다(registry 검증). Resolver는 exact-match만 쓴다.
 *   사용자가 임의로 정한 config key 전체를 포괄한다고 가정하지 않는다.
 * - source: GitHub 지표가 이 Tool 전용 저장소(dedicated)인지, 여러 Tool이 든 공유 저장소(shared-repo)인지
 */

export const SOURCE_TYPES = ["dedicated", "shared-repo"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** canonical alias 형식: normalized lowercase. `GitHub`·`GITHUB`은 canonical alias가 될 수 없다. */
export const CANONICAL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

const stackId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "stack은 M2 tech ID(kebab-case)여야 합니다")
  .max(64);

const canonicalAlias = z
  .string()
  .max(100)
  .regex(CANONICAL_ALIAS_PATTERN, "canonical alias는 normalized lowercase 문자열(^[a-z0-9][a-z0-9._-]*$)이어야 합니다");

/** 저장소 기준 POSIX 상대 경로(선행 /·백슬래시·드라이브 문자·.·.. 금지). */
export function isRepoRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const source = z
  .strictObject({
    type: z.enum(SOURCE_TYPES),
    path: z.string().min(1).max(200).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.type === "shared-repo" && s.path === undefined) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "shared-repo는 공유 저장소 안의 Tool 경로(path)가 필요합니다" });
    }
    if (s.path !== undefined && !isRepoRelativePath(s.path)) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "path는 저장소 기준 상대 경로여야 합니다(절대 경로·.. 금지)" });
    }
  });

export const recommendationMetadataSchema = z.strictObject({
  appliesTo: z.strictObject({ stacks: z.array(stackId).min(1) }).optional(),
  identity: z.strictObject({ mcpServerNames: z.array(canonicalAlias).min(1) }).optional(),
  source: source.optional(),
});

export type RecommendationMetadata = z.output<typeof recommendationMetadataSchema>;
