import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkReleaseNotes } from "../scripts/release-github-lib";
import { clientVerificationLevel, loadRegistry, TOOL_CONFIG_CLIENTS, WITHDRAWN_TOOLS } from "../packages/core/src/index";

/**
 * v0.2.1 사용자 Release Notes가 실제 코드·Registry와 같은 내용을 말하는지 확인한다(근거 없는 주장 금지).
 * Registry 수, Postgres 고정 버전, Serena 지원 중단(#59), Client 검증 표, 미검증 범위, 환경 허용 목록의 남은 제한.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const notes = readFileSync(path.join(ROOT, "docs/release-notes/v0.2.1.md"), "utf8");
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
      "the client decides the environment, not OpenHub",
      // 복구는 CLI만
      "**Recovery is in the CLI only.**",
    ]) {
      expect(notes, part).toContain(part);
    }
    expect(notes).not.toMatch(/\b(?:ships|includes|has) (?:\*\*)?(?:2[5-9]|3\d|40)(?:\*\*)? (?:verified )?tools\b/u);
    expect(notes).not.toContain("starting tools from Cursor is verified");
  });
});
