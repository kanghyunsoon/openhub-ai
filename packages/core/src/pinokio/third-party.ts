import { createHash } from "node:crypto";
import { containsAbsolutePath } from "../analyzer/index";
import { boundedRequest, type ReleaseFetchOptions } from "../release/fetch";

/**
 * 제3자 Pinokio script Preview(TASK-052, D-027 B). 실행하지 않는다.
 * - repo·40-hex commit으로 고정한 원문 전체와 static warning(sudo·동적 JS·shell 사용·절대 경로)만 만든다.
 * - 이 모듈에는 실행 API가 없고 spawner·pterm을 받지 않는다. `third-party-script` 승인 항목도 없다.
 * - "안전" 판정을 하지 않고, 자유 message를 template으로 바꾸지 않으며, Pinokio Discover의 verified 표시로 승격하지 않는다.
 * - 원문은 GitHub contents API(api.github.com, 256 KiB, redirect 이전은 RELEASE_SOURCE_MOVED)로만 가져온다.
 */

export const THIRD_PARTY_MAX_BYTES = 256 * 1024;
export const THIRD_PARTY_WARNING_CODES = ["sudo", "dynamic-js", "shell", "absolute-path"] as const;
export type ThirdPartyWarningCode = (typeof THIRD_PARTY_WARNING_CODES)[number];
export const THIRD_PARTY_NOTICE = "OpenHub는 제3자 Pinokio script를 실행하지 않습니다. 내용을 직접 확인한 뒤 Pinokio에서 직접 열어 실행하세요.";

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const SCRIPT_PATH = /^(?:[A-Za-z0-9._-]+\/){0,5}[A-Za-z0-9._-]+\.(?:js|json|mjs|cjs)$/u;

const RULES: readonly (readonly [ThirdPartyWarningCode, RegExp])[] = [
  ["sudo", /\bsudo\b/u],
  ["dynamic-js", /\brequire\s*\(|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|\bchild_process\b|\bprocess\.(?:env|exit|platform)\b|=>|\basync\b|\bfunction\b/u],
  ["shell", /\bshell\.(?:run|start|enter|write)\b|"method"\s*:\s*"shell\./u],
];

export interface ThirdPartyPreview {
  kind: "third-party-pinokio-script";
  repo: string;
  commit: string;
  path: string;
  /** 원문 그대로(표시는 textContent로만) */
  content: string;
  contentDigest: string;
  warnings: { code: ThirdPartyWarningCode; line: number }[];
  executable: false;
  notice: string;
}

export type ThirdPartyResult = { ok: true; preview: ThirdPartyPreview } | { ok: false; code: "THIRD_PARTY_INPUT_INVALID" | "THIRD_PARTY_TOO_LARGE"; message: string };

const isAbsoluteLike = (line: string) => containsAbsolutePath(line) || /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\/(?:usr|bin|sbin|etc|opt|home|root|var|tmp|Users)\b|~\/)/u.test(line);

/** 고정한 원문의 Preview와 static warning. 실행 경로가 없다. */
export function previewThirdPartyScript(input: { repo: string; commit: string; path: string; content: string }): ThirdPartyResult {
  if (!REPO.test(input.repo) || !HEX40.test(input.commit) || !SCRIPT_PATH.test(input.path) || input.path.split("/").some((s) => s === "." || s === "..")) {
    return { ok: false, code: "THIRD_PARTY_INPUT_INVALID", message: "repo·40자리 commit·상대 script 경로로 고정해야 미리 볼 수 있습니다" };
  }
  if (Buffer.byteLength(input.content, "utf8") > THIRD_PARTY_MAX_BYTES) return { ok: false, code: "THIRD_PARTY_TOO_LARGE", message: "script가 너무 큽니다" };
  const warnings: ThirdPartyPreview["warnings"] = [];
  input.content.split(/\r\n|\n|\r/u).forEach((line, i) => {
    for (const [code, re] of RULES) if (re.test(line)) warnings.push({ code, line: i + 1 });
    if (isAbsoluteLike(line)) warnings.push({ code: "absolute-path", line: i + 1 });
  });
  const order = (c: ThirdPartyWarningCode) => THIRD_PARTY_WARNING_CODES.indexOf(c);
  warnings.sort((a, b) => a.line - b.line || order(a.code) - order(b.code));
  return {
    ok: true,
    preview: {
      kind: "third-party-pinokio-script",
      repo: input.repo,
      commit: input.commit,
      path: input.path,
      content: input.content,
      contentDigest: "sha256:" + createHash("sha256").update(input.content).digest("hex"),
      warnings,
      executable: false,
      notice: THIRD_PARTY_NOTICE,
    },
  };
}

/** GitHub contents API로 고정 commit의 원문을 가져온다(실행하지 않는다). token은 CLI 계층이 opaque 값으로 넘긴다. */
export async function fetchThirdPartyScript(input: { repo: string; commit: string; path: string }, options: ReleaseFetchOptions & { githubToken?: string } = {}): Promise<ThirdPartyResult | { ok: false; code: string; message: string }> {
  if (!REPO.test(input.repo) || !HEX40.test(input.commit) || !SCRIPT_PATH.test(input.path) || input.path.split("/").some((s) => s === "." || s === "..")) {
    return { ok: false, code: "THIRD_PARTY_INPUT_INVALID", message: "repo·40자리 commit·상대 script 경로로 고정해야 미리 볼 수 있습니다" };
  }
  try {
    const res = await boundedRequest(
      "https://api.github.com/repos/" + input.repo + "/contents/" + input.path.split("/").map(encodeURIComponent).join("/") + "?ref=" + input.commit,
      {
        method: "GET",
        headers: { accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28", "user-agent": "openhub-ai", ...(options.githubToken === undefined ? {} : { authorization: "Bearer " + options.githubToken }) },
        maxBytes: THIRD_PARTY_MAX_BYTES,
        redirect: "manual",
      },
      options,
    );
    return previewThirdPartyScript({ ...input, content: res.body });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "RELEASE_INVALID";
    return { ok: false, code, message: "제3자 script 원문을 가져오지 못했습니다(" + code + ")" };
  }
}

