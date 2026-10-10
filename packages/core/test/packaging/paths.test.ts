import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUNDLED_METADATA_SNAPSHOT,
  USER_METADATA_CACHE,
  USER_METADATA_CACHE_LOGICAL,
  checkBundledSnapshot,
  loadRegistry,
  resolveMetadataFile,
  resolveMetadataFileSync,
  resolveRegistryDir,
} from "../../src/index";
import { registryManifestCount } from "../recommendation/helpers";

/** TASK-071 배포 경로 규칙(D-036 §12). 임시 디렉터리만 쓴다(실제 home·network 0). */
const REPO = path.resolve(import.meta.dirname, "../../../..");
const SEED = path.join(REPO, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-paths-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const read = (rel: string) => readFile(path.join(REPO, rel), "utf8");

async function layout(opts: { cache?: string; bundled?: boolean }) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const home = path.join(base, "home");
  const registry = path.join(base, "registry");
  await mkdir(registry, { recursive: true });
  if (opts.cache !== undefined) {
    await mkdir(path.dirname(path.join(home, USER_METADATA_CACHE)), { recursive: true });
    await writeFile(path.join(home, USER_METADATA_CACHE), opts.cache);
  }
  if (opts.bundled === true) await cp(SEED, path.join(registry, BUNDLED_METADATA_SNAPSHOT));
  return { home, registry };
}

describe("REQ-065 TASK-071 배포 경로", () => {
  it("AC-071-04 Registry는 명시 옵션 > 환경변수 > 패키지 리소스 > 개발 fallback 순서이고 repository root 가정 코드가 없다", async () => {
    const resource = await mkdtemp(path.join(scratch, "res-"));
    expect(resolveRegistryDir({ explicit: "/x/opt", env: "/x/env", resource, fallback: "/x/fb" })).toEqual({ dir: "/x/opt", source: "option" });
    expect(resolveRegistryDir({ env: "/x/env", resource, fallback: "/x/fb" })).toEqual({ dir: "/x/env", source: "env" });
    expect(resolveRegistryDir({ env: "", resource, fallback: "/x/fb" })).toEqual({ dir: resource, source: "resource" });
    expect(resolveRegistryDir({ resource: path.join(resource, "missing"), fallback: "/x/fb" })).toEqual({ dir: "/x/fb", source: "fallback" });
    for (const f of ["apps/cli/src/main.ts", "apps/desktop/src/main.ts"]) {
      const src = await read(f);
      // 앱 자체 파일(dist → renderer)은 괜찮고, 저장소 루트까지 올라가는 경로·repoRoot 변수가 없어야 한다.
      expect(src, f).not.toMatch(/\.\.\/\.\.\/\.\.|repoRoot/u);
      expect(src, f).toContain("resolveRegistryDir(");
    }
    expect(await read("apps/cli/src/main.ts")).toContain('resource: path.join(here, "registry")');
    expect(await read("apps/desktop/src/main.ts")).toContain('app.isPackaged ? path.join(process.resourcesPath, "registry")');
    for (const f of ["apps/cli/src/discover.ts", "apps/cli/src/install.ts", "apps/cli/src/lifecycle.ts", "apps/cli/src/m7.ts", "apps/cli/src/pinokio.ts", "apps/cli/src/recommend.ts", "apps/cli/src/release.ts", "apps/cli/src/cli.ts"]) {
      expect(await read(f), f).not.toMatch(/path\.resolve\(io\.cwd, (values\.dir \?\? )?"registry"|DEFAULT_METADATA_CACHE\)\)/u);
    }
  });

  it("AC-071-05 metadata는 명시 > ~/.openhub/cache > 포함 snapshot 순서이고 손상 cache는 경고 후 무시한다", async () => {
    const valid = await readFile(SEED, "utf8");
    const both = await layout({ cache: valid, bundled: true });
    expect(await resolveMetadataFile({ explicit: "/x/meta.json", homeDir: both.home, registryDir: both.registry })).toMatchObject({ file: "/x/meta.json", source: "option" });
    expect(await resolveMetadataFile({ homeDir: both.home, registryDir: both.registry })).toMatchObject({ file: path.join(both.home, USER_METADATA_CACHE), source: "user-cache", label: USER_METADATA_CACHE_LOGICAL, warnings: [] });
    const corrupt = await layout({ cache: "{ not json", bundled: true });
    const c = resolveMetadataFileSync({ homeDir: corrupt.home, registryDir: corrupt.registry });
    expect(c).toMatchObject({ file: path.join(corrupt.registry, BUNDLED_METADATA_SNAPSHOT), source: "bundled" });
    expect(c.warnings).toEqual([expect.stringContaining("손상")]);
    const none = await layout({});
    expect(await resolveMetadataFile({ homeDir: none.home, registryDir: none.registry })).toMatchObject({ file: null, source: "none", warnings: [] });
    for (const choice of [c, await resolveMetadataFile({ homeDir: both.home, registryDir: both.registry })]) {
      expect(JSON.stringify([choice.label, choice.warnings])).not.toContain(scratch);
    }
  });

  it("AC-071-05 포함 snapshot은 schema를 통과하고 credential이 없어야 하며 Registry loader는 snapshot을 Manifest로 보지 않는다", async () => {
    expect(await checkBundledSnapshot(SEED)).toMatchObject({ ok: true });
    const bad = path.join(scratch, "token.json");
    const seed = JSON.parse(await readFile(SEED, "utf8")) as { repositories: Record<string, { description: string | null }> };
    const first = Object.keys(seed.repositories)[0]!;
    seed.repositories[first]!.description = "token ghp_" + "A".repeat(36);
    await writeFile(bad, JSON.stringify(seed));
    expect(await checkBundledSnapshot(bad)).toMatchObject({ ok: false, reason: expect.stringContaining("credential") });
    await writeFile(bad, "[]");
    expect(await checkBundledSnapshot(bad)).toMatchObject({ ok: false });
    const reg = path.join(scratch, "registry-copy");
    await cp(path.join(REPO, "registry"), reg, { recursive: true });
    await cp(SEED, path.join(reg, BUNDLED_METADATA_SNAPSHOT));
    const loaded = await loadRegistry(reg);
    expect(loaded.issues).toEqual([]);
    expect(loaded.entries.length).toBe(registryManifestCount());
  });
});
