import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  InstallationRouter,
  formatPlanPreview,
  parseManifest,
  verifyApprovedPlan,
  type AdapterId,
  type Approval,
  type InstallContext,
  type InstallPlan,
  type InstallTarget,
  type InstallerAdapter,
  type Manifest,
  type Operation,
} from "../src/index";

const fixture = await readFile(new URL("./fixtures/plan-section-10.yaml", import.meta.url), "utf8");
function manifest(overrides: Record<string, unknown> = {}): Manifest {
  const r = parseManifest(fixture);
  if (!r.ok) throw new Error("fixture invalid");
  return { ...r.manifest, verification: "community", ...overrides } as Manifest;
}

/** 실행하지 않는 테스트용 Adapter. 호출 기록만 남긴다. */
class FakeAdapter implements InstallerAdapter {
  readonly calls: string[] = [];
  constructor(readonly id: AdapterId, private readonly handles = true) {}
  canHandle(): boolean {
    return this.handles;
  }
  async validate() {
    return { ok: true, problems: [] };
  }
  async plan(target: InstallTarget, operation: Operation): Promise<InstallPlan> {
    return {
      operation,
      tool: target.manifest.name,
      adapter: this.id,
      actions: [
        { kind: "run-command", command: target.step.command ?? "npx @playwright/mcp@latest" },
        { kind: "network", host: "registry.npmjs.org", purpose: "패키지 다운로드" },
        { kind: "download", what: "Chromium", approxBytes: 150 * 1024 * 1024 },
        { kind: "create-file", path: "~/.cache/ms-playwright" },
        { kind: "open-port", port: 8931 },
        { kind: "config-change", target: ".mcp.json", description: "playwright 서버 추가" },
      ],
      warnings: ["브라우저 바이너리를 내려받습니다"],
    };
  }
  async install(target: InstallTarget, approval: Approval, ctx: InstallContext) {
    void target;
    void approval;
    this.calls.push(`install:${ctx.platform}`);
    return { ok: true };
  }
  async update() {
    return { ok: true };
  }
  async healthCheck() {
    return { healthy: true };
  }
  async uninstall() {}
}

const ctx = (available: AdapterId[], platform: InstallContext["platform"] = "windows"): InstallContext => ({
  platform,
  availableAdapters: new Set(available),
});

describe("REQ-004 Installer Adapter Interface", () => {
  it("AC-005-01 Adapter 계약은 id, canHandle, validate, plan, install, update, healthCheck, uninstall을 가진다", () => {
    const a: InstallerAdapter = new FakeAdapter("npx");
    for (const m of ["canHandle", "validate", "plan", "install", "update", "healthCheck", "uninstall"] as const) {
      expect(typeof a[m]).toBe("function");
    }
    expect(a.id).toBe("npx");
  });

  it("AC-005-02 사용 가능한 preferredAdapter를 먼저 고른다", () => {
    const router = new InstallationRouter([new FakeAdapter("pinokio"), new FakeAdapter("npx")]);
    const r = router.select(manifest(), ctx(["pinokio", "npx"]));
    expect(r.ok && [r.adapter.id, r.source]).toEqual(["pinokio", "preferred"]);
  });

  it("AC-005-02 preferred를 쓸 수 없으면 fallback 순서대로 고르고 이유를 남긴다", () => {
    const router = new InstallationRouter([new FakeAdapter("pinokio"), new FakeAdapter("npx")]);
    const r = router.select(manifest(), ctx(["npx"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.adapter.id, r.source, r.target.step.command]).toEqual(["npx", "fallback", "npx @playwright/mcp@latest"]);
    expect(r.reasons[0]).toMatch(/선호 Adapter pinokio: 이 PC에서 사용할 수 없습니다/);
    expect(r.reasons.at(-1)).toMatch(/대체 Adapter npx을\(를\) 선택/);
  });

  it("AC-005-02 미구현·canHandle 거부·후보 소진을 구분해 설명한다", () => {
    const router = new InstallationRouter([new FakeAdapter("npx", false)]);
    const r = router.select(manifest(), ctx(["pinokio", "npx"]));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      expect.stringMatching(/pinokio: OpenHub에 아직 구현되지 않았습니다/),
      expect.stringMatching(/npx: 이 Manifest를 처리할 수 없다고/),
      expect.stringMatching(/사용할 수 있는 설치 방법이 없습니다/),
    ]);
  });

  it("draft Manifest와 지원하지 않는 플랫폼은 선택하지 않는다 (CON-005)", () => {
    const router = new InstallationRouter([new FakeAdapter("pinokio")]);
    expect(router.select(manifest({ verification: "draft" }), ctx(["pinokio"])).ok).toBe(false);
    const noWin = manifest({ platform: { windows: false, macos: true, linux: true } });
    expect(router.select(noWin, ctx(["pinokio"])).ok).toBe(false);
  });

  it("AC-005-03 plan은 명령·네트워크·다운로드·생성 파일·포트·설정 변경을 표현하고 미리보기로 보여준다", async () => {
    const a = new FakeAdapter("npx");
    const plan = await a.plan({ manifest: manifest(), step: { adapter: "npx" } }, "install");
    const preview = formatPlanPreview(plan).join("\n");
    expect(preview).toContain("playwright-mcp 설치 (npx)는 다음 작업을 수행합니다");
    for (const s of ["명령 실행", "네트워크 접근", "다운로드: Chromium (약 150.0MB)", "파일 생성", "로컬 포트 열기: 8931", "설정 변경: .mcp.json", "! 브라우저"]) {
      expect(preview).toContain(s);
    }
  });

  // M6 TASK-058(D-028): M1 approvePlan·assertApproved를 삭제했다. CON-006(승인한 계획과 다른 계획은 실행 금지)은 공통 Approval kernel이
  // 지킨다(실행 직전 재생성·digest 비교 → PLAN_STALE, AC-028-04). 여기서는 Adapter 형식의 Approval을 직접 만들어도 gate를 통과하지
  // 못함을 확인한다.
  it("AC-005-03 승인한 계획과 다른 계획으로는 실행되지 않는다 (CON-006) — 직접 만든 Approval은 gate를 통과하지 못한다", async () => {
    const forged: Approval = { planDigest: "sha256:" + "0".repeat(64), approvedBy: "tester", approvedAt: new Date(0).toISOString() };
    let regenerated = 0;
    expect(await verifyApprovedPlan(forged as never, () => (regenerated++, Promise.reject(new Error("unused"))))).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(regenerated).toBe(0);
    const core = await import("../src/index");
    for (const removed of ["approvePlan", "assertApproved", "ApprovalMismatchError", "planDigest"]) expect(Object.keys(core), removed).not.toContain(removed);
  });

  it("AC-005-04 M1 installer 코드는 프로세스를 실행하지 않는다 (CON-005)", async () => {
    const dir = path.resolve(import.meta.dirname, "../src/installer");
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/child_process|execa|Bun\.spawn|Deno\.Command/u);
    }
  });
});
