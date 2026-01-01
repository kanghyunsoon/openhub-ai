import { isRecord } from "./manifests";

/**
 * MCP 설정에서 "서버 식별에 필요한 값"만 꺼낸다(TASK-013, TASK-016 공용).
 * 원본 객체를 반환하거나 보관하지 않는다. env·headers·args·url·token 같은 값은 읽어도 결과에 담지 않는다.
 */
export interface McpServerIdentity {
  name: string;
  /** stdio(command 실행) 또는 http(url 접속). 알 수 없으면 undefined */
  transport?: "stdio" | "http";
  /** 실행 명령의 기본 이름(npx, uvx, docker 등). 경로·인자는 버린다. */
  command?: string;
}

const SAFE_NAME = /^[\w.@:/-]{1,100}$/u;

export function commandBaseName(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/u)[0] ?? "";
  const base = first.split(/[\\/]/u).pop()?.replace(/\.(exe|cmd|bat|ps1)$/iu, "") ?? "";
  return /^[A-Za-z0-9._-]{1,40}$/u.test(base) ? base : undefined;
}

function identity(name: string, entry: unknown, withDetails: boolean): McpServerIdentity | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  if (!withDetails || !isRecord(entry)) return { name };
  const type = entry["type"];
  const transport = typeof entry["url"] === "string" || type === "http" || type === "sse" || type === "streamable-http" ? "http" : entry["command"] !== undefined ? "stdio" : undefined;
  const command = transport === "stdio" ? commandBaseName(entry["command"]) : undefined;
  return { name, ...(transport === undefined ? {} : { transport }), ...(command === undefined ? {} : { command }) };
}

/** `{ mcpServers: { <name>: … } }` 형식(.mcp.json, .cursor/mcp.json, ~/.claude.json). */
export function mcpServersFromJson(doc: unknown, withDetails = true): McpServerIdentity[] | undefined {
  if (!isRecord(doc)) return undefined;
  const servers = doc["mcpServers"];
  if (servers === undefined) return [];
  if (!isRecord(servers)) return undefined;
  return Object.keys(servers)
    .sort()
    .flatMap((name) => identity(name, servers[name], withDetails) ?? []);
}

/** Codex `config.toml`의 `[mcp_servers.<name>]` 테이블. */
export function mcpServersFromCodexToml(doc: unknown, withDetails = true): McpServerIdentity[] | undefined {
  if (!isRecord(doc)) return undefined;
  const servers = doc["mcp_servers"];
  if (servers === undefined) return [];
  if (!isRecord(servers)) return undefined;
  return Object.keys(servers)
    .sort()
    .flatMap((name) => identity(name, servers[name], withDetails) ?? []);
}

/** Evidence value: "github (stdio, npx)" / "context7 (http)" / "github" */
export function describeServer(s: McpServerIdentity): string {
  const parts = [s.transport, s.command].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? s.name : `${s.name} (${parts.join(", ")})`;
}
