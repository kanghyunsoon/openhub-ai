import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_REQUIREMENTS,
  FLOATING_ARTIFACT_NOTICE,
  assembleInstallPlan,
  canonicalize,
  entryPlanDigest,
  installPlanDigest,
  installPlanSchema,
  installationStatusFromReport,
  registryDigestExcluding,
  serializeInstallPlan,
  serverEntry,
  type InstallPlanV1,
  type RegistryEntry,
} from "../../src/index";
import { fixtureProfile, item, seedEntries, shuffleProfile, shuffled, tool } from "../recommendation/helpers";
import { assemblyInput, clientProfile, entryOf, launchSpec, planFor, reportFor, target } from "./helpers";

const seed = await seedEntries();
const postgresProfile = () => clientProfile({ databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })] });
const uvxPostgres = {
  backend: { adapter: "uvx" as const, selection: "preferred" as const, skipped: [], probe: { name: "uvx", available: true, version: "0.5.0", status: "ok" as const } },
  artifact: { kind: "python-package" as const, spec: "postgres-mcp", pinned: false, preparation: "launch-on-demand" as const },
  launch: launchSpec("uvx", ["postgres-mcp", "--access-mode=restricted"]),
};
const clone = (plan: InstallPlanV1): InstallPlanV1 => structuredClone(plan);
const valid = (plan: unknown) => installPlanSchema.safeParse(plan).success;

describe("REQ-034 InstallPlan v1 계약과 canonical digest", () => {
  it("AC-027-01 installPlanSchema는 strict이고 schemaVersion 1만 받으며 모르는 key를 거부한다", () => {
    const { plan } = planFor(seed, reportFor(clientProfile(), seed), "memory-mcp");
    expect(installPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.schemaVersion).toBe(1);
    expect(valid({ ...plan, schemaVersion: 2 })).toBe(false);
    expect(valid({ ...plan, autoApprove: true })).toBe(false);
    expect(valid({ ...plan, source: { ...plan.source, openScore: 99 } })).toBe(false);
    expect(valid({ ...plan, targets: plan.targets.map((t) => ({ ...t, overwrite: true })) })).toBe(false);
  });

  it("AC-027-02 같은 입력으로 5번 직렬화하면 byte와 planDigest가 같고 digest는 canonical JSON의 sha256이다", () => {
    const report = reportFor(postgresProfile(), seed);
    const runs = Array.from({ length: 5 }, () => planFor(seed, report, "postgres-mcp", uvxPostgres));
    const bytes = runs.map((r) => serializeInstallPlan(r.plan));
    expect(new Set(bytes).size).toBe(1);
    expect(new Set(runs.map((r) => r.planDigest)).size).toBe(1);
    const expected = "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(runs[0]!.plan))).digest("hex");
    expect(runs[0]!.planDigest).toBe(expected);
    expect(installPlanDigest(runs[0]!.plan)).toBe(expected);
    expect(runs[0]!.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("AC-027-03 RecommendationReport 배열 순서·Registry 순서·target 순서를 섞어도 Plan byte가 같다", () => {
    const p = postgresProfile();
    const report = reportFor(p, seed);
    const fromShuffledInputs = reportFor(shuffleProfile(p), shuffled(seed) as RegistryEntry[]);
    const reordered = {
      ...report,
      recommendations: shuffled(report.recommendations),
      installedTools: shuffled(report.installedTools),
      assessment: { ...report.assessment, coverage: shuffled(report.assessment.coverage), inspectedScopes: shuffled(report.assessment.inspectedScopes) },
    };
    const targets = [target("claude-code"), target("cursor"), target("codex")];
    const base = planFor(seed, report, "postgres-mcp", { ...uvxPostgres, targets });
    for (const variant of [fromShuffledInputs, reordered]) {
      const other = planFor(shuffled(seed), variant, "postgres-mcp", { ...uvxPostgres, targets: shuffled(targets) });
      expect(serializeInstallPlan(other.plan)).toBe(serializeInstallPlan(base.plan));
      expect(other.planDigest).toBe(base.planDigest);
    }
    expect(registryDigestExcluding(shuffled(seed), "postgres-mcp")).toBe(registryDigestExcluding(seed, "postgres-mcp"));
    expect(base.plan.targets.map((t) => t.client)).toEqual(["claude-code", "codex", "cursor"]);
  });

  it("AC-027-04 Plan에는 시각 필드가 없고 approvedAt은 Plan에 들어갈 수 없어 digest에 영향을 주지 않는다", () => {
    const { plan, planDigest } = planFor(seed, reportFor(clientProfile(), seed), "memory-mcp");
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(plan);
    expect(keys.filter((k) => /(?:At|time|date|timestamp)$/iu.test(k))).toEqual([]);
    expect(serializeInstallPlan(plan)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/u);
    expect(valid({ ...plan, approvedAt: "2026-10-07T00:00:00.000Z" })).toBe(false);
    const approval = { planDigest, approvedAt: "2026-10-07T00:00:00.000Z" };
    expect(installPlanDigest(plan)).toBe(approval.planDigest);
  });

  it("AC-027-05 실행 단계는 run executable+args[]만 허용하고 M1 run-command 문자열 단계는 거부한다", () => {
    const report = reportFor(clientProfile(), seed);
    const pull = { id: "pull-image", kind: "run" as const, executable: "docker" as const, args: ["pull", "ghcr.io/github/github-mcp-server"], cwd: "isolated" as const, network: true, timeoutMs: 600000 };
    const { plan } = planFor(seed, report, "github-mcp-server", {
      backend: { adapter: "docker", selection: "preferred", skipped: [], probe: { name: "docker", available: true, version: "27.0.0", status: "ok" } },
      artifact: { kind: "container-image", spec: "ghcr.io/github/github-mcp-server", pinned: false, preparation: "pull" },
      launch: launchSpec("docker", ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]),
      preparation: [pull],
    });
    expect(plan.steps[0]).toEqual(pull);
    const withStep = (step: unknown) => ({ ...plan, steps: [step, ...plan.steps.slice(1)] });
    expect(valid(withStep({ id: "x", kind: "run-command", command: "npx -y @upstash/context7-mcp" }))).toBe(false);
    expect(valid(withStep({ ...pull, args: "pull ghcr.io/github/github-mcp-server" }))).toBe(false);
    expect(valid(withStep({ ...pull, executable: "bash" }))).toBe(false);
    expect(valid(withStep({ ...pull, shell: true }))).toBe(false);
  });

  it("AC-027-06 env description의 secret은 Plan에 들어가지 않고 requiredEnv에는 이름만 있다", () => {
    const pg = entryOf(seed, "postgres-mcp");
    const tainted: RegistryEntry = {
      ...pg,
      manifest: {
        ...pg.manifest,
        env: [
          { name: "DATABASE_URI", required: true, description: "postgresql://user:secret-password@db/app" },
          { name: "PG_DEBUG", required: false, description: "process.env.DATABASE_URI=postgresql://u:p@h/db" },
        ],
      },
    };
    const entries = seed.map((e) => (e.manifest.name === "postgres-mcp" ? tainted : e));
    const { plan } = planFor(entries, reportFor(postgresProfile(), entries), "postgres-mcp", uvxPostgres);
    const out = serializeInstallPlan(plan);
    for (const leak of ["secret-password", "u:p@", "postgresql://", "process.env"]) expect(out).not.toContain(leak);
    expect(plan.requiredEnv).toEqual([
      { name: "DATABASE_URI", required: true, status: "unchecked" },
      { name: "PG_DEBUG", required: false, status: "unchecked" },
    ]);
    expect(plan.launch?.envNames).toEqual(["DATABASE_URI"]);
  });

  it("AC-027-06 env가 없는 Tool도 유효한 Plan이 된다", () => {
    const { plan } = planFor(seed, reportFor(clientProfile(), seed), "memory-mcp");
    expect(plan.requiredEnv).toEqual([]);
    expect(plan.status).toBe("installable");
    expect(valid(plan)).toBe(true);
  });

  it("AC-027-07 절대 경로·token·URL credential은 schema가 거부하고 config 대상은 논리 경로만 쓴다", () => {
    const report = reportFor(clientProfile(), seed);
    const { plan } = planFor(seed, report, "memory-mcp", { targets: [target("claude-code"), target("cursor", "user"), target("codex", "user")] });
    expect(plan.targets.map((t) => t.file)).toEqual([".mcp.json", "~/.codex/config.toml", "~/.cursor/mcp.json"]);
    const mutate = (fn: (p: InstallPlanV1) => void) => {
      const p = clone(plan);
      fn(p);
      return valid(p);
    };
    expect(mutate((p) => (p.targets[0]!.file = "C:\\Users\\someone\\.mcp.json"))).toBe(false);
    expect(mutate((p) => (p.targets[0]!.file = "/home/someone/.cursor/mcp.json"))).toBe(false);
    expect(mutate((p) => p.launch!.args.push("ghp_" + "a".repeat(36)))).toBe(false);
    expect(mutate((p) => p.warnings.push({ code: "x", message: "https://user:pw@example.com/repo" }))).toBe(false);
    expect(() => planFor(seed, report, "memory-mcp", { targets: [target("claude-code", "project", { file: "C:\\work\\app\\.mcp.json" })] })).toThrow();
  });

  it("AC-027-08 설치 상태에 따라 base / installation-unknown / unidentified-present가 정확히 정해진다", () => {
    const pinned = { artifact: { kind: "npm-package" as const, spec: "memory-mcp@1.2.3", pinned: true, preparation: "launch-on-demand" as const } };
    const req = (p: ReturnType<typeof clientProfile>) => planFor(seed, reportFor(p, seed), "memory-mcp", pinned).plan.approvalRequirements;
    expect(req(clientProfile())).toEqual(["base"]);
    expect(req(clientProfile({ detectors: { "ai-environment": "partial" } }))).toEqual(["base", "installation-unknown"]);
    expect(req(clientProfile({ aiTools: [tool("my-memory")] }))).toEqual(["base", "unidentified-present"]);
    expect(APPROVAL_REQUIREMENTS[0]).toBe("base");
  });

  it("AC-027-08 user scope·fallback·floating·Claude Code required env 조건이 각 추가 승인을 만든다", () => {
    const report = reportFor(postgresProfile(), seed);
    const base = { ...uvxPostgres, artifact: { ...uvxPostgres.artifact, pinned: true } };
    const req = (over: Parameters<typeof planFor>[3]) => planFor(seed, report, "postgres-mcp", { ...base, ...over }).plan.approvalRequirements;
    expect(req({ targets: [target("cursor")] })).toEqual(["base"]);
    expect(req({ targets: [target("cursor", "user")] })).toEqual(["base", "user-scope-config"]);
    expect(req({ targets: [target("cursor")], backend: { ...base.backend, selection: "fallback" } })).toEqual(["base", "fallback-backend"]);
    expect(req({ targets: [target("cursor")], artifact: uvxPostgres.artifact })).toEqual(["base", "floating-artifact"]);
    expect(req({ targets: [target("claude-code")] })).toEqual(["base", "client-env-parse-risk"]);
    const floatingPlan = planFor(seed, report, "postgres-mcp", { ...uvxPostgres, targets: [target("claude-code")] }).plan;
    expect(floatingPlan.warnings.find((w) => w.code === "floating-artifact")?.message).toBe(FLOATING_ARTIFACT_NOTICE);
    // env 없는 Tool은 Claude Code 대상이어도 client-env-parse-risk가 없다. Claude Code user(manual)는 쓰지 않으므로 user-scope-config도 없다.
    const memory = planFor(seed, reportFor(clientProfile(), seed), "memory-mcp", { artifact: base.artifact, targets: [target("claude-code"), target("claude-code", "user")] }).plan;
    expect(memory.approvalRequirements).toEqual(["base"]);
    expect(memory.warnings.map((w) => w.code)).toContain("manual-setup-required");
  });

  it("AC-027-09 (v0.2.0 대상별 판정) 고른 대상에 같은 항목이 있으면 already-installed이고 steps가 비어 실행할 것이 없다. 다른 대상은 추가할 수 있다", async () => {
    const p = await fixtureProfile("claude-mcp");
    const report = reportFor(p, seed);
    expect(installationStatusFromReport(report, "playwright-mcp")).toBe("installed");
    // 도구가 Claude Code 프로젝트에 있어도 Cursor 프로젝트(대상)에는 없다 → 추가할 수 있다(도구 전체 설치 여부로 막지 않는다).
    const other = planFor(seed, report, "playwright-mcp", { targets: [target("cursor")] }).plan;
    expect(other.status).toBe("installable");
    expect(other.steps.filter((s) => s.kind === "config-patch").map((s) => s.kind === "config-patch" && s.client)).toEqual(["cursor"]);
    // 같은 대상에 같은 항목(Plan 형태 digest 일치)이 있으면 already-installed다.
    const launch = assemblyInput(seed, report, "playwright-mcp").launch!;
    const same = { exists: true, fileDigest: "sha256:" + "a".repeat(64), keyAbsent: false, entryDigest: entryPlanDigest(serverEntry("cursor", launch, [])) };
    const { plan } = planFor(seed, report, "playwright-mcp", { targets: [target("cursor", "project", { precondition: same })] });
    expect(plan.status).toBe("already-installed");
    expect(plan.steps).toEqual([]);
    expect(plan.launch).toBeNull();
    expect(plan.artifact).toBeNull();
    expect(plan.sideEffects).toEqual([]);
    expect(plan.approvalRequirements).toEqual(["base"]);
  });

  it("AC-027-10 requiredEnv는 모두 unchecked이고 Plan 생성 중 process.env 접근이 0회다", () => {
    const report = reportFor(postgresProfile(), seed);
    const input = assemblyInput(seed, report, "postgres-mcp", { ...uvxPostgres, targets: [target("claude-code"), target("cursor"), target("codex")] });
    const original = process.env;
    const touched: string[] = [];
    const record = (kind: string) => (target: NodeJS.ProcessEnv, key: string | symbol) => (touched.push(kind + ":" + String(key)), Reflect.get(target, key));
    process.env = new Proxy(original, {
      get: record("get"),
      has: (t, k) => (touched.push("has:" + String(k)), Reflect.has(t, k)),
      ownKeys: (t) => (touched.push("ownKeys"), Reflect.ownKeys(t)),
      getOwnPropertyDescriptor: (t, k) => (touched.push("desc:" + String(k)), Reflect.getOwnPropertyDescriptor(t, k)),
    });
    let result;
    try {
      result = assembleInstallPlan(input);
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
    expect(result.plan.requiredEnv.every((e) => e.status === "unchecked")).toBe(true);
    expect(result.plan.requiredEnv.map((e) => e.name)).toEqual(["DATABASE_URI"]);
    const codex = result.plan.steps.find((s) => s.kind === "config-patch" && s.client === "codex");
    expect(codex?.kind === "config-patch" && codex.value.env_vars).toEqual(["DATABASE_URI"]);
  });
});
