import { describe, expect, it } from "vitest";
import type { InstallResultV1 } from "@openhub/core";
import { formatInstallResult } from "../src/install";

/** v0.2.1 RC: CLI 설치 결과가 uvx Prepare(uv cache)를 npx cache로 잘못 표시하던 문제. Desktop 표시와 같은 뜻이어야 한다. */
const result = (backend: "npx" | "uvx" | "docker", prepared: "cached" | "launch-on-demand" | "pulled"): InstallResultV1 => ({
  schemaVersion: 1,
  planDigest: "sha256:" + "0".repeat(64),
  toolId: backend === "uvx" ? "postgres-mcp" : "memory-mcp",
  backend,
  status: "succeeded",
  steps: [],
  retryable: false,
  configChanges: [],
  verification: { prepared, configured: true, detected: "skipped" },
  requiredEnv: [],
  warnings: [],
  nextActions: [],
});
const preparedLine = (r: InstallResultV1) => formatInstallResult(r).find((l) => l.trimStart().startsWith("Prepared"));

describe("CLI 설치 결과의 Prepared 표시", () => {
  it("uvx의 cached는 uv cache, npx의 cached는 npx cache로 표시한다", () => {
    expect(preparedLine(result("uvx", "cached"))).toBe("  Prepared    cached(uv cache에 미리 설치하고 네트워크 없이 확인함)");
    expect(preparedLine(result("npx", "cached"))).toBe("  Prepared    cached(npx cache에 미리 받음)");
    expect(preparedLine(result("uvx", "cached"))).not.toContain("npx");
  });

  it("cached가 아닌 상태는 backend와 관계없이 그대로다", () => {
    expect(preparedLine(result("uvx", "launch-on-demand"))).toBe("  Prepared    launch-on-demand(Client 첫 실행 때 받음)");
    expect(preparedLine(result("docker", "pulled"))).toBe("  Prepared    pulled");
  });
});
