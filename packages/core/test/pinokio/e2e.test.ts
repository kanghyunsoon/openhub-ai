import os from "node:os";
import { readFile, realpath, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeWithPinokioApproval, planPinokio, requestPinokioApproval } from "../../src/index";
import { pinokioManifest } from "./helpers";

/**
 * 실제 Pinokio(pinokiod 127.0.0.1:42000 + npm global pterm 0.0.25) 연동 E2E. OPENHUB_E2E=1일 때만 실행한다(AC-053-09).
 * 기본 테스트·CI에서는 skip이다. 실행하면 실제 Pinokio home의 api/openhub-local-llm-ui 폴더를 만들고 pinokiod가 셸 명령을 실행한다.
 */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("REQ-032 Pinokio 실제 연동 E2E", () => {
  it("AC-053-09 실제 pinokiod로 install Plan을 만들고 사람 승인 뒤 실행한다", async () => {
    const probe = { pathEnv: process.env["PATH"] ?? "", platform: process.platform, fs: { stat: (f: string) => stat(f), readFile: (f: string) => readFile(f, "utf8"), realpath: (f: string) => realpath(f) } };
    const req = { operation: "install" as const, manifest: pinokioManifest() };
    const planned = await planPinokio(req, { probe, homeDir: os.homedir() });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const approval = await requestPinokioApproval(planned.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (approval.status !== "approved") throw new Error(approval.status);
    const report = await executeWithPinokioApproval(approval.approval, async () => {
      const again = await planPinokio(req, { probe, homeDir: os.homedir() });
      if (!again.ok) throw new Error(again.code);
      return again.planned;
    }, { entry: planned.entry, homeDir: os.homedir() });
    expect(report.ok).toBe(true);
  }, 30 * 60_000);
});

