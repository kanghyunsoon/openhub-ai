import { z } from "zod";
import { recommendationMetadataSchema } from "./recommendation";

/**
 * OpenHub Manifest v1.
 *
 * 설치 엔진에 종속되지 않는 Tool 기술 형식이다(CON-003). 설치 기술 고유 정보는 `install` 아래에만 둔다.
 * 최상위는 strict라서 오타나 Adapter 전용 필드가 밖으로 새면 검증이 실패한다.
 */

/** Installer Adapter ID. 실제 Adapter 구현은 installer 모듈이 담당하고, Manifest는 이름만 안다. */
export const ADAPTER_IDS = ["pinokio", "npm", "npx", "uv", "uvx", "pip", "docker", "docker-compose", "binary"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

/** MVP 카테고리(기획서 §29)와 Registry 디렉터리 이름(기획서 §24). */
export const CATEGORIES = [
  "mcp",
  "skill",
  "coding-agent",
  "testing",
  "browser",
  "context",
  "memory",
  "security",
  "automation",
  "database",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** 설정을 연결할 수 있는 Agent Client(기획서 §18). */
export const AGENT_TARGETS = ["claude-code", "codex", "cursor", "gemini-cli", "vscode"] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];

export const VERIFICATION_LEVELS = ["draft", "community", "verified"] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

const kebab = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "소문자·숫자·하이픈(kebab-case)만 쓸 수 있습니다")
  .max(64);

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "환경변수 이름은 대문자·숫자·밑줄만 쓸 수 있습니다");

/** `env: [OPENAI_API_KEY]`(기획서 §11)와 객체 형식을 모두 받아 객체로 정규화한다. */
const envEntry = z
  .union([
    envName,
    z.strictObject({
      name: envName,
      required: z.boolean().default(true),
      description: z.string().optional(),
    }),
  ])
  .transform((e) => (typeof e === "string" ? { name: e, required: true } : e));

const installStep = z.strictObject({
  adapter: z.enum(ADAPTER_IDS),
  command: z.string().min(1).optional(),
  package: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const install = z.strictObject({
  preferredAdapter: z.enum(ADAPTER_IDS),
  /** preferredAdapter 전용 설정. 형식은 각 Adapter가 검증한다. */
  options: z.record(z.string(), z.unknown()).optional(),
  fallback: z.array(installStep).default([]),
});

const healthCheck = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("process") }),
  z.strictObject({ type: z.literal("command"), command: z.string().min(1), expectExitCode: z.number().int().default(0) }),
  z.strictObject({ type: z.literal("http"), url: z.url(), expectStatus: z.number().int().default(200) }),
  z.strictObject({ type: z.literal("mcp-handshake") }),
]);

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  name: kebab,
  displayName: z.string().min(1).optional(),
  summary: z.string().min(1).max(200).optional(),
  repository: z.strictObject({
    github: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "owner/repo 형식이어야 합니다"),
  }),
  category: z.array(z.enum(CATEGORIES)).min(1),
  capabilities: z.array(kebab).default([]),
  targets: z.array(z.enum(AGENT_TARGETS)).min(1),
  platform: z.strictObject({ windows: z.boolean(), macos: z.boolean(), linux: z.boolean() }),
  requirements: z
    .strictObject({
      node: z.string().min(1).optional(),
      python: z.string().min(1).optional(),
      docker: z.boolean().optional(),
      gpu: z.boolean().optional(),
    })
    .default({}),
  env: z.array(envEntry).default([]),
  install,
  healthCheck,
  update: z.strictObject({ source: z.enum(["github-release", "npm", "pypi", "docker-tag", "git"]) }),
  rollback: z.strictObject({ supported: z.boolean() }),
  /** AI가 만든 Draft는 Router가 실행 대상으로 고르지 않는다(CON-005). */
  verification: z.enum(VERIFICATION_LEVELS).default("draft"),
  /** 추천 메타데이터(D-008). 없어도 v1 Manifest로 유효하다. */
  recommendation: recommendationMetadataSchema.optional(),
  /**
   * OpenHub 관리 tool config(v0.2.0, 선택). 허용 목록의 Tool만 쓸 수 있고 내용은 검토된 고정 TOML이다
   * (tool-config/index.ts, docs/specs/kubernetes-tool-restriction.md). 없어도 v1 Manifest로 유효하다.
   */
  toolConfig: z.strictObject({ format: z.literal("toml"), content: z.string().min(1) }).optional(),
});

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestInput = z.input<typeof manifestSchema>;
export type InstallStep = z.output<typeof installStep>;
export type HealthCheck = z.output<typeof healthCheck>;
