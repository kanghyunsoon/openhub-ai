import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  containsAbsolutePath,
  parseUvxPrepareArgs,
  prepareUvxPackage,
  uvChildEnv,
  uvIndexFingerprint,
  uvxPrepareArgs,
  uvxPrepareTarget,
  uvxVerifyArgs,
  type ExecChild,
  type NpxSpawner,
} from "../../src/index";

/** v0.2.1 uvx Prepare(process/uvx-prepare.ts). 가짜 uvx만 실행한다(network 0, 실제 uv 없음). 실제 uv 검증은 OPENHUB_E2E. */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-uvx-prepare-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const TARGET = { from: "postgres-mcp==0.3.0", withPins: ["mcp==1.30.0"] };
const LAUNCH = ["--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"];

type Behavior = { code?: number; stderr?: string; hang?: boolean };
function fakeUvx(behaviors: Behavior[]) {
  const calls: { args: string[]; env: Record<string, string> | undefined }[] = [];
  const kills: number[] = [];
  const spawner: NpxSpawner = (executable, args, options) => {
    expect(executable).toBe("uvx");
    expect(options.shell).toBe(false);
    calls.push({ args: [...args], env: options.env });
    const b = behaviors[calls.length - 1] ?? {};
    const events = new EventEmitter();
    const stderr = new EventEmitter();
    const child = { pid: 4000 + calls.length, stdout: null, stderr, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => (events.emit("close", null, "SIGKILL"), true) } as unknown as ExecChild;
    if (!b.hang) {
      queueMicrotask(() => {
        if (b.stderr !== undefined) stderr.emit("data", Buffer.from(b.stderr));
        events.emit("close", b.code ?? 0, null);
      });
    }
    return child;
  };
  const killTree = async (pid: number) => (kills.push(pid), true);
  return { calls, kills, spawner, killTree };
}

describe("uvx Prepare 인자", () => {
  it("--from·--with가 모두 정확한 버전일 때만 준비 대상이다", () => {
    expect(uvxPrepareTarget(LAUNCH)).toEqual(TARGET);
    expect(uvxPrepareTarget(["--from", "serena-agent==1.7.0", "serena", "start-mcp-server"])).toEqual({ from: "serena-agent==1.7.0", withPins: [] });
    for (const args of [
      ["postgres-mcp", "--access-mode=restricted"],
      ["postgres-mcp==0.3.0"],
      ["--from", "postgres-mcp", "postgres-mcp"],
      ["--from", "postgres-mcp>=0.3.0", "postgres-mcp"],
      ["--from", "postgres-mcp==0.3.0", "--with", "mcp", "postgres-mcp"],
      ["--from", "postgres-mcp==0.3.0", "--with", "mcp>=1.0", "postgres-mcp"],
      ["--python", "3.12", "--from", "postgres-mcp==0.3.0", "postgres-mcp"],
      ["--from", "postgres-mcp==0.3.0", "--index-url", "https://example.invalid/simple", "postgres-mcp"],
      ["--from", "postgres-mcp==0.3.0"],
    ]) {
      expect(uvxPrepareTarget(args), args.join(" ")).toBeNull();
    }
  });

  it("준비·확인 인자는 고정 형식이고, 바뀐 인자는 해석하지 않는다", () => {
    const wheels = uvxPrepareArgs(TARGET, "wheels-only");
    expect(wheels).toEqual(["--no-build", "--compile-bytecode", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "python", "-c", "pass"]);
    expect(uvxPrepareArgs(TARGET, "source-build-reviewed")[0]).toBe("--compile-bytecode");
    expect(parseUvxPrepareArgs(wheels)).toEqual({ target: TARGET, policy: "wheels-only" });
    expect(parseUvxPrepareArgs(uvxPrepareArgs(TARGET, "source-build-reviewed"))).toEqual({ target: TARGET, policy: "source-build-reviewed" });
    expect(uvxVerifyArgs(TARGET, "wheels-only")).toEqual(["--offline", "--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "python", "-c", "pass"]);
    for (const bad of [
      wheels.filter((a) => a !== "--compile-bytecode"),
      [...wheels.slice(0, -3), "postgres-mcp"],
      [...wheels.slice(0, 2), "--index-url", "https://example.invalid/simple", ...wheels.slice(2)],
      wheels.map((a) => (a === "mcp==1.30.0" ? "mcp" : a)),
      wheels.map((a) => (a === "postgres-mcp==0.3.0" ? "postgres-mcp" : a)),
      [...wheels, "extra"],
    ]) {
      expect(parseUvxPrepareArgs(bad), bad.join(" ")).toBeNull();
    }
  });
});

describe("uv 자식 환경과 index fingerprint", () => {
  it("허용 목록만 넘기고 AI·API key·token·DB 접속 문자열·PYTHONPATH는 넘기지 않는다", () => {
    const env = uvChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      UV_CACHE_DIR: "/cache/uv",
      UV_INDEX_URL: "https://idx.example/simple",
      UV_INDEX_CORP_PASSWORD: "index-pass",
      LC_ALL: "C.UTF-8",
      OPENAI_API_KEY: "sk-test-not-real",
      ANTHROPIC_API_KEY: "x",
      GITHUB_TOKEN: "ghp_x",
      GH_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      DATABASE_URI: "postgresql://probe:probe-not-secret@db:5432/app",
      PYTHONPATH: "/evil",
      PYTHONSTARTUP: "/evil.py",
      NPM_TOKEN: "x",
      UNDEFINED_VALUE: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH", "UV_CACHE_DIR", "UV_INDEX_CORP_PASSWORD", "UV_INDEX_URL"]);
  });

  it("기본 index면 null, 사용자 지정 index면 계정·비밀번호와 무관한 digest, URL이 바뀌면 다른 digest다", () => {
    expect(uvIndexFingerprint({ PATH: "/usr/bin" })).toBeNull();
    const a = uvIndexFingerprint({ UV_INDEX_URL: "https://user:pass-one@idx.example/simple", UV_INDEX_CORP_PASSWORD: "p1" });
    const b = uvIndexFingerprint({ UV_INDEX_URL: "https://user:pass-two@idx.example/simple", UV_INDEX_CORP_PASSWORD: "p2" });
    const c = uvIndexFingerprint({ UV_INDEX_URL: "https://other.example/simple", UV_INDEX_CORP_PASSWORD: "p1" });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(uvIndexFingerprint({ uv_index_url: "https://idx.example/simple" })).toBe(uvIndexFingerprint({ UV_INDEX_URL: "https://idx.example/simple" }));
  });
});

describe("prepareUvxPackage", () => {
  it("성공: 준비 한 번, 네트워크 없는 확인 한 번. 허용 목록 환경만 넘기고 결과에 경로가 없다", async () => {
    const f = fakeUvx([{}, {}]);
    const childEnv = uvChildEnv({ PATH: "/usr/bin", UV_CACHE_DIR: "/cache/uv" });
    const r = await prepareUvxPackage(uvxPrepareArgs(TARGET, "wheels-only"), scratch, { platform: "linux", spawner: f.spawner, killTree: f.killTree, childEnv });
    expect(r).toMatchObject({ id: "uvx-prepare", status: "done" });
    expect(f.calls.map((c) => c.args)).toEqual([uvxPrepareArgs(TARGET, "wheels-only"), uvxVerifyArgs(TARGET, "wheels-only")]);
    expect(f.calls.every((c) => c.env === childEnv)).toBe(true);
    expect(containsAbsolutePath(r.excerpt ?? "")).toBe(false);
  });

  it("wheel이 없으면 UVX_WHEEL_UNAVAILABLE이고 소스 빌드로 자동 전환하지 않는다(빌드 0회, 확인 0회)", async () => {
    const f = fakeUvx([{ code: 2, stderr: "error: Wheels are required for `proxy-tools` because building from source is disabled" }]);
    const r = await prepareUvxPackage(uvxPrepareArgs({ from: "serena-agent==1.7.0", withPins: [] }, "wheels-only"), scratch, { platform: "linux", spawner: f.spawner, killTree: f.killTree });
    expect(r).toMatchObject({ status: "failed", code: "UVX_WHEEL_UNAVAILABLE" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.args[0]).toBe("--no-build");
  });

  it("준비 실패는 STEP_FAILED, 확인 실패는 UVX_PREPARE_VERIFY_FAILED다", async () => {
    const a = fakeUvx([{ code: 1, stderr: "network error" }]);
    expect(await prepareUvxPackage(uvxPrepareArgs(TARGET, "wheels-only"), scratch, { platform: "linux", spawner: a.spawner })).toMatchObject({ status: "failed", code: "STEP_FAILED" });
    expect(a.calls).toHaveLength(1);
    const b = fakeUvx([{}, { code: 2, stderr: "No solution found when resolving tool dependencies (offline)" }]);
    expect(await prepareUvxPackage(uvxPrepareArgs(TARGET, "wheels-only"), scratch, { platform: "linux", spawner: b.spawner })).toMatchObject({ status: "failed", code: "UVX_PREPARE_VERIFY_FAILED" });
  });

  it("시간이 지나면 process tree 종료를 요청하고 종료를 확인한 뒤 STEP_TIMEOUT으로 끝난다", async () => {
    const f = fakeUvx([{ hang: true }]);
    const r = await prepareUvxPackage(uvxPrepareArgs(TARGET, "wheels-only"), scratch, { platform: "linux", spawner: f.spawner, killTree: f.killTree, timeoutMs: 200, graceMs: 500 });
    expect(r).toMatchObject({ status: "failed", code: "STEP_TIMEOUT" });
    expect(f.kills).toEqual([4001]);
  });

  it("고정 형식이 아니면 실행하지 않는다(UVX_PREPARE_REJECTED, spawn 0)", async () => {
    const f = fakeUvx([]);
    const r = await prepareUvxPackage(["--from", "postgres-mcp", "python", "-c", "pass"], scratch, { platform: "linux", spawner: f.spawner });
    expect(r).toMatchObject({ status: "failed", code: "UVX_PREPARE_REJECTED" });
    expect(f.calls).toHaveLength(0);
  });

  it("timeout은 10분을 넘지 않는다", async () => {
    const f = fakeUvx([{}, {}]);
    expect(await prepareUvxPackage(uvxPrepareArgs(TARGET, "wheels-only"), scratch, { platform: "linux", spawner: f.spawner, timeoutMs: 3_600_000 })).toMatchObject({ status: "done" });
  });
});
