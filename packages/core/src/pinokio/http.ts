import type { FetchLike } from "../discovery/github";

/**
 * Pinokio control plane·Health용 loopback HTTP GET(TASK-052·053, D-027).
 * - http://127.0.0.1 또는 http://localhost만. 그 밖은 fetch 0회.
 * - timeout·응답 상한·redirect error·credential 없음·retry 없음.
 */

export const PINOKIO_HTTP_TIMEOUT_MS = 1000;
export const PINOKIO_HTTP_MAX_BYTES = 64 * 1024;

export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

export type LoopbackResult = { ok: true; status: number; body: string } | { ok: false; reason: "not-loopback" | "timeout" | "offline" | "too-large" | "redirect" };

export async function loopbackGet(url: string, options: { fetch?: FetchLike; timeoutMs?: number; maxBytes?: number } = {}): Promise<LoopbackResult> {
  if (!isLoopbackHttpUrl(url)) return { ok: false, reason: "not-loopback" };
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const maxBytes = options.maxBytes ?? PINOKIO_HTTP_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? PINOKIO_HTTP_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", signal: controller.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
    } catch {
      return { ok: false, reason: timedOut ? "timeout" : "offline" };
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "redirect" };
    }
    if (Number(res.headers.get("content-length") ?? "0") > maxBytes) {
      controller.abort();
      return { ok: false, reason: "too-large" };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      for (;;) {
        let part: Awaited<ReturnType<typeof reader.read>>;
        try {
          part = await reader.read();
        } catch {
          return { ok: false, reason: timedOut ? "timeout" : "offline" };
        }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return { ok: false, reason: "too-large" };
        }
        chunks.push(Buffer.from(part.value));
      }
    }
    return { ok: true, status: res.status, body: Buffer.concat(chunks).toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
}

