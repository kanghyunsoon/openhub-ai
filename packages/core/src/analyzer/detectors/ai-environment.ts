import type { ProjectDetector, ScanContext } from "../detector";
import { toKebabId } from "../merge";
import type { AiClientId, Evidence } from "../profile";
import { FindingSet } from "./findings";
import { isRecord } from "./manifests";
import { describeServer, mcpServersFromCodexToml, mcpServersFromJson, type McpServerIdentity } from "./mcp-config";

const CLIENT_NAMES: Record<AiClientId, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
const SKILL_FILE = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/u;
const CLAUDE_SETTINGS = /^\.claude\/settings(\.local)?\.json$/u;

/**
 * AI Environment Detector(TASK-013, 프로젝트 범위). 프로젝트 Root 안의 설정만 본다.
 * 사용자 범위(~/)는 Host Probe(TASK-016)가 따로 다룬다.
 */
export const aiEnvironmentDetector: ProjectDetector = {
  id: "ai-environment",
  supports: (ctx) => ctx.files.some((f) => f === "CLAUDE.md" || f === "AGENTS.md" || f === ".mcp.json" || /^\.(claude|codex|cursor)\//u.test(f)),
  async detect(ctx: ScanContext) {
    const found = new FindingSet();
    const client = (id: AiClientId, evidence: Evidence) => found.add("aiClients", id, CLIENT_NAMES[id], evidence);
    const servers = (list: McpServerIdentity[], file: string, clientId: AiClientId) => {
      for (const s of list) {
        const id = toKebabId(s.name);
        if (id === "") continue;
        found.add("aiTools", id, s.name, { file, type: "config", value: describeServer(s) }, { kind: "mcp-server", client: clientId });
      }
    };

    // Claude Code
    if (ctx.hasFile("CLAUDE.md")) client("claude-code", { file: "CLAUDE.md", type: "config", value: "CLAUDE.md" });
    for (const file of ctx.files.filter((f) => CLAUDE_SETTINGS.test(f))) client("claude-code", { file, type: "config", value: file.slice(".claude/".length) });
    if (ctx.hasFile(".mcp.json")) {
      const list = mcpServersFromJson(await ctx.readJson(".mcp.json"));
      if (list === undefined) client("claude-code", { file: ".mcp.json", type: "file-presence", value: ".mcp.json" });
      else {
        client("claude-code", { file: ".mcp.json", type: "config", value: "mcpServers" });
        servers(list, ".mcp.json", "claude-code");
      }
    }
    for (const file of ctx.files) {
      const m = SKILL_FILE.exec(file);
      if (m === null) continue;
      const id = toKebabId(m[1] as string);
      if (id === "") continue;
      client("claude-code", { file, type: "config", value: "skills" });
      found.add("aiTools", id, m[1] as string, { file, type: "config", value: m[1] as string }, { kind: "skill", client: "claude-code" });
    }
    if (ctx.hasFile(".claude/settings.json")) {
      const settings = await ctx.readJson(".claude/settings.json");
      const plugins = isRecord(settings) ? settings["enabledPlugins"] : undefined;
      if (isRecord(plugins)) {
        for (const key of Object.keys(plugins).sort()) {
          const id = toKebabId(key);
          if (plugins[key] !== true || id === "" || key.length > 100) continue;
          found.add("aiTools", id, key, { file: ".claude/settings.json", type: "config", value: key }, { kind: "plugin", client: "claude-code" });
        }
      }
    }

    // Codex
    if (ctx.hasFile(".codex/config.toml")) {
      const list = mcpServersFromCodexToml(await ctx.readToml(".codex/config.toml"));
      if (list === undefined) client("codex", { file: ".codex/config.toml", type: "file-presence", value: "config.toml" });
      else {
        client("codex", { file: ".codex/config.toml", type: "config", value: "config.toml" });
        servers(list, ".codex/config.toml", "codex");
      }
    }
    // AGENTS.md는 여러 에이전트가 함께 쓰는 파일이라 Codex의 약한 근거로만 쓴다.
    if (ctx.hasFile("AGENTS.md")) client("codex", { file: "AGENTS.md", type: "file-presence", value: "AGENTS.md" });

    // Cursor
    if (ctx.hasFile(".cursor/mcp.json")) {
      const list = mcpServersFromJson(await ctx.readJson(".cursor/mcp.json"));
      if (list === undefined) client("cursor", { file: ".cursor/mcp.json", type: "file-presence", value: "mcp.json" });
      else {
        client("cursor", { file: ".cursor/mcp.json", type: "config", value: "mcpServers" });
        servers(list, ".cursor/mcp.json", "cursor");
      }
    }
    return { findings: found.toArray() };
  },
};
