import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientVerificationLevel, TOOL_CONFIG_CLIENTS } from "../packages/core/src/index";

/** v0.2.0 사용자 Release Notes의 Client 검증 표는 Core의 OS × Client 기록(clientVerificationLevel)과 같아야 한다. */
const ROOT = path.resolve(import.meta.dirname, "..");
const notes = readFileSync(path.join(ROOT, "docs/release-notes/v0.2.0.md"), "utf8");
const LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const WORD = { "launch-verified": "verified", "not-verified": "not verified", "platform-unverified": "not verified (platform unverified)" } as const;

describe("v0.2.0 Release Notes Client 검증 표", () => {
  it("Kubernetes MCP Server 표의 각 칸이 Core 기록과 같다(근거 없는 수준을 주장하지 않는다)", () => {
    for (const client of TOOL_CONFIG_CLIENTS) {
      const cells = (["windows", "linux", "macos"] as const).map((os) => {
        const level = clientVerificationLevel("kubernetes-mcp-server", client, os);
        if (level !== "launch-verified" && level !== "not-verified" && level !== "platform-unverified") throw new Error(client + " " + os + ": " + String(level) + " is not described in the notes");
        return WORD[level];
      });
      expect(notes, client).toContain("| " + LABEL[client] + " | " + cells.join(" | ") + " |");
    }
  });

  it("Registry 9개, 25-40 목표 미달성·이월, 검증은 Kubernetes MCP Server에만 있다는 범위를 유지한다", () => {
    expect(notes).toContain("The Verified Registry has **9 tools**.");
    expect(notes).toContain("Per-client start verification exists for **Kubernetes MCP Server only**");
    expect(notes).toContain("only version 0.0.67 is allowed");
    // 25-40은 목표로만 언급하고 달성했다고 쓰지 않는다.
    expect(notes).toContain("The earlier target of 25–40 verified tools is **not met** in this release and is carried over to a later version");
    expect(notes).not.toMatch(/\b(?:ships|includes|has) (?:\*\*)?(?:2[5-9]|3\d|40)(?:\*\*)? (?:verified )?tools\b/u);
  });

  it("미서명 NSIS와 SmartScreen 미관찰, AppImage 추출 실행 검증 범위를 적는다", () => {
    expect(notes).toContain("the NSIS installer has no code signature. How Windows SmartScreen or Smart App Control reacts to it was **not observed** in release testing");
    expect(notes).toContain("by extracting it (`--appimage-extract`) and starting the extracted app. Starting the AppImage file directly through FUSE was not part of release testing.");
    expect(notes).toContain("nothing is verified on macOS (platform-unverified)");
    expect(notes).toContain("starting tools from Cursor is **not verified** on any platform");
  });

  it("정확한 버전 Update: npx만, X.Y.Z, 빈 값은 기존 동작, 승인 필요, 실패 시 복구, Kubernetes 0.0.67 제한을 적는다", () => {
    const line = notes.split("\n").find((l) => l.startsWith("- **Update to an exact version (npx tools only):**"));
    expect(line).toBeDefined();
    for (const part of ["`X.Y.Z`", "Leave it empty to keep the previous behavior", "needs your approval", "the client configuration and Version State are restored", "Kubernetes MCP Server stays limited to its reviewed version 0.0.67"]) expect(line, part).toContain(part);
    // 기존 절은 그대로 남아 있다.
    for (const heading of ["## Compatibility", "## Known limitations"]) expect(notes).toContain(heading);
  });
});
