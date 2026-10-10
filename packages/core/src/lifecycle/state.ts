import { createHash } from "node:crypto";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { CONFIG_SCOPES, INSTALL_BACKENDS, INSTALL_CLIENTS, canonicalize } from "../installer/plan";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";

/**
 * Version State v1(TASK-037, D-017). OpenHub가 설치·관리하는 도구의 machine-local 상태.
 * - 저장소는 ~/.openhub/state/lifecycle.json 하나(project·user scope 공용). project는 root 원문 대신 projectKey로 식별한다.
 * - strict schema, 결정적 직렬화(키 정렬, entries는 EntryKey 오름차순).
 * - project·home 절대 경로, PATH, env 값, token, credential URL, command line secret을 저장하지 않는다(schema가 거부).
 */

export const LIFECYCLE_STATE_SCHEMA_VERSION = 1;
export const LIFECYCLE_STATE_KIND = "openhub-lifecycle-state";
export const HEALTH_STATUSES = ["healthy", "unhealthy", "timeout", "launch-failed", "handshake-failed", "unsupported", "skipped"] as const;
export type LifecycleHealthStatus = (typeof HEALTH_STATUSES)[number];
export const ARTIFACT_KINDS = ["npm-package", "python-package", "container-image"] as const;
export const ARTIFACT_SOURCES = ["npm-registry", "pypi", "docker-registry"] as const;
/** node: v0.2.0 tool config Tool의 Windows 직접 실행(첫 인자 {npxCli}). 실제 절대 경로는 Client 설정에만 있다. */
export const CLIENT_COMMANDS = ["npx", "uvx", "docker", "cmd", "node"] as const;

const text = z.string().min(1).max(300);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const PROJECT_KEY_PATTERN = /^[0-9a-f]{16}$/u;

export const artifactIdentitySchema = z.strictObject({
  kind: z.enum(ARTIFACT_KINDS),
  /** 실제로 실행될 정확한 spec: @scope/pkg@1.2.3, name==1.2.3, image@sha256:… */
  spec: text,
  version: z.string().min(1).max(100).nullable(),
  digest: sha256.nullable(),
  /** npm dist.integrity(참고 정보, npx가 강제하지 않는다). */
  integrity: z.string().min(1).max(200).nullable(),
  source: z.enum(ARTIFACT_SOURCES),
});
export type ArtifactIdentity = z.output<typeof artifactIdentitySchema>;

export const toolStateCoreSchema = z.strictObject({
  toolId: text,
  backend: z.enum(INSTALL_BACKENDS),
  revision: z.number().int().min(1),
  target: z.strictObject({
    client: z.enum(INSTALL_CLIENTS),
    scope: z.enum(CONFIG_SCOPES),
    /** 논리 경로(.mcp.json, ~/.cursor/mcp.json) */
    file: text,
    serverName: text,
    projectName: text.nullable(),
    projectKey: z.string().regex(PROJECT_KEY_PATTERN).nullable(),
  }),
  artifact: z.strictObject({ requested: text, resolved: artifactIdentitySchema.nullable() }),
  launch: z.strictObject({
    platform: z.enum(["windows", "macos", "linux"]),
    clientSpec: z.strictObject({ command: z.enum(CLIENT_COMMANDS), args: z.array(text) }),
  }),
  config: z.strictObject({ entryDigest: sha256, tomlBlockDigest: sha256.nullable() }),
  /** OpenHub 관리 tool config(v0.2.0, tool config Tool만). 논리 ID·scope·내용 digest만 남긴다(경로 없음). */
  toolConfig: z.strictObject({ fileId: text, scope: z.enum(CONFIG_SCOPES), digest: sha256 }).optional(),
  appliedPlanDigest: sha256,
  committedAt: z.iso.datetime(),
});
export type ToolStateCore = z.output<typeof toolStateCoreSchema>;

export const lastHealthSchema = z.strictObject({
  status: z.enum(HEALTH_STATUSES),
  environmentUnverified: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
});
export type LastHealth = z.output<typeof lastHealthSchema>;

export const toolStateSchema = toolStateCoreSchema.extend({
  lastHealth: lastHealthSchema.nullable(),
  /** rollback snapshot 1세대 */
  previous: toolStateCoreSchema.nullable(),
});
export type ToolState = z.output<typeof toolStateSchema>;

/** EntryKey: user:<client>:<serverName> | project:<projectKey>:<client>:<serverName> */
export function entryKeyOf(target: ToolStateCore["target"]): string {
  return target.scope === "user" ? "user:" + target.client + ":" + target.serverName : "project:" + String(target.projectKey) + ":" + target.client + ":" + target.serverName;
}

/** projectKey = sha256(realpath(projectRoot)) 앞 16 hex. 입력은 realpath 결과이며 결과에 경로를 남기지 않는다. */
export function projectKeyFromRealpath(realProjectRoot: string): string {
  const normalized = process.platform === "win32" ? realProjectRoot.toLowerCase() : realProjectRoot;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const strings = (value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
};

export const lifecycleStateFileSchema = z
  .strictObject({
    schemaVersion: z.literal(LIFECYCLE_STATE_SCHEMA_VERSION),
    kind: z.literal(LIFECYCLE_STATE_KIND),
    entries: z.record(z.string().min(1).max(400), toolStateSchema),
  })
  .superRefine((file, ctx) => {
    for (const [key, entry] of Object.entries(file.entries)) {
      const t = entry.target;
      if ((t.scope === "project") !== (t.projectKey !== null)) ctx.addIssue({ code: "custom", path: ["entries", key, "target"], message: "project scope만 projectKey를 가진다" });
      if (entryKeyOf(t) !== key) ctx.addIssue({ code: "custom", path: ["entries", key], message: "EntryKey가 target과 다르다" });
      for (const snap of [entry.previous].filter((x) => x !== null)) {
        if (entryKeyOf(snap.target) !== key) ctx.addIssue({ code: "custom", path: ["entries", key, "previous"], message: "snapshot target이 entry와 다르다" });
      }
    }
    for (const found of strings(file)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "Version State에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type LifecycleStateFile = z.output<typeof lifecycleStateFileSchema>;

export function emptyLifecycleState(): LifecycleStateFile {
  return { schemaVersion: LIFECYCLE_STATE_SCHEMA_VERSION, kind: LIFECYCLE_STATE_KIND, entries: {} };
}

/** 결정적 직렬화: 검증 → 키 정렬(entries 포함) → 2칸 들여쓰기 → 끝 개행. */
export function serializeLifecycleState(state: LifecycleStateFile): string {
  return JSON.stringify(canonicalize(lifecycleStateFileSchema.parse(state)), null, 2) + "\n";
}
