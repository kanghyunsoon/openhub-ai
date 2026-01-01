import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PINOKIO_SUPPORT_NOTICE, PINOKIO_SUPPORT_NOTICE_KO, PTERM_SUPPORTED_VERSION, buildPinokioPlan, isSupportedPinokioVersion, pinokioCompatReport } from "../../src/index";
import { REPO_ROOT } from "../recommendation/helpers";
import { pinokioManifest } from "./helpers";

/** TASK-068 Pinokio 호환성 재확인·수동 E2E. 가짜 fetch만 쓰고 실제 pinokiod를 시작하지 않는다. */
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("REQ-065 Pinokio 호환성과 수동 E2E", () => {
  it("AC-068-01 지원 pterm 버전은 0.0.25 그대로이고 다른 버전은 PINOKIO_VERSION_UNSUPPORTED다", () => {
    expect(PTERM_SUPPORTED_VERSION).toBe("0.0.25");
    for (const pterm of ["0.0.24", "0.0.26", "0.1.0"]) {
      expect(isSupportedPinokioVersion({ pterm, pinokiod: "4.0.3", script: "4.0" })).toBe(false);
      expect(buildPinokioPlan({ operation: "install", manifest: pinokioManifest() }, { versions: { pterm, pinokiod: "4.0.3", script: "4.0" }, appState: { exists: false, digest: "sha256:" + "0".repeat(64) }, installed: null })).toMatchObject({ ok: false, code: "PINOKIO_VERSION_UNSUPPORTED" });
    }
    expect(isSupportedPinokioVersion({ pterm: "0.0.25", pinokiod: "4.0.3", script: "4.0" })).toBe(true);
  });

  it("AC-068-02 pinokio:compat는 npm 최신 pterm·pinokiod 버전을 읽어 보고서만 쓰고 지원 상수를 바꾸지 않는다", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url + " " + (init?.method ?? "GET"));
      return new Response(JSON.stringify({ version: url.includes("pterm") ? "0.0.27" : "8.2.2" }), { status: 200 });
    });
    const r = await pinokioCompatReport({ fetch, now: () => new Date("2026-10-08T00:00:00.000Z") });
    expect(urls).toEqual(["https://registry.npmjs.org/pterm/latest GET", "https://registry.npmjs.org/pinokiod/latest GET"]);
    expect(r).toMatchObject({ latest: { pterm: "0.0.27", pinokiod: "8.2.2" }, ptermLatestIsSupported: false, supported: { pterm: "0.0.25" }, errors: [] });
    expect(PTERM_SUPPORTED_VERSION).toBe("0.0.25");
    const offline = await pinokioCompatReport({ fetch: async () => Promise.reject(new TypeError("offline")), now: () => new Date(0) });
    expect(offline).toMatchObject({ latest: { pterm: null, pinokiod: null }, ptermLatestIsSupported: null });
    expect(offline.errors.length).toBe(2);
    expect(read("scripts/pinokio-compat.ts")).not.toMatch(/PTERM_SUPPORTED_VERSION\s*=|writeFile\([^)]*probe/u);
    expect((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["pinokio:compat"]).toBe("tsx scripts/pinokio-compat.ts");
  });

  it("AC-068-03 pinokio-e2e.yml은 수동 실행 전용·continue-on-error·OPENHUB_E2E=1·읽기 권한·secret 0이며 필수 CI에서 참조하지 않는다", () => {
    const yml = read(".github/workflows/pinokio-e2e.yml");
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:\n\n/mu);
    expect(yml).not.toMatch(/pull_request|push:|schedule:/u);
    expect(yml).toContain("continue-on-error: true");
    expect(yml).toContain('OPENHUB_E2E: "1"');
    expect(yml).toMatch(/permissions:\n {2}contents: read/u);
    expect(yml).not.toMatch(/secrets\.|GITHUB_TOKEN|contents: write/u);
    expect(read(".github/workflows/ci.yml")).not.toMatch(/pinokio-e2e|OPENHUB_E2E/u);
  });

  it("AC-068-04 기본 테스트·CI에서는 실제 pinokiod를 시작하지 않는다", () => {
    const e2e = read("packages/core/test/pinokio/e2e.test.ts");
    expect(e2e).toContain('describe.skipIf(process.env["OPENHUB_E2E"] !== "1")');
    for (const f of readdirSync(path.join(REPO_ROOT, "packages/core/test/pinokio")).filter((x) => x.endsWith(".ts") && x !== "e2e.test.ts" && x !== "compat.test.ts")) {
      // 실제 pterm spawner·자식 프로세스를 쓰지 않는다(pinokiod HTTP는 가짜 fetch가 대신한다).
      // 실제 spawner는 spawnPterm의 기본값(spawner 미지정)이다. 기본 테스트는 항상 가짜 spawner를 넘긴다.
      expect(read("packages/core/test/pinokio/" + f), f).not.toMatch(new RegExp("nodeExecSpawner|from \"node:" + "child_" + "process\"", "u"));
    }
  });

  it("AC-068-05 Pinokio 지원 문구는 고정 문구와 같고 과장 표현이 없다", () => {
    expect(PINOKIO_SUPPORT_NOTICE).toBe("Pinokio support targets pterm 0.0.25. Default tests use a fake pinokiod; real Pinokio integration runs only when OPENHUB_E2E=1.");
    // TASK-073: README.md는 English가 되었고 한국어 README는 README.ko.md다. 각 언어의 고정 문구를 그대로 쓴다.
    expect(read("README.md")).toContain(PINOKIO_SUPPORT_NOTICE);
    expect(read("README.ko.md")).toContain(PINOKIO_SUPPORT_NOTICE_KO);
    expect(read("apps/desktop/renderer/index.html")).toContain(PINOKIO_SUPPORT_NOTICE_KO);
    const files = ["README.md", "README.ko.md", "docs/supported-platforms.md", "apps/desktop/renderer/index.html", ...readdirSync(path.join(REPO_ROOT, "apps/cli/src")).map((f) => "apps/cli/src/" + f), ...readdirSync(path.join(REPO_ROOT, "apps/desktop/src")).map((f) => "apps/desktop/src/" + f)];
    for (const f of files) {
      const lines = read(f).split("\n").filter((l) => /pinokio|pterm/iu.test(l));
      for (const l of lines) expect(l, f).not.toMatch(/모든 (?:Pinokio )?환경|all environments|fully (?:verified|supported)|검증 완료|보장합니다|guaranteed/iu);
    }
  });
});

