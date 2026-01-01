import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDED_DIRECTORIES, DEFAULT_SCAN_LIMITS, containsAbsolutePath, scanProject, type ProjectScanContext } from "../src/index";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "openhub-scan-"));
  root = path.join(base, "my-app");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.json"), '{"token":"OUTSIDE_SECRET_VALUE"}');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

async function scan(limits?: Parameters<typeof scanProject>[1]): Promise<ProjectScanContext> {
  const r = await scanProject(root, limits);
  if (!r.ok) throw new Error(r.error.code);
  return r.context;
}

describe("REQ-010 Safe Project Scanner", () => {
  it("AC-009-01 대형·생성 디렉터리는 제외하고 .github·.claude·.codex·.cursor는 포함한다", async () => {
    await put("package.json", "{}");
    for (const dir of DEFAULT_EXCLUDED_DIRECTORIES) await put(`${dir}/package.json`, "{}");
    await put("apps/web/node_modules/react/package.json", "{}");
    for (const dir of [".github/workflows", ".claude", ".codex", ".cursor"]) await put(`${dir}/x.json`, "{}");
    const ctx = await scan();
    expect(ctx.files).toEqual([".claude/x.json", ".codex/x.json", ".cursor/x.json", ".github/workflows/x.json", "package.json"]);
    expect(ctx.rootExcluded).toEqual([...DEFAULT_EXCLUDED_DIRECTORIES].sort());
    expect(ctx.projectName).toBe("my-app");
  });

  it("AC-009-02 Root 밖 경로 읽기 요청은 거부되고 경고만 남는다", async () => {
    await put("package.json", "{}");
    const ctx = await scan();
    expect(await ctx.readText("../outside/secret.json")).toBeUndefined();
    expect(await ctx.readText(path.join(outside, "secret.json"))).toBeUndefined();
    expect(await ctx.readText("not-listed.json")).toBeUndefined();
    expect(ctx.warnings.filter((w) => w.code === "path-outside-root")).toHaveLength(2);
    expect(JSON.stringify(ctx.warnings)).not.toContain("OUTSIDE_SECRET_VALUE");
  });

  it("AC-009-03 Root 밖을 가리키는 junction·symlink는 따라가지 않고 경고로 남긴다", async (t) => {
    await put("package.json", "{}");
    await symlink(outside, path.join(root, "escape-dir"), "junction");
    let fileLink = true;
    try {
      await symlink(path.join(outside, "secret.json"), path.join(root, "escape.json"), "file");
    } catch {
      fileLink = false; // Windows에서 파일 symlink는 개발자 모드·관리자 권한이 필요하다.
    }
    const ctx = await scan();
    expect(ctx.files).toEqual(["package.json"]);
    const escaped = ctx.warnings.filter((w) => w.code === "symlink-outside-root").map((w) => w.file);
    expect(escaped).toContain("escape-dir");
    if (fileLink) expect(escaped).toContain("escape.json");
    else t.annotate("파일 symlink 생성 권한이 없어 junction만 검증했습니다");
    expect(JSON.stringify(ctx.warnings)).not.toMatch(/OUTSIDE_SECRET_VALUE/u);
    for (const w of ctx.warnings) expect(containsAbsolutePath(w.message)).toBe(false);
  });

  it("AC-009-04 비밀 파일은 목록에서 빠지고 내용을 읽지 않는다", async () => {
    const secrets = [".env", ".env.local", "server.pem", "tls.key", "cert.p12", "cert.pfx", "id_rsa", "id_ed25519.pub", ".npmrc", ".pypirc", ".netrc", "config/.env.production"];
    for (const s of secrets) await put(s, "TOKEN=FAKE_SECRET_DO_NOT_READ");
    await put("package.json", "{}");
    const ctx = await scan();
    expect(ctx.files).toEqual(["package.json"]);
    for (const s of secrets) expect(await ctx.readText(s)).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain("FAKE_SECRET_DO_NOT_READ");
  });

  it("AC-009-05 파싱 오류는 { file, code, message } 경고로 남고 원문을 담지 않으며 다른 파일은 계속 읽힌다", async () => {
    await put("package.json", '{"name": "x", "apiKey": "LEAKY_SECRET_123", }');
    await put("pyproject.toml", 'name = "x"\napi_key = "LEAKY_SECRET_456"\n[[[');
    await put("pom.xml", "<project><secret>LEAKY_SECRET_789</secret>");
    await put("compose.yml", "services:\n  db: [unclosed");
    await put("ok.json", '{"fine": true}');
    const ctx = await scan();
    expect(await ctx.readJson("package.json")).toBeUndefined();
    expect(await ctx.readToml("pyproject.toml")).toBeUndefined();
    expect(await ctx.readXml("pom.xml")).toBeUndefined();
    expect(await ctx.readYaml("compose.yml")).toBeUndefined();
    expect(await ctx.readJson("ok.json")).toEqual({ fine: true });
    expect(await ctx.readJson("package.json")).toBeUndefined(); // 캐시: 경고 중복 없음
    const parseWarnings = ctx.warnings.filter((w) => w.code === "parse-failed");
    expect(parseWarnings.map((w) => w.file).sort()).toEqual(["compose.yml", "package.json", "pom.xml", "pyproject.toml"]);
    expect(JSON.stringify(ctx.warnings)).not.toMatch(/LEAKY_SECRET/u);
  });

  it("AC-009-05 TOML·XML·YAML·JSON 파서는 구조를 돌려준다(BOM 제거 포함)", async () => {
    await put("Cargo.toml", '[package]\nname = "demo"\n');
    await put("pom.xml", '<project><dependencies><dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency></dependencies></project>');
    await put("app.csproj", '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Npgsql" Version="8.0.0" /></ItemGroup></Project>');
    await put("compose.yaml", "services:\n  db:\n    image: postgres:16\n");
    await put("bom.json", "\uFEFF{\"a\":1}");
    const ctx = await scan();
    expect(await ctx.readToml("Cargo.toml")).toEqual({ package: { name: "demo" } });
    expect(await ctx.readXml("pom.xml")).toMatchObject({ project: { dependencies: { dependency: { groupId: "org.postgresql", artifactId: "postgresql" } } } });
    expect(await ctx.readXml("app.csproj")).toMatchObject({ Project: { "@_Sdk": "Microsoft.NET.Sdk", ItemGroup: { PackageReference: { "@_Include": "Npgsql" } } } });
    expect(await ctx.readYaml("compose.yaml")).toEqual({ services: { db: { image: "postgres:16" } } });
    expect(await ctx.readJson("bom.json")).toEqual({ a: 1 });
  });

  it("AC-009-06 깊이·항목 수·파일 크기 상한을 넘으면 부분 결과와 scan-limit 경고를 돌려준다", async () => {
    expect(DEFAULT_SCAN_LIMITS).toEqual({ maxDepth: 8, maxEntries: 20000, maxFileBytes: 1048576 });
    await put("a/b/c/deep.json", "{}");
    await put("a/shallow.json", "{}");
    const deep = await scan({ limits: { maxDepth: 2 } });
    expect(deep.files).toEqual(["a/shallow.json"]);
    expect(deep.warnings.some((w) => w.code === "scan-limit" && w.file === "a/b/c")).toBe(true);

    for (let i = 0; i < 10; i++) await put(`many/f${i}.json`, "{}");
    const capped = await scan({ limits: { maxEntries: 5 } });
    expect(capped.files.length).toBeLessThan(5);
    expect(capped.warnings.some((w) => w.code === "scan-limit")).toBe(true);

    await put("big.json", JSON.stringify({ data: "x".repeat(2000) }));
    const small = await scan({ limits: { maxFileBytes: 1000 } });
    expect(await small.readJson("big.json")).toBeUndefined();
    expect(small.warnings).toContainEqual(expect.objectContaining({ code: "scan-limit", file: "big.json" }));
  });

  it("AC-009-07 Scanner·Analyzer 코드는 프로세스 실행과 네트워크 호출을 하지 않는다", async () => {
    const dir = path.resolve(import.meta.dirname, "../src/analyzer");
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else files.push(path.join(d, e.name));
      }
    };
    await walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(await readFile(f, "utf8"), f).not.toMatch(/child_process|node:http|node:https|node:net|node:dgram|\bfetch\(|XMLHttpRequest|WebSocket/u);
    }
  });

  it("AC-009-08 Root가 없거나 디렉터리가 아니면 오류 결과를 돌려준다", async () => {
    await put("file.txt", "x");
    const missing = await scanProject(path.join(base, "nope"));
    const notDir = await scanProject(path.join(root, "file.txt"));
    expect(missing).toEqual({ ok: false, error: { code: "root-not-found", message: expect.any(String) } });
    expect(notDir).toEqual({ ok: false, error: { code: "root-not-directory", message: expect.any(String) } });
    if (!missing.ok) expect(containsAbsolutePath(missing.error.message)).toBe(false);
  });
});

