import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Finding } from "./detector";
import { mcpServersFromCodexToml, mcpServersFromJson } from "./detectors/mcp-config";
import { toKebabId } from "./merge";
import type { AiClientId, AnalysisWarning } from "./profile";

/**
 * Host Agent Client Probe(TASK-016, Decision D-003). 사용자 범위(scope "user") 탐지.
 * - 기본 OFF. analyzeProject({ includeHost: true }) 또는 CLI --include-host일 때만 실행한다.
 * - 허용 목록의 세 파일만 접근하고, MCP 서버 키 이름만 추출한다(원본 객체를 반환·보관하지 않는다).
 * - PATH에서는 실행 파일의 존재만 확인하고 실행하지 않는다.
 * - 결과·경고에는 실제 홈 경로 대신 "~/…", "PATH" 같은 논리 경로만 쓴다.
 */

export interface HostFs {
  stat(file: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(file: string): Promise<string>;
}

export interface HostEnvironment {
  homeDir: string;
  pathEnv: string;
  pathExt: string;
  platform: NodeJS.Platform;
  fs: HostFs;
}

export const HOST_CONFIG_ALLOWLIST: readonly { relative: string; logical: string; client: AiClientId; format: "json" | "codex-toml" }[] = Object.freeze([
  { relative: ".claude.json", logical: "~/.claude.json", client: "claude-code", format: "json" },
  { relative: ".codex/config.toml", logical: "~/.codex/config.toml", client: "codex", format: "codex-toml" },
  { relative: ".cursor/mcp.json", logical: "~/.cursor/mcp.json", client: "cursor", format: "json" },
]);

export const HOST_EXECUTABLES: readonly { name: string; client: AiClientId }[] = Object.freeze([
  { name: "claude", client: "claude-code" },
  { name: "codex", client: "codex" },
  { name: "cursor", client: "cursor" },
]);

export const MAX_HOST_FILE_BYTES = 8 * 1024 * 1024;

const CLIENT_NAMES: Record<AiClientId, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };

const nodeFs: HostFs = { stat: (f) => stat(f), readFile: (f) => readFile(f, "utf8") };

export function defaultHostEnvironment(): HostEnvironment {
  return {
    homeDir: os.homedir(),
    pathEnv: process.env["PATH"] ?? "",
    pathExt: process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
    platform: process.platform,
    fs: nodeFs,
  };
}

/** 파일 내용을 파싱한 직후 서버 이름 배열만 남긴다. 파싱한 객체는 이 함수 밖으로 나가지 않는다. */
function serverNames(text: string, format: "json" | "codex-toml"): string[] | undefined {
  const doc: unknown = format === "json" ? JSON.parse(text) : parseToml(text);
  const list = format === "json" ? mcpServersFromJson(doc, false) : mcpServersFromCodexToml(doc, false);
  return list?.map((s) => s.name);
}

async function isFile(fs: HostFs, file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export interface HostProbeResult {
  findings: Finding[];
  warnings: AnalysisWarning[];
}

export async function probeHost(overrides: Partial<HostEnvironment> = {}): Promise<HostProbeResult> {
  const env: HostEnvironment = { ...defaultHostEnvironment(), ...overrides };
  const findings: Finding[] = [];
  const warnings: AnalysisWarning[] = [];
  const clientEvidence = new Map<AiClientId, Finding>();
  const addClient = (client: AiClientId, evidence: Finding["evidence"][number]) => {
    const f = clientEvidence.get(client);
    if (f) f.evidence.push(evidence);
    else clientEvidence.set(client, { category: "aiClients", id: client, name: CLIENT_NAMES[client], scope: "user", evidence: [evidence] });
  };

  for (const entry of HOST_CONFIG_ALLOWLIST) {
    const file = path.join(env.homeDir, ...entry.relative.split("/"));
    let size: number;
    try {
      const st = await env.fs.stat(file);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // 없는 파일은 정상 상태다.
    }
    if (size > MAX_HOST_FILE_BYTES) {
      warnings.push({ code: "host-file-too-large", file: entry.logical, message: "사용자 설정 파일이 크기 상한(8 MiB)을 넘어 읽지 않았습니다" });
      continue;
    }
    let names: string[] | undefined;
    try {
      names = serverNames(await env.fs.readFile(file), entry.format);
    } catch {
      names = undefined;
    }
    if (names === undefined) {
      // 파일 내용이나 파서 메시지는 남기지 않는다.
      warnings.push({ code: "host-config-unreadable", file: entry.logical, message: "사용자 설정 파일을 해석하지 못해 이 파일의 MCP 서버는 제외했습니다" });
      continue;
    }
    addClient(entry.client, { file: entry.logical, type: "config", value: entry.relative.split("/").pop() as string });
    for (const name of names) {
      const id = toKebabId(name);
      if (id === "") continue;
      findings.push({ category: "aiTools", id, name, scope: "user", kind: "mcp-server", clients: [entry.client], evidence: [{ file: entry.logical, type: "config", value: name }] });
    }
  }

  const dirs = env.pathEnv.split(env.platform === "win32" ? ";" : ":").filter((d) => d.trim() !== "");
  const exts = env.platform === "win32" ? ["", ...env.pathExt.split(";").filter(Boolean).map((e) => e.toLowerCase())] : [""];
  for (const exe of HOST_EXECUTABLES) {
    let found = false;
    for (const dir of dirs) {
      for (const ext of exts) {
        // 존재 여부만 확인한다. 발견한 실행 파일은 실행하지 않는다.
        if (await isFile(env.fs, path.join(dir, exe.name + ext))) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) addClient(exe.client, { file: "PATH", type: "executable", value: exe.name });
  }

  return { findings: [...clientEvidence.values(), ...findings], warnings };
}
