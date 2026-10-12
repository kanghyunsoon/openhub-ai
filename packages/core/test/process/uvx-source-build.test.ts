import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  prepareUvxPackage,
  uvChildEnv,
  uvConfigCandidates,
  uvSourceSettings,
  uvxPrepareArgs,
  type ExecChild,
  type NpxSpawner,
  type UvConfigReader,
} from "../../src/index";

/**
 * v0.2.1 #45: 검토된 소스 빌드 일시 차단과 uv 설정(uv.toml) 확인. 가짜 uvx만 쓴다(network 0, 실제 uv 0).
 * 차단 이유(uvx가 constraints·build-constraints·with-requirements hash를 확인하지 않음)의 실제 uv 재현은 registry/uvx-prepare.e2e.test.ts.
 */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-uvx-source-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe("검토된 소스 빌드: 일시 차단(fail-closed)", () => {
  it("source-build-reviewed 준비 단계는 어떤 입력에서도 실행하지 않는다(UVX_SOURCE_BUILD_DISABLED, spawn 0, network 0)", async () => {
    const spawns: string[][] = [];
    const spawner: NpxSpawner = (executable, args) => {
      spawns.push([executable, ...args]);
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("close", 0, null));
      return { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
    };
    const fetched: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string) => (fetched.push(String(url)), new Response("x"))) as typeof fetch;
    try {
      for (const target of [{ from: "serena-agent==1.7.0", withPins: [] }, { from: "serena-agent==1.7.0", withPins: ["docopt==0.6.2"] }]) {
        const r = await prepareUvxPackage(uvxPrepareArgs(target, "source-build-reviewed"), scratch, { platform: "linux", spawner, childEnv: {}, readUvConfig: async () => null });
        expect(r).toMatchObject({ status: "failed", code: "UVX_SOURCE_BUILD_DISABLED" });
        expect(r.excerpt).toContain("설정 파일은 바꾸지 않았습니다");
      }
    } finally {
      globalThis.fetch = saved;
    }
    expect(spawns).toEqual([]);
    expect(fetched).toEqual([]);
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
