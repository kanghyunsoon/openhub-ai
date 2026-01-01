import type { FetchLike } from "../discovery/github";
import { parseNpmSpec } from "../installer/command";
import type { InstallBackend } from "../installer/plan";
import type { ArtifactIdentity } from "./state";

/**
 * Artifact Resolver(TASK-039, D-018). requested spec → resolved identity.
 * - npm: GET https://registry.npmjs.org/<name>/<tag>(scoped는 %2f) → name@X.Y.Z (+ dist.integrity 참고 정보)
 * - PyPI: GET https://pypi.org/pypi/<name>/json → name==version
 * - Docker: 익명 token → HEAD /v2/<repo>/manifests/<tag>의 Docker-Content-Digest → image@sha256:<64hex>
 * - 허용 host 밖은 RESOLVER_SOURCE_UNSUPPORTED(fetch 0회). 요청당 10초, 응답 상한 npm·Docker 1 MiB·PyPI 8 MiB. cache 없음.
 * - 사용자 credential·cookie를 보내지 않고 process.env를 읽지 않는다. 익명 registry token은 결과에 남기지 않는다.
 * - Plan 생성(update·rollback·check)과 실행 직전 재생성에서만 호출한다. status·recommend·install은 호출하지 않는다.
 */

export const RESOLVER_ALLOWED_HOSTS = ["registry.npmjs.org", "pypi.org", "ghcr.io", "registry-1.docker.io", "auth.docker.io"] as const;
export const RESOLVER_TIMEOUT_MS = 10_000;
export const RESOLVER_MAX_BYTES = { npm: 1024 * 1024, docker: 1024 * 1024, pypi: 8 * 1024 * 1024 } as const;

export type ResolverErrorCode = "RESOLVER_SOURCE_UNSUPPORTED" | "RESOLUTION_TIMEOUT" | "RESOLUTION_OFFLINE" | "RESOLUTION_TOO_LARGE" | "RESOLUTION_INVALID";
export type ResolveResult = { ok: true; identity: ArtifactIdentity; fetched: boolean } | { ok: false; code: ResolverErrorCode; message: string };

export interface ResolverOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

class ResolveError extends Error {
  constructor(
    readonly code: ResolverErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const NPM_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const PY_VERSION = /^[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc|\.post|\.dev)[0-9]+)*$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;

function allowed(url: string): boolean {
  const u = new URL(url);
  return u.protocol === "https:" && u.username === "" && u.password === "" && (RESOLVER_ALLOWED_HOSTS as readonly string[]).includes(u.hostname);
}

/** allowlist·timeout·응답 상한을 지키는 단일 요청. credential·cookie 없음. */
async function request(url: string, init: { method: "GET" | "HEAD"; headers?: Record<string, string> }, maxBytes: number, options: ResolverOptions): Promise<{ status: number; headers: Headers; body: string }> {
  if (!allowed(url)) throw new ResolveError("RESOLVER_SOURCE_UNSUPPORTED", "허용하지 않은 registry입니다");
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? RESOLVER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(url, { method: init.method, headers: { ...(init.headers ?? {}) }, signal: controller.signal, credentials: "omit", redirect: "error" });
    } catch {
      throw new ResolveError(timedOut ? "RESOLUTION_TIMEOUT" : "RESOLUTION_OFFLINE", timedOut ? "registry 응답이 제한 시간을 넘었습니다" : "registry에 연결하지 못했습니다(오프라인)");
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      controller.abort();
      throw new ResolveError("RESOLUTION_TOO_LARGE", "registry 응답이 크기 상한을 넘었습니다");
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
          throw new ResolveError(timedOut ? "RESOLUTION_TIMEOUT" : "RESOLUTION_OFFLINE", "registry 응답을 끝까지 읽지 못했습니다");
        }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new ResolveError("RESOLUTION_TOO_LARGE", "registry 응답이 크기 상한을 넘었습니다");
        }
        chunks.push(part.value);
      }
      body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    }
    if (response.status === 429 || response.status >= 500) throw new ResolveError("RESOLUTION_OFFLINE", "registry를 지금 사용할 수 없습니다(" + String(response.status) + ")");
    if (response.status < 200 || response.status >= 300) throw new ResolveError("RESOLUTION_INVALID", "registry가 artifact를 찾지 못했습니다(" + String(response.status) + ")");
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

function json(body: string): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(body);
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
  } catch {
    // 아래에서 형식 오류로 처리한다.
  }
  throw new ResolveError("RESOLUTION_INVALID", "registry 응답 형식이 올바르지 않습니다");
}

async function resolveNpm(spec: string, options: ResolverOptions): Promise<ResolveResult> {
  const parsed = parseNpmSpec(spec);
  if (parsed === null) throw new ResolveError("RESOLUTION_INVALID", "npm 패키지 이름을 해석하지 못했습니다");
  if (parsed.version !== null && EXACT_SEMVER.test(parsed.version)) {
    return { ok: true, fetched: false, identity: { kind: "npm-package", spec: parsed.name + "@" + parsed.version, version: parsed.version, digest: null, integrity: null, source: "npm-registry" } };
  }
  const tag = parsed.version ?? "latest";
  if (!NPM_TAG.test(tag)) throw new ResolveError("RESOLUTION_INVALID", "버전 범위는 확정할 수 없습니다. dist-tag나 정확한 버전을 쓰세요");
  const name = parsed.name.startsWith("@") ? parsed.name.replace("/", "%2f") : parsed.name;
  const res = await request("https://registry.npmjs.org/" + name + "/" + tag, { method: "GET", headers: { accept: "application/json" } }, RESOLVER_MAX_BYTES.npm, options);
  const doc = json(res.body);
  const version = doc["version"];
  const integrity = (doc["dist"] as Record<string, unknown> | undefined)?.["integrity"];
  if (doc["name"] !== parsed.name || typeof version !== "string" || !EXACT_SEMVER.test(version)) throw new ResolveError("RESOLUTION_INVALID", "npm registry가 정확한 버전을 돌려주지 않았습니다");
  return {
    ok: true,
    fetched: true,
    identity: { kind: "npm-package", spec: parsed.name + "@" + version, version, digest: null, integrity: typeof integrity === "string" && INTEGRITY.test(integrity) && integrity.length <= 200 ? integrity : null, source: "npm-registry" },
  };
}

async function resolvePypi(spec: string, options: ResolverOptions): Promise<ResolveResult> {
  const exact = /^([^=]+)==(.+)$/u.exec(spec);
  if (exact !== null) {
    if (!PY_NAME.test(exact[1]!) || !PY_VERSION.test(exact[2]!)) throw new ResolveError("RESOLUTION_INVALID", "Python 패키지 spec 형식이 올바르지 않습니다");
    return { ok: true, fetched: false, identity: { kind: "python-package", spec, version: exact[2]!, digest: null, integrity: null, source: "pypi" } };
  }
  if (!PY_NAME.test(spec)) throw new ResolveError("RESOLUTION_INVALID", "버전 범위·extras가 있는 Python spec은 확정할 수 없습니다");
  const res = await request("https://pypi.org/pypi/" + spec + "/json", { method: "GET", headers: { accept: "application/json" } }, RESOLVER_MAX_BYTES.pypi, options);
  const info = json(res.body)["info"] as Record<string, unknown> | undefined;
  const version = info?.["version"];
  const name = info?.["name"];
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.]+/gu, "-");
  if (typeof version !== "string" || !PY_VERSION.test(version) || typeof name !== "string" || normalize(name) !== normalize(spec)) {
    throw new ResolveError("RESOLUTION_INVALID", "PyPI가 정확한 버전을 돌려주지 않았습니다");
  }
  return { ok: true, fetched: true, identity: { kind: "python-package", spec: spec + "==" + version, version, digest: null, integrity: null, source: "pypi" } };
}

interface ImageRef {
  original: string;
  host: "ghcr.io" | "registry-1.docker.io";
  repo: string;
  tag: string;
  digest: string | null;
}

export function parseImageRef(image: string): ImageRef | null {
  const at = image.indexOf("@");
  const digest = at === -1 ? null : image.slice(at + 1);
  const named = at === -1 ? image : image.slice(0, at);
  const parts = named.split("/");
  const first = parts[0]!;
  const hasHost = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const hostPart = hasHost ? first : "docker.io";
  const rest = hasHost ? parts.slice(1).join("/") : named;
  const colon = rest.lastIndexOf(":");
  const repoName = colon === -1 ? rest : rest.slice(0, colon);
  const tag = colon === -1 ? "latest" : rest.slice(colon + 1);
  if (digest !== null && !DIGEST.test(digest)) return null;
  if (hostPart === "ghcr.io") return { original: named.slice(0, named.length - (colon === -1 ? 0 : tag.length + 1)), host: "ghcr.io", repo: repoName, tag, digest };
  if (hostPart === "docker.io" || hostPart === "index.docker.io") {
    return { original: named.slice(0, named.length - (colon === -1 ? 0 : tag.length + 1)), host: "registry-1.docker.io", repo: repoName.includes("/") ? repoName : "library/" + repoName, tag, digest };
  }
  return null;
}

async function resolveDocker(image: string, options: ResolverOptions): Promise<ResolveResult> {
  const ref = parseImageRef(image);
  if (ref === null) throw new ResolveError("RESOLVER_SOURCE_UNSUPPORTED", "ghcr.io·Docker Hub 이외의 image registry는 지원하지 않습니다");
  if (ref.digest !== null) {
    return { ok: true, fetched: false, identity: { kind: "container-image", spec: ref.original + "@" + ref.digest, version: null, digest: ref.digest, integrity: null, source: "docker-registry" } };
  }
  const tokenUrl =
    ref.host === "ghcr.io"
      ? "https://ghcr.io/token?scope=repository:" + ref.repo + ":pull"
      : "https://auth.docker.io/token?service=registry.docker.io&scope=repository:" + ref.repo + ":pull";
  const tokenDoc = json((await request(tokenUrl, { method: "GET", headers: { accept: "application/json" } }, RESOLVER_MAX_BYTES.docker, options)).body);
  const token = tokenDoc["token"] ?? tokenDoc["access_token"];
  if (typeof token !== "string" || token.length === 0 || token.length > 16384) throw new ResolveError("RESOLUTION_INVALID", "registry 익명 token을 받지 못했습니다");
  const head = await request(
    "https://" + ref.host + "/v2/" + ref.repo + "/manifests/" + ref.tag,
    {
      method: "HEAD",
      headers: {
        authorization: "Bearer " + token,
        accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    },
    RESOLVER_MAX_BYTES.docker,
    options,
  );
  const digest = head.headers.get("docker-content-digest");
  if (digest === null || !DIGEST.test(digest)) throw new ResolveError("RESOLUTION_INVALID", "registry가 image digest를 돌려주지 않았습니다");
  return { ok: true, fetched: true, identity: { kind: "container-image", spec: ref.original + "@" + digest, version: null, digest, integrity: null, source: "docker-registry" } };
}

/** requested spec(M4 Plan artifact.spec과 같은 형식)을 resolved identity로 바꾼다. */
export async function resolveArtifact(backend: InstallBackend, requested: string, options: ResolverOptions = {}): Promise<ResolveResult> {
  try {
    if (backend === "npx") return await resolveNpm(requested, options);
    if (backend === "uvx") return await resolvePypi(requested, options);
    return await resolveDocker(requested, options);
  } catch (error) {
    if (error instanceof ResolveError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "RESOLUTION_INVALID", message: "artifact를 확정하지 못했습니다" };
  }
}
