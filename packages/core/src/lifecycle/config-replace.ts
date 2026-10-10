import { parse as parseToml } from "smol-toml";
import {
  ConfigWriteError,
  atomicWrite,
  codexBlock,
  configTargetFor,
  decode,
  detectIndent,
  isOfficialServerEntry,
  manualSetupInstructions,
  nodeConfigFs,
  readOptional,
  resolveInside,
  type ConfigErrorCode,
  type ConfigFormat,
  type ConfigRoots,
  type ConfigWriteReceipt,
} from "../installer/config-writer";
import { canonicalize, type ServerEntry } from "../installer/plan";
import type { ConfigReplaceStep } from "./plan";
import { configEntryDigest, tomlBlockDigest } from "./status";

/**
 * Config 교체 writer(TASK-042, D-013·D-020). LifecyclePlan의 config-replace 단계를 targeted patch로 적용한다.
 * - JSON: mcpServers.<alias>의 canonical digest가 precondition(expectedEntryDigest)과 같을 때만 그 값을 바꾼다.
 *   다른 key·서버·key 순서·들여쓰기·줄바꿈·BOM을 유지한다.
 * - TOML: OpenHub가 쓴 [mcp_servers.<alias>] block byte(Version State tomlBlockDigest와 일치)가 파일에 정확히 1회 있을 때만
 *   그 block을 바꾸고 나머지 byte는 그대로 둔다. 0회·2회 이상·내용 불일치는 CONFIG_DRIFT이며 자동 완화하지 않는다.
 * - D-013 allowlist 밖은 manual-setup-required, Client 공식 형식(D-016 Windows wrapper 포함)이 아니면 쓰지 않는다.
 * - 같은 디렉터리 임시 파일 → rename. 영수증(원본 byte)으로 M4 restoreConfig가 원본을 되돌린다.
 * - env는 이름과 Client별 참조 문법만 쓴다. process.env를 읽지 않는다.
 */

export type ConfigReplaceErrorCode = "CONFIG_DRIFT" | ConfigErrorCode;
export type ConfigReplaceResult = { ok: true; receipt: ConfigWriteReceipt } | { ok: false; code: ConfigReplaceErrorCode; message: string };

export interface ReplaceConfigOptions extends ConfigRoots {
  /** VerifiedLifecyclePlan의 acknowledgements. user scope는 user-scope-config가 있어야 쓴다. */
  acknowledgements: readonly string[];
  /** Codex 대상의 Version State tomlBlockDigest(LF 기준). JSON 대상은 쓰지 않는다. */
  expectedBlockDigest?: string | null;
  /** placeholder 형태 → 실제로 쓸 값(v0.2.0 tool config). installer ApplyConfigOptions.materialize와 같다. */
  materialize?: (value: ServerEntry) => ServerEntry;
}

class ReplaceError extends Error {
  constructor(
    readonly code: ConfigReplaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const drift = (message: string) => new ReplaceError("CONFIG_DRIFT", message);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 줄 시작에서 시작하는 needle의 위치들. */
function lineStartOccurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (i === 0 || text[i - 1] === "\n") found.push(i);
  }
  return found;
}

/** 원본 byte에서 한 서버 항목만 바꾼 새 byte. precondition이 맞지 않으면 CONFIG_DRIFT 예외. */
export function replaceConfigText(original: Buffer, format: ConfigFormat, serverName: string, expectedEntryDigest: string, value: ServerEntry, expectedBlockDigest?: string | null): Buffer {
  const shape = decode(original);
  if (format === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(shape.text);
    } catch {
      throw new ReplaceError("CONFIG_UNPARSEABLE", "JSON 설정 파일을 해석하지 못했습니다");
    }
    const servers = isRecord(doc) ? doc["mcpServers"] : undefined;
    if (!isRecord(doc) || !isRecord(servers) || !Object.prototype.hasOwnProperty.call(servers, serverName)) throw drift(serverName + " 항목이 없습니다");
    if (configEntryDigest(servers[serverName]) !== expectedEntryDigest) throw drift(serverName + " 항목이 OpenHub가 기록한 내용과 다릅니다");
    // key 순서를 유지한 채 값만 바꾼다.
    const nextServers = Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, k === serverName ? canonicalize(value) : v]));
    const next = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, k === "mcpServers" ? nextServers : v]));
    let text = JSON.stringify(next, null, detectIndent(shape.text));
    const trailing = /\r?\n$/u.test(shape.text) ? shape.eol : "";
    text = (shape.eol === "\r\n" ? text.replace(/\n/gu, "\r\n") : text) + trailing;
    return Buffer.from((shape.bom ? "\uFEFF" : "") + text, "utf8");
  }

  let doc: unknown;
  try {
    doc = parseToml(shape.text);
  } catch {
    throw new ReplaceError("CONFIG_UNPARSEABLE", "TOML 설정 파일을 해석하지 못했습니다");
  }
  const servers = isRecord(doc) ? doc["mcp_servers"] : undefined;
  const current = isRecord(servers) ? servers[serverName] : undefined;
  if (current === undefined) throw drift(serverName + " 항목이 없습니다");
  if (configEntryDigest(current) !== expectedEntryDigest) throw drift(serverName + " 항목이 OpenHub가 기록한 내용과 다릅니다");
  if (expectedBlockDigest === undefined || expectedBlockDigest === null || tomlBlockDigest(serverName, current as ServerEntry) !== expectedBlockDigest) {
    throw drift("OpenHub가 쓴 " + serverName + " block을 확인하지 못했습니다");
  }
  const oldBlock = codexBlock(serverName, current as ServerEntry, shape.eol);
  const found = lineStartOccurrences(shape.text, oldBlock);
  if (found.length !== 1) throw drift("OpenHub가 쓴 " + serverName + " block이 파일에 " + String(found.length) + "회 있습니다(정확히 1회여야 교체합니다)");
  const at = found[0]!;
  const nextText = shape.text.slice(0, at) + codexBlock(serverName, value, shape.eol) + shape.text.slice(at + oldBlock.length);
  let reparsed: unknown;
  try {
    reparsed = parseToml(nextText);
  } catch {
    throw new ReplaceError("CONFIG_UNPARSEABLE", "교체한 TOML을 다시 해석하지 못했습니다");
  }
  const strip = (d: unknown) => {
    if (!isRecord(d) || !isRecord(d["mcp_servers"])) return d;
    const { [serverName]: _ignored, ...rest } = d["mcp_servers"];
    return { ...d, mcp_servers: rest };
  };
  const written = isRecord(reparsed) && isRecord(reparsed["mcp_servers"]) ? reparsed["mcp_servers"][serverName] : undefined;
  if (JSON.stringify(canonicalize(written)) !== JSON.stringify(canonicalize(value)) || JSON.stringify(canonicalize(strip(reparsed))) !== JSON.stringify(canonicalize(strip(doc)))) {
    throw drift("교체 결과가 Plan과 다릅니다(block 경계가 예상과 다릅니다)");
  }
  return Buffer.from((shape.bom ? "\uFEFF" : "") + nextText, "utf8");
}

/** config-replace 단계 하나를 적용한다. 실패하면 파일을 바꾸지 않는다(write 0회). */
export async function replaceConfigEntry(step: ConfigReplaceStep, options: ReplaceConfigOptions): Promise<ConfigReplaceResult> {
  const target = configTargetFor(step.client, step.scope);
  const serverName = step.path[1]!;
  try {
    const expectedRoot = step.client === "codex" ? "mcp_servers" : "mcpServers";
    if (!target.writable || step.file !== target.logical || step.path.length !== 2 || step.path[0] !== expectedRoot || !isOfficialServerEntry(step.client, step.value)) {
      return { ok: false, code: "MANUAL_SETUP_REQUIRED", message: manualSetupInstructions(step.client, step.scope, serverName) };
    }
    if (step.scope === "user" && !options.acknowledgements.includes("user-scope-config")) {
      return { ok: false, code: "USER_SCOPE_NOT_APPROVED", message: "사용자 범위 설정 변경(user-scope-config)을 승인하지 않았습니다" };
    }
    const fs = options.fs ?? nodeConfigFs;
    const { file } = await resolveInside(target, options, fs);
    const original = await readOptional(fs, file);
    if (original === null) return { ok: false, code: "CONFIG_DRIFT", message: target.logical + " 파일이 없습니다" };
    const value = options.materialize === undefined ? step.value : options.materialize(step.value);
    const next = replaceConfigText(original, target.format, serverName, step.expectedEntryDigest, value, options.expectedBlockDigest);
    await atomicWrite(fs, file, next);
    return { ok: true, receipt: Object.freeze({ client: step.client, scope: step.scope, file: target.logical, serverName, absolutePath: file, original, written: next, createdDirs: Object.freeze([]) }) };
  } catch (error) {
    if (error instanceof ReplaceError || error instanceof ConfigWriteError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "CONFIG_WRITE_FAILED", message: "설정 파일을 바꾸지 못했습니다" };
  }
}

