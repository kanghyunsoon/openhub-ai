import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkReleaseNotes } from "../scripts/release-github-lib";
import { clientVerificationLevel, isPinnedArtifact, loadRegistry, npxArtifact, parseUvxArgs, TOOL_CONFIG_CLIENTS, uvxAdapter, wheelsOnlyUvxLaunchArgs, WITHDRAWN_TOOLS, type InstallStep, type RegistryEntry } from "../packages/core/src/index";
import { createHarness, plannedOf } from "../packages/core/test/installer/harness";

/**
 * v0.2.1 사용자 Release Notes가 실제 코드·Registry와 같은 내용을 말하는지 확인한다(근거 없는 주장 금지).
 * Registry 수, Postgres 고정 버전, Serena 지원 중단(#59), Client 검증 표, 미검증 범위, 환경 허용 목록의 남은 제한.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const notes = readFileSync(path.join(ROOT, "docs/release-notes/v0.2.1.md"), "utf8");
const knownEn = readFileSync(path.join(ROOT, "docs/known-issues-v0.2.1.md"), "utf8");
const knownKo = readFileSync(path.join(ROOT, "docs/known-issues-v0.2.1.ko.md"), "utf8");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-notes-v021-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const WORD = { "launch-verified": "verified", "not-verified": "not verified", "platform-unverified": "not verified (platform unverified)" } as const;
const manifestCount = () =>
  readdirSync(path.join(ROOT, "registry")).filter((d) => statSync(path.join(ROOT, "registry", d)).isDirectory()).flatMap((d) => readdirSync(path.join(ROOT, "registry", d)).filter((f) => f.endsWith(".yaml"))).length;

describe("v0.2.1 Release Notes", () => {
  it("Release Notes 계약(제목, English, 산출물 이름 3개, SHA256SUMS, unsigned, macOS)을 통과한다", () => {
    expect(checkReleaseNotes("v0.2.1", "0.2.1", notes)).toEqual([]);
  });

  it("Registry 도구 수와 Postgres 고정 버전이 실제 Registry와 같다", async () => {
    const { entries, issues } = await loadRegistry(path.join(ROOT, "registry"));
    expect(issues).toEqual([]);
    expect(entries).toHaveLength(manifestCount());
    expect(notes).toContain("The Verified Registry has **" + entries.length + " tools**.");
    expect(notes).toContain("Verified Registry size:** " + entries.length + " tools.");
    const command = String(entries.find((e) => e.manifest.name === "postgres-mcp")!.manifest.install.options!["command"]);
    for (const pin of ["postgres-mcp==0.3.0", "mcp==1.30.0"]) {
      expect(command).toContain(pin);
      expect(notes).toContain(pin);
    }
    expect(notes).toContain("the other " + (entries.length - 1) + " tools have no per-client run record");
  });

  it("Serena는 Registry에 없고 지원 중단 목록·Issue #59와 일치하며, 기존 항목 보존·복구를 적는다", async () => {
    const { entries } = await loadRegistry(path.join(ROOT, "registry"));
    expect(entries.map((e) => e.manifest.name)).not.toContain("serena");
    const serena = WITHDRAWN_TOOLS.find((t) => t.toolId === "serena")!;
    expect(serena.since).toBe("0.2.1");
    expect(notes).toContain("**Serena: new installs stopped.**");
    expect(notes).toContain("(" + serena.issue + ")");
    for (const part of ["also when a custom Registry still contains it", "An existing Serena entry and its Version State are kept and shown as withdrawn", "an interrupted operation can still be recovered"]) expect(notes).toContain(part);
  });

  it("Memory MCP는 Registry에 없고 지원 중단 목록·Issue #69와 일치하며, npm 패키지 식별·기존 데이터 보존·Client 실행 한계를 적는다", async () => {
    const { entries } = await loadRegistry(path.join(ROOT, "registry"));
    expect(entries.map((e) => e.manifest.name)).not.toContain("memory-mcp");
    const memory = WITHDRAWN_TOOLS.find((t) => t.toolId === "memory-mcp")!;
    expect(memory.since).toBe("0.2.1");
    expect(memory.identity.npmPackages).toEqual(["@modelcontextprotocol/server-memory"]);
    expect(memory.identity.repositories).toEqual([]);
    expect(notes).toContain("**Memory MCP: new installs stopped.**");
    expect(notes).toContain("(" + memory.issue + ")");
    for (const part of ["also when a custom Registry installs the same npm package (`" + memory.identity.npmPackages[0] + "`)", "Other servers from the same GitHub repository are not affected", "the memory file are not changed, moved or deleted", "an interrupted operation can still be recovered", "OpenHub does not control that start", "cannot be recovered by OpenHub"]) expect(notes).toContain(part);
    for (const doc of [knownEn, knownKo]) {
      expect(doc).toContain(memory.issue);
      expect(doc).toContain("openhub lifecycle recover memory-mcp");
    }
    expect(knownEn).toContain("## Memory MCP: no new installs");
    expect(knownKo).toContain("## Memory MCP 신규 설치 불가");
  });

  it("기존 Memory MCP 사용자 보호 안내: 직접 백업·절대 경로 MEMORY_FILE_PATH·~/상대 경로 제한·이미 지워진 파일 복구 불가, 자동 보호 주장 없음", () => {
    expect(notes).toContain("v0.2.1 does not protect the file for you");
    expect(notes).toContain("set `MEMORY_FILE_PATH` to the absolute path of the copy (not `~` or a relative path)");
    for (const part of ["**Protect your memories yourself.**", "the same loss can still happen if you do nothing", "npm config get cache", "Do not use `~` (versions before 1.0.0 do not expand it) or a relative path", "cannot be recovered by OpenHub", "shows the entry as `config-drift` next to the withdrawn notice"]) expect(knownEn, part).toContain(part);
    for (const part of ["**기억은 직접 보호해야 합니다.**", "아무것도 하지 않으면 같은 손실이 여전히 일어날 수 있습니다", "npm config get cache", "OpenHub가 복구할 수 없습니다", "`config-drift`를 표시합니다"]) expect(knownKo, part).toContain(part);
    for (const doc of [notes, knownEn, knownKo]) expect(doc).not.toMatch(/existing (Memory MCP )?users are (now )?safe|no action (is )?needed|자동으로 (보호|이전)합니다/u);
  });

  it("버전 고정 안 된 npx 도구 목록과 측정 범위가 실제 Registry와 같다(#70): Context7만 측정, 나머지는 미측정", async () => {
    const { entries } = await loadRegistry(path.join(ROOT, "registry"));
    const unpinned = entries
      .filter((e) => e.manifest.install.preferredAdapter === "npx")
      .filter((e) => !isPinnedArtifact("npx", npxArtifact(String(e.manifest.install.options?.["command"] ?? "").split(/\s+/u).slice(1))))
      .map((e) => e.manifest.displayName)
      .sort();
    expect(unpinned).toEqual(["Chrome DevTools MCP", "Context7", "Playwright MCP"]);
    const bullet = notes.split("\n").find((l) => l.startsWith("- **Unpinned npx tools download during their first Health.**"))!;
    expect(bullet).toBeDefined();
    for (const name of unpinned) {
      expect(bullet).toContain(name);
      expect(knownEn).toContain(name);
      expect(knownKo).toContain(name);
    }
    expect(bullet).not.toContain("Memory MCP");
    expect(bullet).toContain("Only Context7 was measured: about 15.8 seconds on one Windows PC");
    expect(bullet).toContain("Chrome DevTools MCP and Playwright MCP were not measured");
    expect(knownEn).toContain("Chrome DevTools MCP and Playwright MCP were **not measured**");
    expect(knownKo).toContain("Chrome DevTools MCP와 Playwright MCP는 **측정하지 않았습니다**");
    // 오래된 main SHA로 현재 코드를 설명하지 않는다.
    for (const doc of [knownEn, knownKo]) expect(doc).not.toMatch(/main `[0-9a-f]{7}`/u);
  });

  it("Kubernetes MCP Server Client 검증 표의 각 칸이 Core 기록과 같다", () => {
    for (const client of TOOL_CONFIG_CLIENTS) {
      const cells = (["windows", "linux", "macos"] as const).map((os) => {
        const level = clientVerificationLevel("kubernetes-mcp-server", client, os);
        if (level !== "launch-verified" && level !== "not-verified" && level !== "platform-unverified") throw new Error(client + " " + os + ": " + String(level));
        return WORD[level];
      });
      expect(notes, client).toContain("| " + LABEL[client] + " | " + cells.join(" | ") + " |");
    }
  });

  it("미검증 범위와 남은 제한을 숨기지 않는다", () => {
    for (const part of [
      "starting tools from Cursor is **not verified** on any platform",
      "nothing is verified on macOS (platform-unverified)",
      "only version 0.0.67 is allowed",
      "has **not been observed**",
      "The earlier target of 25–40 verified tools is **not met**",
      // Postgres Windows Health 제한
      "the first Health check after install took about 15 seconds of the 20 second limit",
      // 환경 허용 목록(#46)의 남은 제한
      "It is not a sandbox",
      "is not permanently linked to later Health checks",
      "are not part of the approved plan",
      "credentials hidden in a URL path cannot be detected",
      "npm's own `node-options` setting",
      "the client decides the environment, not OpenHub",
      // 복구는 CLI만
      "**Recovery is in the CLI only.**",
    ]) {
      expect(notes, part).toContain(part);
    }
    expect(notes).not.toMatch(/\b(?:ships|includes|has) (?:\*\*)?(?:2[5-9]|3\d|40)(?:\*\*)? (?:verified )?tools\b/u);
    expect(notes).not.toContain("starting tools from Cursor is verified");
  });

  // #61 리뷰: "No source builds"는 고정 버전 uvx 도구에만 해당한다. 비고정 uvx 도구에는 같은 보장이 없다는 것을 노트가 말하고, 코드가 그렇게 동작한다.
  it("소스 빌드 차단은 고정 버전 uvx 도구에만 해당하고, 비고정 uvx 도구는 Prepare·--no-build가 없다(노트와 실제 동작이 같다)", async () => {
    expect(notes).toContain("**No source builds for pinned tools.**");
    expect(notes).toContain("**Unpinned uvx tools have no such guarantee.**");
    expect(notes).toContain("neither the client configuration nor Health and benchmark add `--no-build`");
    expect(notes).not.toContain("v0.2.1 does not build Python packages from source.");
    for (const doc of [knownEn, knownKo]) expect(doc).toContain("`--no-build`");

    const { entries } = await loadRegistry(path.join(ROOT, "registry"));
    const uvxTools = entries.filter((e) => e.manifest.install.preferredAdapter === "uvx").map((e) => e.manifest.name);
    expect(uvxTools).toEqual(["postgres-mcp"]);
    expect(notes).toContain("In the Verified Registry the only uvx tool, Postgres MCP Pro, is pinned");

    const postgres = entries.find((e) => e.manifest.name === "postgres-mcp")!.manifest;
    const plan = (command: string) => {
      const step: InstallStep = { adapter: "uvx", options: { command } };
      const manifest = { ...postgres, install: { preferredAdapter: "uvx" as const, options: { command }, fallback: [] } };
      return { manifest, result: uvxAdapter.planLaunch(manifest, step, "linux") };
    };
    // 고정: wheel-only Prepare(--no-build)와 Client --no-build, Health·Benchmark 인자도 --no-build
    const pinned = plan(String(postgres.install.options!["command"]));
    if (!pinned.result.ok) throw new Error(pinned.result.reason);
    expect(pinned.result.value.artifact).toMatchObject({ pinned: true, preparation: "uv-cache" });
    expect(pinned.result.value.preparation[0]!.args[0]).toBe("--no-build");
    expect(pinned.result.value.launch.args[0]).toBe("--no-build");
    expect(wheelsOnlyUvxLaunchArgs(pinned.manifest, "uvx", String(postgres.install.options!["command"]).split(" ").slice(1))[0]).toBe("--no-build");
    // 비고정(패키지 또는 --with 의존성): Prepare 없음, Client·Health·Benchmark 인자에 --no-build 없음, floating
    for (const command of ["uvx --from code-nav code-nav", "uvx --from code-nav==1.0.0 --with dep code-nav", "uvx code-nav"]) {
      const floating = plan(command);
      if (!floating.result.ok) throw new Error(command + ": " + floating.result.reason);
      expect(floating.result.value.artifact, command).toMatchObject({ pinned: false, preparation: "launch-on-demand" });
      expect(floating.result.value.preparation, command).toEqual([]);
      expect(floating.result.value.launch.args, command).not.toContain("--no-build");
      expect(wheelsOnlyUvxLaunchArgs(floating.manifest, "uvx", command.split(" ").slice(1)), command).not.toContain("--no-build");
    }
    // 비고정 uvx 도구 설치 계획은 floating-artifact 승인을 따로 받는다(알려진 문제 문서의 설명)
    const postgresEntry = entries.find((e) => e.manifest.name === "postgres-mcp")!;
    const { recommendation: _alias, ...unaliased } = postgresEntry.manifest;
    const custom: RegistryEntry = { ...postgresEntry, manifest: { ...unaliased, name: "code-nav", repository: { github: "someone/code-nav" }, install: { preferredAdapter: "uvx", options: { command: "uvx --from code-nav code-nav" }, fallback: [] } } };
    const h = await createHarness(scratch, { entries: [...entries, custom] });
    const planned = await plannedOf(h, h.request("code-nav", [{ client: "cursor", scope: "project" }]));
    expect(planned.plan.approvalRequirements).toContain("floating-artifact");
    expect(knownEn).toContain("The install plan marks it as a floating artifact and asks for that approval");
  });

  // #61 리뷰: 거부되는 uvx 형식을 "패키지 식별 불가"와 "식별은 되지만 OpenHub Prepare·update 처리 범위 밖"으로 나눠 적고, 그 분류가 파서와 같다.
  it("거부되는 uvx 형식을 두 가지 이유로 나눠 적고, 분류가 실제 파서(parseUvxArgs)와 같다", () => {
    const unidentifiable: [string, string[]][] = [
      ["URL", ["--from", "code-nav@https://example.invalid/code_nav-1.0.0-py3-none-any.whl", "code-nav"]],
      ["path", ["--from", "./code-nav", "code-nav"]],
      ["VCS", ["--from", "git+https://github.com/someone/code-nav", "code-nav"]],
      ["wheel file", ["--with", "dep-1.0.0-py3-none-any.whl", "code-nav"]],
      ["--with-editable", ["--with-editable", "dep", "code-nav"]],
      ["--with-requirements", ["--with-requirements", "requirements.txt", "code-nav"]],
      ["unlisted option", ["--some-new-option", "code-nav"]],
    ];
    for (const [label, args] of unidentifiable) expect(parseUvxArgs(args), label).toMatchObject({ ok: false });
    const outsideContract: [string, string[]][] = [
      ["--from=", ["--from=code-nav==1.0.0", "code-nav"]],
      ["--with=", ["--with=dep==1.0.0", "code-nav"]],
      ["-wpackage", ["-wdep", "code-nav"]],
      ["-w=package", ["-w=dep", "code-nav"]],
      ["-qw", ["-qw", "dep", "code-nav"]],
      ["comma list", ["--with", "dep,dep2", "code-nav"]],
      ["--", ["--", "code-nav"]],
    ];
    for (const [label, args] of outsideContract) {
      const r = parseUvxArgs(args);
      // 패키지는 식별된다(지원 중단 판정이 쓴다). 다만 띄어 쓴 표준 형식이 아니라 설치기가 거부한다.
      expect(r, label).toMatchObject({ ok: true, canonical: false });
      if (r.ok) expect(r.packages.length, label).toBeGreaterThan(0);
    }
    const sections: Readonly<Record<"en" | "ko", readonly [string, string]>> = {
      en: ["**The package cannot be identified**", "**The package can be identified, but the form is outside OpenHub's Prepare and update handling:**"],
      ko: ["**Manifest만으로 패키지를 식별할 수 없음:**", "**패키지는 식별되지만 OpenHub의 Prepare·update 처리 범위 밖인 형식:**"],
    };
    for (const [doc, [a, b]] of [[knownEn, sections.en], [knownKo, sections.ko]] as const) {
      const ia = doc.indexOf(a);
      const ib = doc.indexOf(b);
      expect(ia).toBeGreaterThan(0);
      expect(ib).toBeGreaterThan(ia);
      const lineA = doc.slice(ia, doc.indexOf("\n", ia));
      const lineB = doc.slice(ib, doc.indexOf("\n", ib));
      // 붙여 쓴 형식은 "처리 범위 밖"에만 있고, URL·--with-editable은 "식별 불가"에만 있다.
      for (const form of ["`--from=", "`--with=", "`-qw`", "`--`"]) {
        expect(lineB, form).toContain(form);
        expect(lineA, form).not.toContain(form);
      }
      for (const form of ["`--with-editable`", "`--with-requirements`"]) {
        expect(lineA, form).toContain(form);
        expect(lineB, form).not.toContain(form);
      }
    }
    expect(knownEn).not.toContain("OpenHub would not be able to identify the package.");
    expect(knownKo).not.toContain("OpenHub가 패키지를 식별할 수 없기 때문입니다.");
    expect(notes).not.toContain("are refused, because OpenHub could not identify the package");
    expect(notes).toContain("The package cannot be identified from the Manifest");
    expect(notes).toContain("The package can be identified, but OpenHub's Prepare and update steps only handle options written with a space");
  });
});
