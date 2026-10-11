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

  it("Registry 9개, 25-40 미포함, 검증은 Kubernetes MCP Server에만 있다는 범위를 유지한다", () => {
    expect(notes).toContain("The Verified Registry has **9 tools**.");
    expect(notes).toContain("Per-client start verification exists for **Kubernetes MCP Server only**");
    expect(notes).toContain("only version 0.0.67 is allowed");
    expect(notes).not.toMatch(/\b(?:25|40) (?:verified )?tools\b/u);
  });
});
