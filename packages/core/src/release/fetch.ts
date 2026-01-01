import type { FetchLike } from "../discovery/github";
import { RESOLVER_ALLOWED_HOSTS } from "../lifecycle/resolver";

/**
 * Release 수집 공통 bounded fetch(TASK-047, D-022).
 * - allowlist host(M5 resolver 5개 + api.github.com)만, https만, URL credential 없는 URL만 요청한다. 그 밖은 fetch 0회.
 * - 요청당 timeout(기본 10초), 응답 상한(content-length와 스트리밍 양쪽), retry 없음, cache 없음.
 * - 사용자 credential·cookie를 보내지 않는다(credentials: "omit"). 인증 header는 호출 측이 opaque 값으로 넘길 때만 붙는다.
 * - redirect는 따라가지 않는다. 기본은 "error"(fetch reject)이고, 이전(301 등)을 구분해야 하는 출처는 "manual"로 받아 RELEASE_SOURCE_MOVED로 보고한다.
 * - process.env를 읽지 않는다.
 */

export const RELEASE_ALLOWED_HOSTS = [...RESOLVER_ALLOWED_HOSTS, "api.github.com"] as const;
export const RELEASE_TIMEOUT_MS = 10_000;

export type ReleaseErrorCode =
  | "RELEASE_SOURCE_UNSUPPORTED"
  | "RELEASE_TIMEOUT"
  | "RELEASE_OFFLINE"
  | "RELEASE_TOO_LARGE"
  | "RELEASE_INVALID"
  | "RELEASE_NOT_FOUND"
  | "RELEASE_RATE_LIMITED"
  | "RELEASE_SOURCE_MOVED";

export class ReleaseError extends Error {
  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
    readonly resetAt: string | null = null,
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

export interface ReleaseFetchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface BoundedRequest {
  method: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes: number;
  /** "error"(기본): fetch가 redirect를 거부한다. "manual": 3xx를 받아 RELEASE_SOURCE_MOVED로 바꾼다. 둘 다 따라가지 않는다. */
  redirect?: "error" | "manual";
  /** 이 요청의 host allowlist(기본 RELEASE_ALLOWED_HOSTS). Discovery는 자기 allowlist를 넘긴다(TASK-055). */
  allowedHosts?: readonly string[];
}

export interface BoundedResponse {
  status: number;
  headers: Headers;
  body: string;
}

export function isAllowedReleaseUrl(url: string, hosts: readonly string[] = RELEASE_ALLOWED_HOSTS): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && hosts.includes(u.hostname);
}

function rateLimitReset(headers: Headers): string | null {
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
}

/** allowlist·timeout·응답 상한을 지키는 단일 요청. 2xx만 성공이다. */
export async function boundedRequest(url: string, init: BoundedRequest, options: ReleaseFetchOptions = {}): Promise<BoundedResponse> {
  if (!isAllowedReleaseUrl(url, init.allowedHosts)) throw new ReleaseError("RELEASE_SOURCE_UNSUPPORTED", "허용하지 않은 출처입니다");
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? RELEASE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: init.method,
        headers: { ...(init.headers ?? {}) },
        signal: controller.signal,
        credentials: "omit",
        redirect: init.redirect ?? "error",
      });
    } catch {
      throw new ReleaseError(timedOut ? "RELEASE_TIMEOUT" : "RELEASE_OFFLINE", timedOut ? "release 출처 응답이 제한 시간을 넘었습니다" : "release 출처에 연결하지 못했습니다(오프라인 또는 redirect 거부)");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReleaseError("RELEASE_SOURCE_MOVED", "release 출처가 다른 위치로 옮겨졌습니다(redirect는 따라가지 않습니다)");
    }
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReleaseError("RELEASE_RATE_LIMITED", "요청 한도에 걸렸습니다. 잠시 뒤 다시 실행하세요", rateLimitReset(response.headers));
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > init.maxBytes) {
      controller.abort();
      throw new ReleaseError("RELEASE_TOO_LARGE", "release 출처 응답이 크기 상한을 넘었습니다");
    }
    let body = "";
    if (init.method === "GET" && response.body !== null) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        let part: Awaited<ReturnType<typeof reader.read>>;
        try {
          part = await reader.read();
        } catch {
          throw new ReleaseError(timedOut ? "RELEASE_TIMEOUT" : "RELEASE_OFFLINE", "release 출처 응답을 끝까지 읽지 못했습니다");
        }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > init.maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new ReleaseError("RELEASE_TOO_LARGE", "release 출처 응답이 크기 상한을 넘었습니다");
        }
        chunks.push(part.value);
      }
      body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    }
    if (response.status === 404) throw new ReleaseError("RELEASE_NOT_FOUND", "release 출처에서 대상을 찾지 못했습니다");
    if (response.status >= 500) throw new ReleaseError("RELEASE_OFFLINE", "release 출처를 지금 사용할 수 없습니다(" + String(response.status) + ")");
    if (response.status < 200 || response.status >= 300) throw new ReleaseError("RELEASE_INVALID", "release 출처가 요청을 거부했습니다(" + String(response.status) + ")");
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

export function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(body);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
  } catch {
    // 아래에서 형식 오류로 처리한다.
  }
  throw new ReleaseError("RELEASE_INVALID", "release 출처 응답 형식이 올바르지 않습니다");
}

