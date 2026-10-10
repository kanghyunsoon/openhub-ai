import { describe, expect, it } from "vitest";
import { fastManifestIssues } from "../../src/index";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.0 P0-2 MongoDB MCP Server Manifest 계약(network 0). 실제 서버 동작은 sandbox.e2e.test.ts(OPENHUB_E2E=1)가 확인한다.
 * mongodb-mcp-server 3.0.5는 공백으로 구분한 --disabledTools 목록에서 첫 값만 적용하고 나머지를 조용히 무시한다(실측).
 * 그래서 목록은 쉼표로 이은 인자 하나여야 한다.
 */
const DISABLED = ["export", "connect", "search-knowledge", "list-knowledge-sources", "atlas-local-connect-deployment", "atlas-local-list-deployments", "mongodb-logs"];
const seed = await seedEntries();
const mongo = seed.find((e) => e.manifest.name === "mongodb-mcp-server")!.manifest;

describe("MongoDB MCP Server Manifest", () => {
  it("고정 버전 + --readOnly + telemetry 끔 + 쉼표 하나로 된 --disabledTools(차단 7개)", () => {
    const command = (mongo.install.options as { command: string }).command;
    const tokens = command.split(" ");
    expect(tokens.slice(0, 3)).toEqual(["npx", "-y", "mongodb-mcp-server@3.0.5"]);
    expect(tokens).toContain("--readOnly");
    expect(tokens[tokens.indexOf("--telemetry") + 1]).toBe("disabled");
    const i = tokens.indexOf("--disabledTools");
    expect(i).toBeGreaterThan(0);
    expect(tokens[i + 1]!.split(",")).toEqual(DISABLED);
    // 목록 뒤에 다른 값 인자가 없어야 한다(공백 구분 목록 금지).
    expect(tokens.slice(i + 2).every((t) => t.startsWith("--"))).toBe(true);
    expect(fastManifestIssues(mongo)).toEqual([]);
  });

  it("Node 요구 범위는 >=24이고 SQL capability가 없다", () => {
    expect(mongo.requirements?.node).toBe(">=24");
    expect(mongo.capabilities).toEqual(["db-schema-access", "query-tuning"]);
  });

  it("필수 환경변수 설명이 읽기 전용 DB 계정을 안내한다(설명은 Plan에 들어가지 않는다: AC-027-06)", () => {
    const env = mongo.env.find((e) => e.name === "MDB_MCP_CONNECTION_STRING")!;
    expect(env.required).toBe(true);
    expect(env.description).toMatch(/읽기 권한/u);
  });
});

