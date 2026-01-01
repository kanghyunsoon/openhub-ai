import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseManifest, validateManifest, ADAPTER_IDS, type ManifestIssue } from "../src/index";

const planExample = readFileSync(new URL("./fixtures/plan-section-10.yaml", import.meta.url), "utf8");

function base(): Record<string, unknown> {
  const r = parseManifest(planExample);
  if (!r.ok) throw new Error("fixture invalid");
  return structuredClone(r.manifest) as unknown as Record<string, unknown>;
}

function issuesOf(data: unknown): ManifestIssue[] {
  const r = validateManifest(data);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.issues;
}

describe("REQ-001 OpenHub Manifest v1", () => {
  it("AC-002-01 기획서 §10 playwright-mcp 예시가 오류 없이 파싱된다", () => {
    const r = parseManifest(planExample);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.manifest.name).toBe("playwright-mcp");
    expect(r.manifest.install.preferredAdapter).toBe("pinokio");
    expect(r.manifest.install.fallback).toEqual([{ adapter: "npx", command: "npx @playwright/mcp@latest" }]);
    expect(r.manifest.schemaVersion).toBe(1);
    expect(r.manifest.verification).toBe("draft");
  });

  it("AC-002-02 필수 필드 누락은 예외 없이 { path, message } 목록으로 반환된다", () => {
    const data = base();
    delete data["repository"];
    data["targets"] = [];
    const issues = issuesOf(data);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(["repository", "targets"]));
    for (const i of issues) expect(i.message.length).toBeGreaterThan(0);
  });

  it("AC-002-02 잘못된 값은 중첩 경로와 함께 보고된다", () => {
    const data = base();
    data["name"] = "Playwright_MCP";
    (data["platform"] as Record<string, unknown>)["windows"] = "yes";
    const paths = issuesOf(data).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "platform.windows"]));
  });

  it("AC-002-02 YAML 문법 오류도 issue로 돌려준다", () => {
    const r = parseManifest("name: [unclosed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toMatch(/YAML/);
  });

  it("AC-002-03 알 수 없는 preferredAdapter와 fallback adapter는 거부된다", () => {
    const data = base();
    (data["install"] as Record<string, unknown>)["preferredAdapter"] = "brew";
    (data["install"] as Record<string, unknown>)["fallback"] = [{ adapter: "cargo", command: "cargo install x" }];
    const paths = issuesOf(data).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["install.preferredAdapter", "install.fallback[0].adapter"]));
  });

  it("AC-002-03 알려진 Adapter ID는 모두 허용된다", () => {
    for (const adapter of ADAPTER_IDS) {
      const data = base();
      (data["install"] as Record<string, unknown>)["preferredAdapter"] = adapter;
      expect(validateManifest(data).ok).toBe(true);
    }
  });

  it("AC-002-04 Adapter 고유 설정이 install 밖에 있으면 거부된다", () => {
    const data = base();
    data["npm"] = { package: "@playwright/mcp" };
    expect(issuesOf(data).some((i) => i.path === "" && i.message.includes("npm"))).toBe(true);
  });

  it("AC-002-04 Adapter 고유 설정은 install.options 아래에는 둘 수 있다", () => {
    const data = base();
    (data["install"] as Record<string, unknown>)["options"] = { script: "pinokio.js", anything: { nested: true } };
    expect(validateManifest(data).ok).toBe(true);
  });

  it("env는 문자열 목록(기획서 §11)과 객체 목록을 모두 받아 정규화한다", () => {
    const data = base();
    data["env"] = ["OPENAI_API_KEY", { name: "GITHUB_TOKEN", required: false }];
    const r = validateManifest(data);
    expect(r.ok && r.manifest.env).toEqual([
      { name: "OPENAI_API_KEY", required: true },
      { name: "GITHUB_TOKEN", required: false },
    ]);
  });
});
