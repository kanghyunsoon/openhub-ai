import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ALLOWED_NOT_RUN, REQUIRED_CHECKS, REQUIRED_STEPS, checkRcResult } from "../scripts/rc/check-rc-result.mjs";

/** v0.2.0 RC 결과 판정기(fail-closed). 예전 하네스는 FAIL이 있어도 종료 코드 0이었다. */
const ROOT = path.resolve(import.meta.dirname, "..");
const pass = (os: "windows" | "linux" = "windows") => ({
  os,
  steps: Object.fromEntries(REQUIRED_STEPS.map((n) => [String(n), { status: "PASS", evidence: {} }])),
  // 하네스가 그 OS에서 기록하는 필수 check 전부(v0.2.1).
  checks: Object.fromEntries(REQUIRED_CHECKS[os].map((id) => [id, { status: "PASS", evidence: {} }])) as Record<string, unknown>,
  notRun: [] as unknown[],
  errors: [] as unknown[],
});

describe("checkRcResult", () => {
  it("A: 단계 3~14 모두 PASS, 허용된 NOT-RUN만 있으면 통과하고 NOT-RUN을 기록한다", () => {
    const r = pass("windows");
    r.notRun.push({ id: "korean-os-first-start", step: 3 });
    const v = checkRcResult(r, { os: "windows" });
    expect(v).toMatchObject({ ok: true, failures: [] });
    expect(v.notRunRecorded.map((n) => n.id)).toEqual(["korean-os-first-start"]);
  });

  it("B: FAIL인 단계가 하나라도 있으면 실패", () => {
    const r = pass();
    r.steps["8"] = { status: "FAIL", evidence: {} };
    expect(checkRcResult(r)).toMatchObject({ ok: false, failures: ["step 8: FAIL"] });
  });

  it("C: FAIL인 check가 있으면 실패", () => {
    const r = pass();
    r.checks["plan-stale-blocks-and-keeps-external-change"] = { status: "FAIL", evidence: {} };
    expect(checkRcResult(r)).toMatchObject({ ok: false, failures: ["check plan-stale-blocks-and-keeps-external-change: FAIL"] });
  });

  it("C2 (v0.2.1): 빈 checks, 빠진 필수 check, 오타·모르는 check 이름은 Windows·Linux 모두 실패", () => {
    for (const os of ["windows", "linux"] as const) {
      expect(checkRcResult({ ...pass(os), checks: {} }, { os }).failures, os).toEqual(REQUIRED_CHECKS[os].map((id) => "check " + id + ": missing"));
      const missing = pass(os);
      delete missing.checks["health-failure-compensation"];
      expect(checkRcResult(missing, { os }).failures).toEqual(["check health-failure-compensation: missing"]);
      const typo = pass(os);
      delete typo.checks["reject-writes-nothing"];
      typo.checks["reject-writes-nothin"] = { status: "PASS" };
      expect(checkRcResult(typo, { os }).failures).toEqual(["check reject-writes-nothing: missing", "check reject-writes-nothin: unknown check id"]);
      const extra = pass(os);
      extra.checks["something-else"] = { status: "PASS" };
      expect(checkRcResult(extra, { os }).failures).toEqual(["check something-else: unknown check id"]);
      expect(checkRcResult({ ...pass(os), checks: undefined }, { os }).failures).toEqual(["checks: missing"]);
    }
    // 한국어 첫 실행 check는 Linux 필수, Windows에서는 기록되지 않는다(NOT-RUN 허용 목록).
    const linux = pass("linux");
    delete linux.checks["first-start-follows-os-korean"];
    expect(checkRcResult(linux, { os: "linux" }).failures).toEqual(["check first-start-follows-os-korean: missing"]);
    const windows = pass("windows");
    windows.checks["first-start-follows-os-korean"] = { status: "PASS" };
    expect(checkRcResult(windows, { os: "windows" }).failures).toEqual(["check first-start-follows-os-korean: unknown check id"]);
    expect(REQUIRED_CHECKS.windows).toEqual(["reject-writes-nothing", "plan-stale-blocks-and-keeps-external-change", "kubernetes-secret-denied-configmap-read-no-token", "kubernetes-reviewed-tool-config", "kubernetes-only-0.0.67", "health-failure-compensation", "app-version-shown"]);
    expect(REQUIRED_CHECKS.linux).toEqual([...REQUIRED_CHECKS.windows, "first-start-follows-os-korean"]);
  });

  it("C3 (v0.2.1): 필수 check 목록은 하네스가 실제로 기록하는 check 이름과 같다", () => {
    const harness = readFileSync(path.join(ROOT, "scripts/rc/packaged-rc.mjs"), "utf8");
    const recorded = [...harness.matchAll(/\bcheck\(\s*"([a-z0-9.-]+)"/gu)].map((m) => m[1]);
    expect([...new Set(recorded)].sort()).toEqual([...REQUIRED_CHECKS.linux].sort());
  });

  it("D: 오류가 기록되어 있으면 실패", () => {
    const r = pass();
    r.errors.push("Error: timeout\n    at ev (packaged-rc.mjs:1:1)");
    expect(checkRcResult(r)).toMatchObject({ ok: false, failures: ["error: Error: timeout"] });
  });

  it("E: 필수 단계가 빠지면 실패", () => {
    const r = pass();
    delete r.steps["12"];
    expect(checkRcResult(r)).toMatchObject({ ok: false, failures: ["step 12: missing"] });
    expect(checkRcResult({ ...pass(), steps: undefined }).ok).toBe(false);
  });

  it("F: 필수 단계가 NOT-RUN이면 실패(세부 항목 허용 목록과 별개)", () => {
    const r = pass();
    r.steps["9"] = { status: "NOT-RUN", evidence: "not reached" };
    expect(checkRcResult(r)).toMatchObject({ ok: false, failures: ["step 9: NOT-RUN"] });
  });

  it("G: 허용 목록 밖 NOT-RUN(이제 실행하는 정확한 버전·Health 실패 보상 포함), 예전 문자열 형식, 다른 단계, 허용되지 않은 OS는 실패", () => {
    for (const item of [{ id: "smartscreen", step: 2 }, "3: first start with a Korean OS language", { id: "korean-os-first-start", step: 8 }, { step: 11 }, { id: "exact-version-v1-v2-v1", step: 9 }, { id: "health-failure-compensation", step: 11 }]) {
      const r = pass();
      r.notRun.push(item);
      expect(checkRcResult(r).ok, JSON.stringify(item)).toBe(false);
    }
    const linux = pass("linux");
    linux.notRun.push({ id: "korean-os-first-start", step: 3 });
    expect(checkRcResult(linux)).toMatchObject({ ok: false, failures: ["NOT-RUN korean-os-first-start: not allowed on linux"] });
  });

  it("H: 실패 주입 흔적, 알 수 없는 상태, 형식 오류, OS 불일치는 실패", () => {
    expect(checkRcResult({ ...pass(), injected: "step-fail" }).ok).toBe(false);
    const unknown = pass();
    unknown.steps["5"] = { status: "SKIPPED", evidence: {} };
    expect(checkRcResult(unknown).failures).toEqual(['step 5: unknown status "SKIPPED"']);
    for (const bad of [null, [], "PASS", 1]) expect(checkRcResult(bad).ok).toBe(false);
    expect(checkRcResult({ ...pass(), errors: undefined }).ok).toBe(false);
    expect(checkRcResult({ ...pass(), notRun: undefined }).ok).toBe(false);
    expect(checkRcResult({ ...pass(), checks: { x: "PASS" } }).ok).toBe(false);
    expect(checkRcResult({ ...pass(), os: "macos" }).ok).toBe(false);
    expect(checkRcResult(pass("linux"), { os: "windows" }).ok).toBe(false);
    const extra = pass();
    (extra.steps as Record<string, unknown>)["16"] = { status: "FAIL" };
    expect(checkRcResult(extra).ok).toBe(false);
  });

  it("허용 목록은 한 항목(Windows 한국어 OS 첫 실행)으로 고정되어 있다(늘리려면 이 테스트와 RC 문서를 함께 바꾼다)", () => {
    expect(Object.keys(ALLOWED_NOT_RUN)).toEqual(["korean-os-first-start"]);
    expect(Object.isFrozen(ALLOWED_NOT_RUN)).toBe(true);
  });
});

describe("check-rc-result CLI 종료 코드", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openhub-rc-check-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts/rc/check-rc-result.mjs"), ...args], { encoding: "utf8" });
  const file = (name: string, body: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, body);
    return f;
  };

  it("통과는 0, 실패·파일 없음·깨진 JSON·인자 없음은 1", () => {
    expect(run(file("ok.json", JSON.stringify(pass("linux"))), "--os", "linux").status).toBe(0);
    const failing = pass();
    failing.steps["10"] = { status: "FAIL", evidence: {} };
    const r = run(file("fail.json", JSON.stringify(failing)));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL step 10: FAIL");
    expect(run(path.join(dir, "missing.json")).status).toBe(1);
    expect(run(file("broken.json", "{")).status).toBe(1);
    expect(run().status).toBe(1);
    expect(run(file("os.json", JSON.stringify(pass("linux"))), "--os", "windows").status).toBe(1);
  });
});

describe("RC workflow·하네스 배선", () => {
  const harness = readFileSync(path.join(ROOT, "scripts/rc/packaged-rc.mjs"), "utf8");
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/rc-packaged.yml"), "utf8");

  it("하네스는 결과를 쓴 뒤 판정 결과로 종료하고 무조건 0으로 끝내지 않는다", () => {
    expect(harness).toContain('import { checkRcResult, formatVerdict } from "./check-rc-result.mjs";');
    expect(harness).toContain("process.exit(verdict.ok ? 0 : 1);");
    expect(harness).not.toMatch(/process\.exit\(0\)/u);
    expect(harness.indexOf("await writeFile(out, text")).toBeLessThan(harness.indexOf("process.exit(verdict.ok ? 0 : 1);"));
    expect(harness).not.toMatch(/notRun\.push\("/u);
    // 정확한 버전·Health 실패 보상은 더 이상 NOT-RUN으로 남기지 않는다.
    expect(harness).not.toContain('id: "exact-version-v1-v2-v1"');
    expect(harness).not.toContain('id: "health-failure-compensation"');
    expect(harness).toContain('check(\n      "health-failure-compensation",');
    expect(harness).toContain("window.__openhubLifecycleUpdateTo('memory-mcp', ");
    // 테스트 Registry를 쓰지 않는다(OPENHUB_REGISTRY는 실행 전에 지운다).
    expect(harness).toContain("delete env.OPENHUB_REGISTRY;");
  });

  it("Windows·Linux job 모두 독립 판정 단계(!cancelled)와 always 업로드가 있고 실패 주입 입력이 있다", () => {
    expect(workflow).toContain("node scripts/rc/check-rc-result.mjs rc-out/windows.json --os windows");
    expect(workflow).toContain("node scripts/rc/check-rc-result.mjs rc-out/linux.json --os linux");
    expect(workflow.match(/name: "Verdict \(steps 3-14 result file, fail-closed\)"\n\s+if: \$\{\{ !cancelled\(\) \}\}/gu)?.length).toBe(2);
    expect(workflow.match(/uses: actions\/upload-artifact@v4\n\s+if: always\(\)/gu)?.length).toBe(2);
    expect(workflow).not.toContain("continue-on-error");
  });

  it("Windows 제거 단계: 종료 코드 ≠ 0·파일 잔존·설정 변경을 모아 실패하고, 실패해도 비교와 종료 코드 기록을 남긴다", () => {
    const step = workflow.slice(workflow.indexOf('- name: "15 Uninstall (NSIS) and compare user settings"'), workflow.indexOf('- name: "Verdict', workflow.indexOf('- name: "15 Uninstall (NSIS)')));
    expect(step).toContain("if: ${{ !cancelled() }}");
    expect(step).toContain('if ($p.ExitCode -ne 0) { $errors += "uninstaller exit code $($p.ExitCode)" }');
    expect(step).toContain('if ($exeLeft) { $errors += "program files remain after uninstall" }');
    expect(step).toContain('if ($LASTEXITCODE -ne 0) { $errors += "user settings changed after uninstall" }');
    expect(step).toContain('if ($errors.Count -gt 0) { throw ("step 15 failed: " + ($errors -join "; ")) }');
    // 오류가 있어도 제거 후 snapshot·비교를 먼저 실행하고 마지막에 실패한다.
    expect(step.indexOf("windows-after-uninstall.json")).toBeLessThan(step.indexOf("throw ("));
    expect(step).toContain("Set-Content rc-out/windows-uninstall.txt");
    // 실패 주입은 실제 프로세스의 종료 코드 3으로 확인한다.
    expect(step).toContain('if ($env:OPENHUB_RC_INJECT_FAILURE -eq "uninstall-exit") {');
    expect(step).toContain('"-NoProfile", "-Command", "exit 3"');
    expect(workflow).toContain("options: [none, step-fail, check-fail, error, missing-step, not-run, uninstall-exit]");
    expect(harness).toContain('if (kind === "uninstall-exit") return;');
    expect(workflow).toContain("OPENHUB_RC_INJECT_FAILURE: $" + "{{ inputs.inject_failure || 'none' }}");
  });
});
