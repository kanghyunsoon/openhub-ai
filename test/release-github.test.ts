import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkLocalAssets,
  checkReleaseTag,
  checksummedAssetNames,
  draftNotesUpdate,
  flattenReleases,
  planDraftRelease,
  releaseAssetNames,
  verifyGithubRelease,
  type GithubAsset,
  type GithubRelease,
  type LocalAsset,
} from "../scripts/release-github-lib";
import { sha256, sha256SumsText } from "../scripts/release-lib";

/**
 * GitHub Release asset 계약과 Release API 검증. GitHub API는 부르지 않는다(실제 v0.1.0 API 응답 값을 fixture로 쓴다).
 * 이 파일의 child process는 tsx scripts/release.ts뿐이다(network 0, tag·Release 생성 0).
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const scratch = mkdtempSync(path.join(tmpdir(), "openhub-release-github-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tsxCli = path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
const PACKAGE_VERSION = (JSON.parse(read("apps/cli/package.json")) as { version: string }).version;

/** v0.1.0 공개 Release의 실제 asset(이름·크기·GitHub digest). */
const V010: [string, number, string][] = [
  ["openhub-ai-0.1.0.tgz", 387445, "30b09f1a5d9af366423137c8dc6697c3e6748a753fd7ae1aae9e15f6d49c0f11"],
  ["OpenHub-AI-Setup-0.1.0-x64.exe", 111531228, "9686200ae08b75e814cac053940694031f0ed7e2c8baa168455361159f613900"],
  ["OpenHub-AI-0.1.0-x86_64.AppImage", 125346980, "e4f2074452f188149b775619b0409a627b7f9f3727b537041f72d309707925b2"],
  ["openhub-cli-dependencies.cdx.json", 16446, "4e94a7796cb3f3b00d04a5783b63a911d7be7c024d2778bb68f7044d63a3060a"],
  ["openhub-desktop-dependencies.cdx.json", 17121, "ff6571c4d5a2af9de19ee955f8ed87020a8d24cdc334f452f59edb2f6bd35f52"],
  ["openhub-windows-artifact.cdx.json", 5518, "9f7ac34b0b5a9aa2ba9329d52b207aca348d28b743e5b5ab6162e9dffd098b6b"],
  ["release-coverage.json", 3020, "b508a7e1460ab5715707cc36da4f99e12909aec11c52258bf4f42a9509e3113c"],
  ["SHA256SUMS", 587, "6a6aaf92bc173ac2b563d1a7ede152453a805521a7d65c2115791959cb5a527e"],
];
const SUMS_010 = V010.slice(0, 6).map(([name, , sha]) => ({ name, sha256: sha }));
const asset = ([name, size, sha]: [string, number, string], over: Partial<GithubAsset> = {}): GithubAsset => ({ name, size, state: "uploaded", digest: "sha256:" + sha, ...over });
const release = (over: Partial<GithubRelease> & { id: number }): GithubRelease => ({ tag_name: "v0.1.0", name: "OpenHub AI v0.1.0", draft: true, published_at: null, body: "notes", assets: V010.map((a) => asset(a)), ...over });
const verify = (releases: GithubRelease[], expect: "draft" | "published" = "draft", sums = SUMS_010) => verifyGithubRelease({ tag: "v0.1.0", version: "0.1.0", releases, expect, sums });

describe("Release asset 계약", () => {
  it("필수 asset은 한 곳에서 정한 8개이고 SHA256SUMS는 그중 설치 파일·tgz·SBOM 6개를 덮는다", () => {
    expect(releaseAssetNames("0.1.1")).toEqual([
      "openhub-ai-0.1.1.tgz",
      "OpenHub-AI-Setup-0.1.1-x64.exe",
      "OpenHub-AI-0.1.1-x86_64.AppImage",
      "openhub-cli-dependencies.cdx.json",
      "openhub-desktop-dependencies.cdx.json",
      "openhub-windows-artifact.cdx.json",
      "release-coverage.json",
      "SHA256SUMS",
    ]);
    expect(releaseAssetNames("0.1.0")).toEqual(V010.map(([n]) => n));
    // release.ts sums 명령이 checksum하는 파일 패턴과 계약이 같은 6개를 가리킨다.
    const pattern = new RegExp(read("scripts/release.ts").match(/const RELEASE_FILE = (\/.*\/)u;/u)![1]!.slice(1, -1), "u");
    expect(releaseAssetNames("0.1.1").filter((n) => pattern.test(n))).toEqual(checksummedAssetNames("0.1.1"));
  });

  it("tag는 SemVer vX.Y.Z이고 package 버전과 같아야 한다", () => {
    expect(checkReleaseTag("v0.1.1", "0.1.1")).toEqual([]);
    expect(checkReleaseTag("v0.1.0", "0.1.1")).toEqual(["tag v0.1.0 ≠ package v0.1.1"]);
    for (const bad of ["0.1.1", "v0.1", "v0.1.1-rc.1", "v0.1.1 ", "refs/tags/v0.1.1"]) expect(checkReleaseTag(bad, "0.1.1"), bad).toHaveLength(1);
  });

  it("로컬 dist: 8개가 모두 있고 SHA256SUMS와 같아야 하며, 하나 빠지거나 크기 0·다른 버전 파일·SHA256SUMS 불일치면 실패한다", () => {
    const files = (version: string): LocalAsset[] => releaseAssetNames(version).map((name) => ({ name, size: name.length, sha256: sha256(name) }));
    const sums = (version: string) => checksummedAssetNames(version).map((name) => ({ name, sha256: sha256(name) }));
    expect(checkLocalAssets("0.1.1", files("0.1.1"), sums("0.1.1"))).toEqual([]);
    expect(checkLocalAssets("0.1.1", files("0.1.1").filter((f) => f.name !== "openhub-windows-artifact.cdx.json"), sums("0.1.1"))).toContain("필수 asset 없음: openhub-windows-artifact.cdx.json");
    expect(checkLocalAssets("0.1.1", files("0.1.1").map((f) => (f.name === "SHA256SUMS" ? { ...f, size: 0 } : f)), sums("0.1.1"))).toEqual(["크기 0: SHA256SUMS"]);
    // 다른 버전 이름(옛 산출물이 섞이거나 버전을 올리지 않고 빌드)
    const wrong = checkLocalAssets("0.1.1", files("0.1.0"), sums("0.1.0"));
    expect(wrong).toContain("필수 asset 없음: openhub-ai-0.1.1.tgz");
    expect(wrong).toContain("다른 버전 산출물: OpenHub-AI-Setup-0.1.0-x64.exe (package v0.1.1)");
    expect(checkLocalAssets("0.1.1", [...files("0.1.1"), { name: "openhub-ai-0.1.0.tgz", size: 1, sha256: "x" }], sums("0.1.1"))).toEqual(["다른 버전 산출물: openhub-ai-0.1.0.tgz (package v0.1.1)"]);
    const tampered = sums("0.1.1").map((e) => (e.name === "openhub-ai-0.1.1.tgz" ? { ...e, sha256: "0".repeat(64) } : e));
    expect(checkLocalAssets("0.1.1", files("0.1.1"), tampered)).toEqual(["SHA256SUMS 불일치: openhub-ai-0.1.1.tgz"]);
    expect(checkLocalAssets("0.1.1", files("0.1.1"), [...sums("0.1.1"), sums("0.1.1")[0]!])).toEqual(["SHA256SUMS 중복: openhub-ai-0.1.1.tgz"]);
    expect(checkLocalAssets("0.1.1", files("0.1.1"), sums("0.1.1").slice(1))).toEqual(["SHA256SUMS에 없음: openhub-ai-0.1.1.tgz"]);
  });
});

describe("같은 tag의 Release 판정과 draft notes 갱신", () => {
  it("Release가 없으면 생성, draft 하나면 재사용, 공개된 Release가 있거나 draft가 여럿이면 중단한다", () => {
    const other = release({ id: 9, tag_name: "v0.0.9", draft: false, published_at: "2026-01-01T00:00:00Z" });
    expect(planDraftRelease([other], "v0.1.0")).toEqual({ action: "create" });
    expect(planDraftRelease([other, release({ id: 1 })], "v0.1.0")).toEqual({ action: "reuse", releaseId: 1 });
    const published = planDraftRelease([release({ id: 1 }), release({ id: 2, draft: false, published_at: "2026-10-09T11:07:42Z", assets: [] })], "v0.1.0");
    expect(published).toMatchObject({ action: "stop" });
    expect(published.action === "stop" && published.reason).toContain("이미 공개된 Release");
    expect(planDraftRelease([release({ id: 1 }), release({ id: 2 })], "v0.1.0")).toMatchObject({ action: "stop" });
  });

  it("draft notes 갱신은 tag_name을 보존하고 asset을 건드리지 않으며, 공개된 Release·tag가 풀린 draft는 거부한다", () => {
    const draft = release({ id: 407819356 });
    const payload = draftNotesUpdate(draft, "v0.1.0", { body: "# OpenHub AI v0.1.0\n" });
    expect(payload).toEqual({ tag_name: "v0.1.0", name: "OpenHub AI v0.1.0", body: "# OpenHub AI v0.1.0\n", draft: true });
    expect(Object.keys(payload).sort()).toEqual(["body", "draft", "name", "tag_name"]);
    expect(JSON.stringify(payload)).not.toMatch(/assets|upload/u);
    expect(() => draftNotesUpdate(release({ id: 2, draft: false, published_at: "2026-10-09T11:07:42Z" }), "v0.1.0", { body: "x" })).toThrow(/공개된 Release/u);
    // v0.1.0 draft notes를 tag_name 없이 PATCH했을 때 실제로 생긴 상태
    expect(() => draftNotesUpdate(release({ id: 407819356, tag_name: "untagged-5de984efbf94c1c8d8b1" }), "v0.1.0", { body: "x" })).toThrow(/tag 연결/u);
  });

  it("gh api --paginate --slurp의 페이지 배열과 단일 배열을 모두 읽는다", () => {
    const a = release({ id: 1 });
    const b = release({ id: 2, tag_name: "v0.0.9" });
    expect(flattenReleases([[a], [b]]).map((r) => r.id)).toEqual([1, 2]);
    expect(flattenReleases([a, b]).map((r) => r.id)).toEqual([1, 2]);
    expect(() => flattenReleases({})).toThrow();
  });
});

describe("GitHub Release API 기준 asset 검증", () => {
  it("v0.1.0 실제 asset 8개(이름·크기·digest)는 통과한다", () => {
    expect(verify([release({ id: 1 })])).toEqual({ ok: true, releaseId: 1, errors: [], warnings: [] });
  });

  it("asset 하나가 빠지거나, 이름이 중복되거나, 업로드 중이거나, 크기 0이거나, digest가 다르면 실패한다", () => {
    const without = verify([release({ id: 1, assets: V010.filter(([n]) => n !== "SHA256SUMS").map((a) => asset(a)) })]);
    expect(without.errors).toEqual(["Release asset 없음: SHA256SUMS"]);
    const dup = verify([release({ id: 1, assets: [...V010.map((a) => asset(a)), asset(V010[0]!)] })]);
    expect(dup.errors).toEqual(["asset 이름 중복: openhub-ai-0.1.0.tgz"]);
    expect(verify([release({ id: 1, assets: V010.map((a, i) => asset(a, i === 1 ? { state: "starter" } : {})) })]).errors).toEqual(["업로드가 끝나지 않은 asset: OpenHub-AI-Setup-0.1.0-x64.exe (starter)"]);
    expect(verify([release({ id: 1, assets: V010.map((a, i) => asset(a, i === 3 ? { size: 0 } : {})) })]).errors).toEqual(["크기 0 asset: openhub-cli-dependencies.cdx.json"]);
    expect(verify([release({ id: 1, assets: V010.map((a, i) => asset(a, i === 2 ? { digest: "sha256:" + "0".repeat(64) } : {})) })]).errors).toEqual(["digest 불일치: OpenHub-AI-0.1.0-x86_64.AppImage"]);
  });

  it("다른 버전 이름의 asset만 있으면 필수 asset이 없는 것으로 실패하고, 계약 밖 asset은 경고다", () => {
    const renamed = verify([release({ id: 1, assets: V010.map(([n, s, d]) => asset([n.replace("0.1.0", "0.0.9"), s, d])) })]);
    expect(renamed.ok).toBe(false);
    expect(renamed.errors).toContain("Release asset 없음: openhub-ai-0.1.0.tgz");
    const extra = verify([release({ id: 1, assets: [...V010.map((a) => asset(a)), asset(["notes.txt", 3, "a".repeat(64)])] })]);
    expect(extra).toMatchObject({ ok: true, warnings: ["계약 밖 asset: notes.txt"] });
    expect(verify([release({ id: 1, assets: V010.map((a) => asset(a, { digest: null })) })])).toMatchObject({ ok: true, warnings: V010.map(([n]) => "GitHub digest 없음: " + n) });
  });

  it("로컬 dist가 있으면 Release asset 크기가 로컬 파일과 같아야 한다", () => {
    const local: LocalAsset[] = V010.map(([name, size, sha]) => ({ name, size: name === "release-coverage.json" ? size + 1 : size, sha256: sha }));
    const r = verifyGithubRelease({ tag: "v0.1.0", version: "0.1.0", releases: [release({ id: 1 })], expect: "draft", sums: SUMS_010, local });
    expect(r.errors).toEqual(["크기 불일치: release-coverage.json (Release 3020 ≠ 로컬 3021)"]);
  });

  it("v0.1.0 재현: workflow draft(asset 8개)와 따로 공개된 Release(asset 0개)가 같은 tag에 있으면 공개 검증이 실패한다", () => {
    const workflowDraft = release({ id: 407819356 });
    const manual = release({ id: 407833622, draft: false, published_at: "2026-10-09T11:07:42Z", assets: [] });
    const r = verify([workflowDraft, manual], "published");
    expect(r.ok).toBe(false);
    expect(r.releaseId).toBe(407833622);
    expect(r.errors[0]).toBe("v0.1.0에 Release가 2개 있습니다(id 407819356 draft, 407833622 published)");
    expect(r.errors.filter((e) => e.startsWith("Release asset 없음: "))).toHaveLength(8);
    // 같은 상황에서 workflow가 다시 돌면 공개된 Release를 건드리지 않고 멈춘다.
    expect(planDraftRelease([workflowDraft, manual], "v0.1.0")).toMatchObject({ action: "stop" });
    // asset을 손으로 올린 뒤의 공개 Release(읽기 token에는 draft가 보이지 않는다)는 통과한다.
    expect(verify([{ ...manual, assets: V010.map((a) => asset(a)) }], "published").ok).toBe(true);
  });

  it("상태가 기대와 다르거나 tag Release가 없거나 tag가 package 버전과 다르면 실패한다", () => {
    expect(verify([release({ id: 1 })], "published").errors).toEqual(["Release id 1가 아직 공개되지 않았습니다"]);
    expect(verify([release({ id: 1, draft: false, published_at: "2026-10-09T11:07:42Z" })], "draft").errors).toEqual(["Release id 1가 draft가 아닙니다"]);
    expect(verify([release({ id: 1, tag_name: "untagged-5de984efbf94c1c8d8b1" })]).errors).toEqual(["v0.1.0의 GitHub Release가 없습니다"]);
    expect(verifyGithubRelease({ tag: "v0.1.0", version: "0.1.1", releases: [release({ id: 1 })], expect: "draft", sums: SUMS_010 }).errors[0]).toBe("tag v0.1.0 ≠ package v0.1.1");
    expect(verify([release({ id: 1 })], "draft", []).errors).toHaveLength(6);
  });
});

describe("release workflow 연결", () => {
  const yml = read(".github/workflows/release.yml");
  const releaseJob = yml.slice(yml.indexOf("\n  release:\n"));
  const verifyYml = read(".github/workflows/release-verify.yml");

  it("release job은 tag 확인 → 로컬 asset 계약 → 같은 tag Release 판정 → 생성 또는 재사용 → API 검증 순서이고 검증이 업로드 뒤에 있다", () => {
    const at = (s: string) => {
      const i = releaseJob.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('pnpm release check-tag --tag "$TAG"'),
      at('pnpm release release-assets --dir release/dist --list "$RUNNER_TEMP/assets.txt"'),
      at('pnpm release github-plan --tag "$TAG"'),
      at("if: steps.plan.outputs.action == 'create'"),
      at('gh release create "$TAG" --draft --verify-tag'),
      at("if: steps.plan.outputs.action == 'reuse'"),
      at('gh release upload "$TAG" --clobber'),
      at("pnpm release github-notes"),
      at('pnpm release github-verify --tag "$TAG" --releases "$RUNNER_TEMP/releases-after.json" --dir release/dist --expect draft'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 올리는 파일은 계약 목록뿐이다(dist 전체 glob 아님).
    expect(releaseJob).not.toContain("release/dist/*");
    expect(releaseJob).toContain('"${assets[@]}"');
  });

  it("release-verify.yml은 공개(published) 때만 돌고 읽기 권한으로 검증만 한다", () => {
    expect(verifyYml).toMatch(/\non:\n {2}release:\n {4}types: \[published\]\n/u);
    expect(verifyYml).toMatch(/\npermissions:\n {2}contents: read\n/u);
    expect(verifyYml).not.toMatch(/contents: write|gh release (create|upload|edit|delete)|-X (PATCH|POST|DELETE)|secrets\.|npm publish/u);
    expect(verifyYml).toContain('pnpm release github-verify --tag "$TAG" --releases "$RUNNER_TEMP/releases.json" --sums "$RUNNER_TEMP/published/SHA256SUMS" --expect published');
  });

  // 실제 tsx 프로세스를 6번 띄운다(회당 약 1초). release.test.ts의 script 실행 테스트와 같은 timeout을 쓴다.
  it("release-assets·github-verify 명령은 계약 위반에서 exit 1, 정상에서 exit 0이다", { timeout: 60_000 }, () => {
    const dist = path.join(scratch, "dist");
    mkdirSync(dist);
    const names = releaseAssetNames(PACKAGE_VERSION);
    for (const n of names.filter((x) => x !== "SHA256SUMS")) writeFileSync(path.join(dist, n), "fixture " + n);
    writeFileSync(path.join(dist, "SHA256SUMS"), sha256SumsText(checksummedAssetNames(PACKAGE_VERSION).map((n) => ({ name: n, sha256: sha256("fixture " + n) }))));
    const run = (...args: string[]) => spawnSync(process.execPath, [tsxCli, "scripts/release.ts", ...args], { cwd: ROOT, encoding: "utf8" });
    const list = path.join(scratch, "assets.txt");
    expect(run("release-assets", "--dir", dist, "--list", list).status).toBe(0);
    expect(readFileSync(list, "utf8").trim().split("\n").map((p) => path.basename(p))).toEqual(names);

    const releases = path.join(scratch, "releases.json");
    const local = names.map((n) => readFileSync(path.join(dist, n)));
    const gh = (drop: string | null) => [[{ id: 7, tag_name: "v" + PACKAGE_VERSION, name: "x", draft: true, published_at: null, assets: names.filter((n) => n !== drop).map((n) => ({ name: n, size: local[names.indexOf(n)]!.length, state: "uploaded", digest: "sha256:" + sha256(local[names.indexOf(n)]!) })) }]];
    writeFileSync(releases, JSON.stringify(gh(null)));
    expect(run("github-verify", "--tag", "v" + PACKAGE_VERSION, "--releases", releases, "--dir", dist, "--expect", "draft").status).toBe(0);
    writeFileSync(releases, JSON.stringify(gh("OpenHub-AI-Setup-" + PACKAGE_VERSION + "-x64.exe")));
    const missing = run("github-verify", "--tag", "v" + PACKAGE_VERSION, "--releases", releases, "--dir", dist, "--expect", "draft");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Release asset 없음: OpenHub-AI-Setup-" + PACKAGE_VERSION + "-x64.exe");

    rmSync(path.join(dist, "SHA256SUMS"));
    expect(run("release-assets", "--dir", dist).status).toBe(1);
    expect(execFileSync(process.execPath, [tsxCli, "scripts/release.ts", "check-tag", "--tag", "v" + PACKAGE_VERSION], { cwd: ROOT, encoding: "utf8" })).toContain("✓ tag");
    expect(run("check-tag", "--tag", "v9.9.9").status).toBe(1);
  });
});

