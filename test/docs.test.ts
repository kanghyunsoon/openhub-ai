import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../packages/core/src/index";
import { PINOKIO_SUPPORT_NOTICE, TREND_SCORE_MEANING_EN } from "../packages/core/src/index";
import { runCli } from "../apps/cli/src/cli";
import { runDemo } from "../scripts/demo";

/** REQ-062 TASK-073 공개 문서·demo·최종 회귀. */
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const DOCS = ["architecture", "security-model", "approval-model", "supported-platforms", "discovery-trust", "llm-privacy", "troubleshooting", "release-process"].map((d) => "docs/" + d + ".md");
/** 공개 문서: README·SECURITY·CONTRIBUTING·docs 최상위 공개 문서·demo README. 내부 개발 문서는 public export에서 빠진다. */
const PUBLIC = ["README.md", "README.ko.md", "SECURITY.md", "CONTRIBUTING.md", "examples/demo-project/README.md", ...DOCS].filter((f) => existsSync(path.join(ROOT, f)));
const headings = (md: string) => [...md.replace(/```[\s\S]*?```/gu, "").matchAll(/^(#{1,6}) (.+)$/gmu)].map((m) => ({ level: m[1]!.length, text: m[2]!.trim() }));
const GOLDEN = path.join(ROOT, "test/fixtures/demo/demo-output.txt");

describe("REQ-062 TASK-073 문서·demo·최종 회귀", () => {
  it("AC-073-01 README.md는 English이고 정해진 section 순서이며 README.ko.md는 같은 구조다", () => {
    const en = read("README.md");
    expect(en).not.toMatch(/[\uac00-\ud7a3]/u);
    expect(headings(en).map((h) => h.level + " " + h.text)).toEqual([
      "1 OpenHub AI", "2 Demo", "2 Why OpenHub", "2 Core Features", "2 How It Works", "2 Quick Start", "2 Supported Clients and Backends",
      "2 Security and Approval Model", "2 CLI", "2 Desktop", "2 Architecture", "2 Contributing", "2 License",
    ]);
    expect(en.indexOf("Discover → Recommend → Install → Verify → Update → Rollback")).toBeGreaterThan(en.indexOf("## How It Works"));
    expect(en.split("\n").slice(0, 4).join("\n")).toMatch(/^# OpenHub AI\n\nOpenHub AI is /u);
    const ko = read("README.ko.md");
    expect(headings(ko).map((h) => h.level)).toEqual(headings(en).map((h) => h.level));
    expect(ko).toMatch(/[\uac00-\ud7a3]/u);
  });

  it("AC-073-02 공개 문서 8종이 있다", () => {
    for (const f of DOCS) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  // 개발 도구 이름·내부 문서 경로 검사는 test/internal-truth.internal.test.ts에 있다(public export 제외).
  it("AC-073-03 공개 문서에 내부 요구사항·작업 식별자가 없다", () => {
    expect(PUBLIC.length).toBeGreaterThanOrEqual(11);
    for (const f of PUBLIC) {
      const t = read(f);
      expect(t, f).not.toMatch(/\b(?:REQ|D|P|TASK|AC|DC|F)-\d{2,3}\b/u);
    }
  });

  it("AC-073-04 문서의 openhub 명령은 모두 실제 help에 있다", async () => {
    const out: string[] = [];
    await runCli(["--help"], { out: (l) => out.push(l), err: () => undefined, cwd: ROOT, version: "0.1.0" });
    const help = out.join("\n");
    const subcommands = new Set(["registry", "project", "lifecycle", "candidate", "pinokio"]);
    let checked = 0;
    for (const f of PUBLIC) {
      for (const m of read(f).matchAll(/(?:^|[\x60\s])openhub ((?:[a-z-]+|--[a-z-]+)(?: [^\x60\n|]*)?)/gmu)) {
        const words = m[1]!.trim().split(/\s+/u);
        const cmd = words[0]!;
        if (cmd === "--version" || cmd === "--help") {
          expect(help, f).toContain("  " + cmd);
          continue;
        }
        const head = subcommands.has(cmd) ? cmd + " " + words[1] : cmd;
        expect(help, f + ": openhub " + head).toMatch(new RegExp("^  " + head.replace(/[-]/gu, "\\-") + "\\b", "mu"));
        for (const flag of words.filter((x) => x.startsWith("--"))) expect(help, f + ": " + flag).toContain(flag);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it("AC-073-05 Trend·OpenScore 의미, Candidate UNVERIFIED, unsigned 경고, macOS artifact 없음·GUI 환경변수, Pinokio 문구, SBOM coverage·scan 한계가 문서에 있다", () => {
    const all = PUBLIC.map(read).join("\n");
    expect(read("README.md")).toContain(TREND_SCORE_MEANING_EN);
    expect(read("docs/discovery-trust.md")).toContain(TREND_SCORE_MEANING_EN);
    expect(all).toContain("OpenScore reflects repository maintenance, activity and community signals; it is not a security or code-quality rating.");
    expect(read("docs/discovery-trust.md")).toContain("labeled UNVERIFIED and DRAFT");
    expect(read("README.md")).toMatch(/\*\*unsigned\*\*, so Windows SmartScreen or Smart App Control may warn/u);
    expect(read("docs/supported-platforms.md")).toContain("there is no macOS release artifact");
    expect(read("docs/supported-platforms.md")).toContain("do not inherit environment variables from your shell profile");
    expect(read("docs/supported-platforms.md")).toContain("launchctl setenv");
    for (const f of ["README.md", "docs/supported-platforms.md"]) expect(read(f), f).toContain(PINOKIO_SUPPORT_NOTICE);
    const rel = read("docs/release-process.md");
    expect(rel).toContain("### Artifact ↔ SBOM coverage");
    expect(rel).toMatch(/\| CLI \x60openhub-ai-<version>\.tgz\x60 \|.*\| Windows x64 NSIS installer \|.*\| Linux x64 AppImage \|/su);
    expect(rel).toContain("Syft finds **no components** in the Linux AppImage or in the CLI tgz");
  });

  it("AC-073-06 pnpm demo는 Analyze → … → Benchmark Preview를 network 0·spawn 0·결정론(golden)으로 출력한다", { timeout: 60_000 }, async () => {
    const before = readdirSync(path.join(ROOT, "examples/demo-project"), { recursive: true }).map(String).sort();
    const a = await runDemo();
    const b = await runDemo();
    expect(a.lines).toEqual(b.lines);
    expect(a.spawned).toEqual([]);
    expect(a.fetched.every((u) => u.startsWith("https://registry.npmjs.org/") || u.startsWith("https://api.github.com/repos/modelcontextprotocol/servers/releases"))).toBe(true);
    const text = a.lines.join("\n") + "\n";
    const steps = ["1. Analyze", "2. Existing tools", "3. Recommend", "4. Install preview", "5. Adopt", "6. Releases", "7. Impact", "8. Update preview", "9. Discover", "10. Benchmark preview"];
    let at = -1;
    for (const s of steps) {
      const i = text.indexOf("== " + s);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toContain("프로세스 실행 0회");
    expect(text).not.toMatch(/openhub-demo-|[A-Za-z]:\\\\|\/tmp\//u);
    expect(readdirSync(path.join(ROOT, "examples/demo-project"), { recursive: true }).map(String).sort()).toEqual(before);
    if (process.env["OPENHUB_UPDATE_GOLDEN"] === "1") {
      mkdirSync(path.dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text);
    }
    expect(text).toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/gu, "\n"));
    expect(JSON.parse(read("package.json")).scripts.demo).toBe("tsx scripts/demo.ts");
  });

  it("AC-073-07 demo·문서 시연 문구는 실제 구현과 같다(Playwright는 npx, Pinokio 설치 주장 없음, 자동 rollback 없음)", () => {
    const golden = readFileSync(GOLDEN, "utf8");
    expect(golden).toContain("Backend      npx");
    expect(golden).toContain("npx @playwright/mcp@latest");
    expect(golden).not.toMatch(/--backend pinokio|Pinokio로|Rolling Back|자동 롤백|자동 rollback/iu);
    expect(golden).toContain("Health가 실패하면 설정을 원래 내용으로 되돌리고 Version State를 바꾸지 않습니다");
    expect(read("docs/approval-model.md")).toContain("Automatic rollback does not exist.");
    const readme = read("README.md");
    expect(readme).not.toMatch(/Playwright[^.\n]*Pinokio|automatic(?:ally)? roll/iu);
    expect(readme).toContain("the demo declines the approval");
  });

  it("AC-073-08 문서 스크린샷은 fixture 데이터 smoke 캡처다", () => {
    const png = readFileSync(path.join(ROOT, "docs/images/desktop.png"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    for (const f of ["README.md", "README.ko.md"]) expect(read(f)).toContain("](docs/images/desktop.png)");
    const shot = read("scripts/docs-screenshot.ts");
    for (const s of ['OPENHUB_SMOKE_PROJECT: path.join(ROOT, "examples", "demo-project")', "metadata.seed-synthetic.json", "OPENHUB_SCREENSHOT: out", '["OPENHUB_SMOKE_INSTALL", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_RELEASE"]']) expect(shot).toContain(s);
    expect(read("apps/desktop/src/main.ts")).toContain('executeJavaScript("window.scrollTo(0, 0)")');
    // 화면에 그리는 Project 데이터에는 절대 경로가 없다(Profile 계약).
    expect(core.containsAbsolutePath(JSON.stringify({ name: "demo-project" }))).toBe(false);
  });

  // 골든 파일의 M6 종료 commit 대비 동일성(git 이력 필요)은 test/internal-truth.internal.test.ts에 있다.
  it("AC-073-09 최종 회귀: v1 contract schema가 M6 종료 시점과 같다", () => {
    const baseline = JSON.parse(read("test/fixtures/m7-final/schema-digests.json")) as Record<string, string>;
    const names = ["installPlanSchema", "lifecyclePlanSchema", "lifecycleStateFileSchema", "releaseSnapshotSchema", "releaseSummarySchema", "updateImpactSchema", "pinokioPlanSchema", "recommendationReportSchema"] as const;
    for (const n of names) {
      const schema = (core as unknown as Record<string, { toJSONSchema(o: unknown): unknown }>)[n]!;
      const digest = createHash("sha256").update(JSON.stringify(schema.toJSONSchema({ io: "output", unrepresentable: "any" }))).digest("hex");
      expect(digest, n).toBe(baseline[n]);
    }
  });
});
