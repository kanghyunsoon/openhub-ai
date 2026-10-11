import { readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUNDLED_METADATA_SNAPSHOT, OPENHUB_CORE_VERSION, USER_METADATA_CACHE } from "@openhub/core";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";

/**
 * TASK-071 CLI 배포 경로. 패키지와 같은 배치(registry 리소스 + 포함 snapshot)를 임시 디렉터리에 만들고
 * 저장소 밖 cwd에서 실행한다(in-process, network 0). 실제 tgz 설치 smoke는 test/packaging.test.ts다.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
/** registry/<category>/<name>.yaml Manifest 수(v0.2.0 P0-2부터 묶음마다 늘어나므로 숫자를 박지 않는다). */
const REGISTRY_MANIFEST_COUNT = readdirSync(path.join(REPO, "registry"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(path.join(REPO, "registry", d.name)).filter((f) => f.endsWith(".yaml"))).length;
const SEED = path.join(REPO, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-packaging-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function installedLayout() {
  const base = await mkdtemp(path.join(scratch, "pkg-"));
  const registry = path.join(base, "dist", "registry");
  await cp(path.join(REPO, "registry"), registry, { recursive: true });
  await cp(SEED, path.join(registry, BUNDLED_METADATA_SNAPSHOT));
  const cwd = path.join(base, "elsewhere");
  const home = path.join(base, "home");
  await mkdir(cwd);
  await mkdir(home);
  const io = Object.assign(memoryIO(cwd), { registryDir: registry, registrySource: "설치 패키지의 registry", homeDir: home });
  return { base, registry, cwd, home, io };
}

describe("REQ-065 TASK-071 CLI 배포", () => {
  it("AC-071-01 core·cli·desktop 버전이 0.2.0이고 --version은 0.2.0이다", async () => {
    expect(OPENHUB_CORE_VERSION).toBe("0.2.0");
    for (const f of ["packages/core/package.json", "apps/cli/package.json", "apps/desktop/package.json"]) {
      expect((JSON.parse(await readFile(path.join(REPO, f), "utf8")) as { version: string }).version, f).toBe("0.2.0");
    }
    const io = memoryIO(scratch);
    io.version = OPENHUB_CORE_VERSION;
    expect(await runCli(["--version"], io)).toBe(0);
    expect(io.stdout).toEqual(["0.2.0"]);
  });

  it("AC-071-03 저장소 밖 cwd에서 패키지 리소스 Registry로 registry list·project scan·doctor가 동작한다", async () => {
    const { io } = await installedLayout();
    expect(await runCli(["registry", "list", "--json"], io)).toBe(0);
    expect((JSON.parse(io.stdout.join("\n")) as unknown[]).length).toBe(REGISTRY_MANIFEST_COUNT);
    io.stdout.length = 0;
    expect(await runCli(["project", "scan", path.join(REPO, "packages/core/test/fixtures/projects/react-spring-monorepo"), "--json"], io)).toBe(0);
    expect(JSON.parse(io.stdout.join("\n"))).toMatchObject({ schemaVersion: expect.any(Number) });
    io.stdout.length = 0;
    expect(await runCli(["doctor", "--json"], io)).toBe(0);
    const doc = JSON.parse(io.stdout.join("\n")) as { registry: { source: string; manifests: number }; metadata: { source: string; collectedAt: string | null } };
    expect(doc.registry).toMatchObject({ source: "설치 패키지의 registry", manifests: REGISTRY_MANIFEST_COUNT });
    expect(doc.metadata.source).toContain("포함 snapshot");
    expect(doc.metadata.collectedAt).not.toBeNull();
    expect(io.stdout.join("\n")).not.toContain(scratch);
  });

  // 전체 테스트 병렬 실행에서 collect·doctor 두 번이 기본 5초를 넘을 수 있어 Vitest 제한 시간만 30초로 둔다(TASK-072).
  it("AC-071-05 손상된 ~/.openhub/cache는 경고 후 무시하고 collect 기본 출력은 ~/.openhub/cache/metadata.json이다", { timeout: 30_000 }, async () => {
    const { io, home } = await installedLayout();
    await mkdir(path.dirname(path.join(home, USER_METADATA_CACHE)), { recursive: true });
    await writeFile(path.join(home, USER_METADATA_CACHE), "{ broken");
    expect(await runCli(["doctor", "--json"], io)).toBe(0);
    expect(io.stderr.join("\n")).toContain("손상");
    expect((JSON.parse(io.stdout.join("\n")) as { metadata: { source: string } }).metadata.source).toContain("포함 snapshot");
    io.stdout.length = 0;
    io.stderr.length = 0;
    io.resolveToken = async () => undefined;
    io.fetch = async (url) => {
      const repo = /repos\/([^/]+\/[^/?]+)/u.exec(String(url))?.[1] ?? "x/y";
      if (String(url).endsWith("/releases/latest")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ full_name: repo, description: null, stargazers_count: 5, forks_count: 0, pushed_at: null, archived: false, license: null, topics: [] }), { status: 200 });
    };
    expect(await runCli(["collect", "--no-token"], io)).toBe(0);
    expect(io.stdout.at(-1)).toContain("~/.openhub/cache/metadata.json");
    expect(JSON.parse(await readFile(path.join(home, USER_METADATA_CACHE), "utf8"))).toMatchObject({ version: 1 });
    io.stdout.length = 0;
    expect(await runCli(["doctor", "--json"], io)).toBe(0);
    expect((JSON.parse(io.stdout.join("\n")) as { metadata: { source: string } }).metadata.source).toBe("~/.openhub/cache/metadata.json");
  });
});
