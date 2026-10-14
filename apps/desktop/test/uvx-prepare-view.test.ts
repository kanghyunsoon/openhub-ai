import { afterEach, describe, expect, it } from "vitest";
import type { InstallResultV1 } from "@openhub/core";
import { buildInstallResultView } from "../src/install";
import { setDesktopLocale } from "../src/i18n/index";

/** v0.2.1 uvx Prepare: Desktop 결과 화면의 Prepared 표시가 backend(npx cache·uv cache)에 맞다. */
afterEach(() => setDesktopLocale("en"));
const result = (backend: "npx" | "uvx"): InstallResultV1 => ({
  schemaVersion: 1,
  planDigest: "sha256:" + "0".repeat(64),
  toolId: backend === "uvx" ? "postgres-mcp" : "fixture-npx-mcp",
  backend,
  status: "succeeded",
  steps: [],
  retryable: false,
  configChanges: [],
  verification: { prepared: "cached", configured: true, detected: "skipped" },
  requiredEnv: [],
  warnings: [],
  nextActions: [],
});

describe("uvx Prepare 결과 표시", () => {
  it("uvx의 cached는 uv cache, npx의 cached는 npx cache로 표시한다(한국어·English)", () => {
    for (const [locale, uv, npm] of [
      ["ko", "cached(uv cache에 미리 설치하고 네트워크 없이 확인함)", "cached(npx cache에 미리 받음)"],
      ["en", "cached (installed into the uv cache in advance and checked offline)", "cached (downloaded into the npx cache in advance)"],
    ] as const) {
      setDesktopLocale(locale);
      expect(buildInstallResultView(result("uvx")).stages[0]).toEqual({ name: "Prepared", value: uv });
      expect(buildInstallResultView(result("npx")).stages[0]).toEqual({ name: "Prepared", value: npm });
    }
  });
});
