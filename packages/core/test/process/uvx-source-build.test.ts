import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  builtPackages,
  containsAbsolutePath,
  prepareUvxPackage,
  unbuildablePackage,
  uvChildEnv,
  uvConfigCandidates,
  uvSourceSettings,
  uvxPrepareArgs,
  uvxVerifyArgs,
  type ExecChild,
  type NpxSpawner,
  type UvConfigReader,
} from "../../src/index";

/**
 * v0.2.1 #45: 검토된 소스 빌드 허용 목록 강제와 uv 설정(uv.toml) 확인. 가짜 uv·uvx·fetch만 쓴다(network 0, 실제 uv 0).
 * 실제 uv 확인은 OPENHUB_E2E(uvx-prepare.e2e.test.ts)와 PR 본문의 Windows·Linux 실행 기록이다.
 */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-uvx-source-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const SERENA = { from: "serena-agent==1.7.0", withPins: [] as string[] };
const SDIST = Buffer.from("proxy-tools 0.1.0 sdist bytes (synthetic)");
const SHA = createHash("sha256").update(SDIST).digest("hex");
const ENTRY = { package: "proxy-tools", version: "0.1.0", sha256: SHA };
const FILE_URL = "https://files.pythonhosted.org/packages/aa/bb/proxy_tools-0.1.0.tar.gz";
const ENV_LIST = "proxy-tools==0.1.0\nserena-agent==1.7.0\nsensai-utils==1.5.0\nmcp==1.30.0\n";
const BT = "\x60";

type Reply = { code?: number; stdout?: string; stderr?: string; wheel?: string };
type Handler = (executable: string, args: readonly string[]) => Reply;

function fakeUv(handler: Handler) {
  const calls: { executable: string; args: string[]; env: Record<string, string> | undefined }[] = [];
  const spawner: NpxSpawner = (executable, args, options) => {
    expect(options.shell).toBe(false);
    calls.push({ executable, args: [...args], env: options.env });
    const reply = handler(executable, args);
    const events = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    void (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (reply.wheel !== undefined) await writeFile(path.join(args[3]!, reply.wheel), "wheel");
      if (reply.stdout !== undefined) stdout.emit("data", Buffer.from(reply.stdout));
      if (reply.stderr !== undefined) stderr.emit("data", Buffer.from(reply.stderr));
      events.emit("close", reply.code ?? 0, null);
    })();
    return { pid: 5000 + calls.length, stdout, stderr, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
  };
  return { calls, spawner };
}

/** 정상 경로: uv build는 검토 wheel, wheel만 확인은 전체 목록, 소스 빌드 단계는 proxy-tools만 빌드했다고 알린다. */
const happy: Handler = (executable, args) => {
  if (executable === "uv") return { wheel: "proxy_tools-0.1.0-py3-none-any.whl" };
  if (args[0] === "--no-build" && args[1] === "--find-links") return { stdout: ENV_LIST };
  if (args[0] === "--compile-bytecode") return { stderr: "Resolved 4 packages\n   Built proxy-tools==0.1.0\nInstalled 4 packages\n" };
  return {};
};

function fakeFetch(opts: { jsonSha?: string; url?: string; bytes?: Buffer; fail?: "json" | "file" } = {}) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://pypi.org/pypi/")) {
      if (opts.fail === "json") throw new Error("offline");
      const body = JSON.stringify({
        urls: [
          { packagetype: "bdist_wheel", filename: "other.whl", url: "https://files.pythonhosted.org/x.whl", digests: { sha256: "0".repeat(64) } },
          { packagetype: "sdist", filename: "proxy_tools-0.1.0.tar.gz", url: opts.url ?? FILE_URL, digests: { sha256: opts.jsonSha ?? SHA } },
        ],
      });
      return new Response(body, { status: 200 });
    }
    if (opts.fail === "file") throw new Error("offline");
    return new Response(new Uint8Array(opts.bytes ?? SDIST), { status: 200 });
  };
  return { urls, fetch };
}

const noConfig: UvConfigReader = async () => null;
let seq = 0;
function run(handler: Handler, extra: Record<string, unknown> = {}, fetchOpts: Parameters<typeof fakeFetch>[0] = {}) {
  const uv = fakeUv(handler);
  const f = fakeFetch(fetchOpts);
  const cwd = path.join(scratch, "run-" + String(++seq));
  const result = (async () => {
    await mkdir(cwd, { recursive: true });
    return prepareUvxPackage(uvxPrepareArgs(SERENA, "source-build-reviewed"), cwd, { platform: "linux", spawner: uv.spawner, fetch: f.fetch, readUvConfig: noConfig, sourceBuild: [ENTRY], childEnv: {}, ...extra });
  })();
  return { uv, f, result };
}

describe("검토된 소스 빌드: 허용 목록 강제", () => {
  it("성공: sha256 확인 → 검토 sdist만 빌드 → wheel만으로 전체 목록 확인 → 목록 밖 전부 --no-build-package → 오프라인 확인", async () => {
    const t = run(happy);
    const r = await t.result;
    expect(r).toMatchObject({ status: "done" });
    expect(t.f.urls).toEqual(["https://pypi.org/pypi/proxy-tools/0.1.0/json", FILE_URL]);
    expect(t.uv.calls.map((c) => [c.executable, c.args[0], c.args[1]])).toEqual([
      ["uv", "build", "--wheel"],
      ["uvx", "--no-build", "--find-links"],
      ["uvx", "--compile-bytecode", "--constraints"],
      ["uvx", "--offline", "--from"],
    ]);
    const phaseB = t.uv.calls[2]!.args;
    const blocked = phaseB.flatMap((a, i) => (a === "--no-build-package" ? [phaseB[i + 1]!] : []));
    expect(blocked.sort()).toEqual(["mcp", "sensai-utils", "serena-agent"]);
    expect(t.uv.calls[3]!.args).toEqual(uvxVerifyArgs(SERENA, "source-build-reviewed"));
    expect(r.excerpt).toContain("proxy-tools==0.1.0");
    expect(containsAbsolutePath(r.excerpt ?? "")).toBe(false);
  });

  it("실패 재현(이전 동작): 검토 목록 없는 소스 빌드 단계는 실행하지 않는다(spawn 0, fetch 0)", async () => {
    const t = run(happy, { sourceBuild: undefined });
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_PREPARE_REJECTED" });
    expect(t.uv.calls).toEqual([]);
    expect(t.f.urls).toEqual([]);
  });

  it("PyPI의 sdist sha256이 검토 값과 다르면 내려받지도 빌드하지도 않는다", async () => {
    const t = run(happy, {}, { jsonSha: "f".repeat(64) });
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_UNVERIFIED" });
    expect(t.uv.calls).toEqual([]);
    expect(t.f.urls).toHaveLength(1);
  });

  it("내려받은 파일 sha256이 다르면 빌드하지 않는다", async () => {
    const t = run(happy, {}, { bytes: Buffer.from("tampered") });
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_UNVERIFIED" });
    expect(t.uv.calls).toEqual([]);
  });

  it("파일 URL이 files.pythonhosted.org가 아니면 받지 않는다", async () => {
    const t = run(happy, {}, { url: "https://evil.example/proxy_tools-0.1.0.tar.gz" });
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_UNVERIFIED" });
    expect(t.f.urls).toHaveLength(1);
    expect(t.uv.calls).toEqual([]);
  });

  it("네트워크 실패는 UVX_SOURCE_UNVERIFIED이고 빌드 0이다", async () => {
    for (const fail of ["json", "file"] as const) {
      const t = run(happy, {}, { fail });
      expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_UNVERIFIED" });
      expect(t.uv.calls).toEqual([]);
    }
  });

  it("검토 목록 밖 패키지가 소스 빌드를 요구하면 그 패키지를 빌드하지 않고 멈춘다(소스 빌드 단계 0회)", async () => {
    for (const stderr of [
      "  x No solution found when resolving tool dependencies:\n  Because docopt==0.6.2 has no usable wheels and building from source is disabled, we can conclude that ...",
      "error: Wheels are required for " + BT + "docopt" + BT + " because building from source is disabled",
    ]) {
      const t = run((exe, args) => (exe === "uvx" && args[0] === "--no-build" ? { code: 1, stderr } : happy(exe, args)));
      const r = await t.result;
      expect(r).toMatchObject({ status: "failed", code: "UVX_UNREVIEWED_SOURCE_BUILD" });
      expect(r.excerpt).toContain("docopt");
      expect(t.uv.calls.map((c) => c.args[0])).toEqual(["build", "--no-build"]);
    }
  });

  it("uv build가 검토 목록과 다른 wheel을 만들면 실패한다", async () => {
    const t = run((exe, args) => (exe === "uv" ? { wheel: "proxy_tools-0.2.0-py3-none-any.whl" } : happy(exe, args)));
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_MISMATCH" });
    expect(t.uv.calls).toHaveLength(1);
  });

  it("검토 목록의 패키지가 실제 환경에 없으면 실패한다(목록과 Manifest 불일치)", async () => {
    const t = run((exe, args) => (exe === "uvx" && args[0] === "--no-build" ? { stdout: "serena-agent==1.7.0\nmcp==1.30.0\n" } : happy(exe, args)));
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_MISMATCH" });
  });

  it("소스 빌드 단계에서 uv가 목록 밖 패키지를 빌드했다고 알리면 실패하고 오프라인 확인으로 넘어가지 않는다", async () => {
    const t = run((exe, args) => (exe === "uvx" && args[0] === "--compile-bytecode" ? { stderr: "   Built proxy-tools==0.1.0\n   Built docopt==0.6.2\n" } : happy(exe, args)));
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_MISMATCH" });
    expect(t.uv.calls.some((c) => c.args[0] === "--offline")).toBe(false);
  });

  it("사용자 지정 index(환경변수·uv.toml)가 있으면 실행 직전에 막는다(fetch 0, spawn 0)", async () => {
    const a = run(happy, { childEnv: { UV_INDEX_URL: "https://idx.example/simple" } });
    expect(await a.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_CUSTOM_INDEX" });
    expect(a.uv.calls).toEqual([]);
    expect(a.f.urls).toEqual([]);
    const reader: UvConfigReader = async (file) => (file === "/home/u/.config/uv/uv.toml" ? '[[index]]\nurl = "https://idx.example/simple"\ndefault = true\n' : null);
    const b = run(happy, { childEnv: { HOME: "/home/u" }, readUvConfig: reader });
    expect(await b.result).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_CUSTOM_INDEX" });
    expect(b.uv.calls).toEqual([]);
  });

  it("uv 설정 파일을 읽지 못하면 소스 빌드를 하지 않는다", async () => {
    const t = run(happy, { childEnv: { HOME: "/home/u" }, readUvConfig: async () => "not = [valid" });
    expect(await t.result).toMatchObject({ status: "failed", code: "UVX_CONFIG_UNSUPPORTED" });
    expect(t.uv.calls).toEqual([]);
  });

  it("출력 해석: Built 줄과 wheel 없음 메시지", () => {
    expect(builtPackages("Resolved 3 packages\n   Built Proxy_Tools==0.1.0\nPrepared 3 packages")).toEqual(["proxy-tools==0.1.0"]);
    expect(builtPackages("Building proxy-tools==0.1.0\n")).toEqual([]);
    expect(unbuildablePackage("Because docopt==0.6.2 has no usable wheels and building")).toBe("docopt");
    expect(unbuildablePackage("Wheels are required for " + BT + "x-y" + BT + " because")).toBe("x-y");
    expect(unbuildablePackage("network error")).toBeNull();
  });
});

describe("uv 설정 파일(uv.toml)", () => {
  const files =
    (map: Record<string, string>): UvConfigReader =>
    async (file) =>
      map[file.split("\\").join("/")] ?? null;
  const userToml = (body: string) => uvSourceSettings({ HOME: "/home/u" }, "linux", files({ "/home/u/.config/uv/uv.toml": body }));

  it("읽는 위치: Windows는 APPDATA·PROGRAMDATA, 그 밖은 XDG_CONFIG_HOME(~/.config)·XDG_CONFIG_DIRS·/etc. UV_CONFIG_FILE도 읽는다", () => {
    expect(uvConfigCandidates({ APPDATA: "C:\\U\\AppData\\Roaming", PROGRAMDATA: "C:\\ProgramData" }, "windows").map((c) => c.file)).toEqual(["C:\\U\\AppData\\Roaming\\uv\\uv.toml", "C:\\ProgramData\\uv\\uv.toml"]);
    expect(uvConfigCandidates({ HOME: "/home/u" }, "linux").map((c) => c.file)).toEqual(["/home/u/.config/uv/uv.toml", "/etc/uv/uv.toml"]);
    expect(uvConfigCandidates({ HOME: "/home/u", XDG_CONFIG_HOME: "/x", XDG_CONFIG_DIRS: "/a:/b", UV_CONFIG_FILE: "/c/uv.toml" }, "macos").map((c) => c.file)).toEqual([
      "/c/uv.toml",
      "/x/uv/uv.toml",
      "/a/uv/uv.toml",
      "/b/uv/uv.toml",
      "/etc/uv/uv.toml",
    ]);
  });

  it("uvChildEnv는 설정 파일 선택 변수(UV_CONFIG_FILE·UV_NO_CONFIG·XDG_CONFIG_DIRS)를 Client와 같게 넘긴다", () => {
    expect(Object.keys(uvChildEnv({ UV_CONFIG_FILE: "/c", UV_NO_CONFIG: "1", XDG_CONFIG_DIRS: "/a", OPENAI_API_KEY: "sk-x" })).sort()).toEqual(["UV_CONFIG_FILE", "UV_NO_CONFIG", "XDG_CONFIG_DIRS"]);
  });

  it("설정이 없거나 출처와 무관한 키(cache-dir 등)만 있으면 fingerprint null(기존 Plan과 같다)", async () => {
    expect(await uvSourceSettings({ HOME: "/home/u" }, "linux", files({}))).toEqual({ fingerprint: null, customIndex: false, unsupported: null });
    expect(await userToml('cache-dir = "/c"\nnative-tls = true\n')).toEqual({ fingerprint: null, customIndex: false, unsupported: null });
  });

  it("index·find-links·constraint 같은 설정은 customIndex이고, 계정·비밀번호만 바뀌면 fingerprint가 같고 URL이 바뀌면 다르다", async () => {
    const a = await userToml('[[index]]\nname = "corp"\nurl = "https://ci-user:Secret-One@idx.example/simple"\ndefault = true\n');
    const b = await userToml('[[index]]\nname = "corp"\nurl = "https://ci-user:Secret-Two@idx.example/simple"\ndefault = true\n');
    const c = await userToml('[[index]]\nname = "corp"\nurl = "https://other.example/simple"\ndefault = true\n');
    expect(a.customIndex).toBe(true);
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    for (const body of ['find-links = ["https://f.example/"]', 'constraint-dependencies = ["mcp<1.30"]', "no-index = true", '[pip]\nindex-url = "https://idx.example/simple"', 'future-uv-key = "x"']) {
      expect((await userToml(body)).customIndex, body).toBe(true);
    }
    expect((await uvSourceSettings({ HOME: "/home/u" }, "linux", files({ "/etc/uv/uv.toml": 'index-url = "https://idx.example/simple"' }))).customIndex).toBe(true);
    expect((await uvSourceSettings({ APPDATA: "C:/U/AppData/Roaming" }, "windows", files({ "C:/U/AppData/Roaming/uv/uv.toml": 'index-url = "https://idx.example/simple"' }))).customIndex).toBe(true);
  });

  it("password·token 같은 이름의 키 값은 fingerprint에 들어가지 않는다", async () => {
    const at = (v: string) => userToml('index-url = "https://idx.example/simple"\n[extra]\napi-token = "' + v + '"\n');
    expect((await at("one")).fingerprint).toBe((await at("two")).fingerprint);
  });

  it("TOML이 아니거나 읽을 수 없으면 unsupported(값을 결과에 남기지 않는다)", async () => {
    const bad = await userToml('index-url = "https://u:Pass-X@idx');
    expect(bad.unsupported).toMatch(/TOML/u);
    expect(JSON.stringify(bad)).not.toContain("Pass-X");
    const denied = await uvSourceSettings({ HOME: "/home/u" }, "linux", async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(denied.unsupported).not.toBeNull();
  });

  it("환경변수 index도 본다(UV_NO_CONFIG는 fingerprint에 들어간다)", async () => {
    expect((await uvSourceSettings({ UV_INDEX_URL: "https://idx.example/simple" }, "linux", files({}))).customIndex).toBe(true);
    const off = await uvSourceSettings({ UV_NO_CONFIG: "1" }, "linux", files({}));
    expect(off.customIndex).toBe(false);
    expect(off.fingerprint).not.toBeNull();
  });
});

