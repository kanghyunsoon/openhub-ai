import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setDesktopLocale } from "../src/i18n/index";
import { pinokioPreviewForRenderer } from "../src/release";

/**
 * v0.2.1 #39 리뷰: Desktop Pinokio Preview(실행 채널 없음)도 지원 중단 도구는 Registry 항목 유무와 관계없이 TOOL_WITHDRAWN과
 * 사유·#59를 보여 준다. English 모드는 영어 사유다. probe·network 전에 막는다.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const ISSUE = "https://github.com/kanghyunsoon/openhub-ai/issues/59";
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-serena-withdrawn-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => setDesktopLocale("ko"));

async function userRegistry(): Promise<string> {
  const dir = path.join(scratch, "user-registry");
  await cp(path.join(REPO, "registry"), dir, { recursive: true });
  await mkdir(path.join(dir, "coding-agent"), { recursive: true });
  await writeFile(path.join(dir, "coding-agent", "serena.yaml"), await readFile(path.join(REPO, "packages", "core", "test", "fixtures", "registry-legacy", "coding-agent", "serena.yaml"), "utf8"));
  return dir;
}

describe("v0.2.1 #39 리뷰: Desktop Pinokio Preview의 Serena 지원 중단 안내", () => {
  it("실제·사용자 Registry 모두 TOOL_WITHDRAWN이고 English/한국어 사유와 #59를 보여 준다(probe·network 0)", async () => {
    for (const registryDir of [path.join(REPO, "registry"), await userRegistry()]) {
      for (const locale of ["en", "ko"] as const) {
        setDesktopLocale(locale);
        let calls = 0;
        const r = await pinokioPreviewForRenderer({ registryDir, homeDir: scratch, fetch: async () => (calls++, new Response("", { status: 500 })), pinokioProbe: { pathEnv: "", platform: "linux", fs: { stat: async () => (calls++, Promise.reject(new Error("probe"))) } as never } }, "serena");
        expect(r, locale).toMatchObject({ status: "error", code: "TOOL_WITHDRAWN" });
        const message = (r as { message: string }).message;
        expect(message, locale).toContain(ISSUE);
        if (locale === "en") {
          expect(message).toContain("is no longer supported for new installs");
          expect(message).not.toMatch(/[\u3131-\uD79D]/u);
        } else expect(message).toContain("지원하지 않습니다");
        expect(calls, locale).toBe(0);
      }
    }
  });

  it("Registry에 없는 다른 도구는 그대로 TOOL_NOT_FOUND다", async () => {
    setDesktopLocale("en");
    const r = await pinokioPreviewForRenderer({ registryDir: path.join(REPO, "registry"), homeDir: scratch }, "no-such-tool");
    expect(r).toMatchObject({ status: "error", code: "TOOL_NOT_FOUND" });
  });
});
