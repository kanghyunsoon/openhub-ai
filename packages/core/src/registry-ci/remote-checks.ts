import { BACKEND_ADAPTERS } from "../installer/backends";
import { INSTALL_BACKENDS, type InstallBackend } from "../installer/plan";
import { installCandidates } from "../installer/router";
import type { Manifest } from "../manifest/index";
import { readPinokioTemplate } from "../pinokio/compiler";
import { ReleaseError, boundedRequest, parseJsonObject, type ReleaseFetchOptions } from "../release/fetch";
import { collectReleaseSnapshot, type ReleaseRequest, type VersionSource } from "../release/snapshot";
import type { RegistryEntry } from "../registry/load";

/**
 * Registry remote validation(TASK-054, D-025). GitHub Actions의 workflow_dispatch·schedule에서만 실행한다(사용자 PC timer 없음).
 * - 저장소 생존·archived·이름 이전·license(api.github.com/repos), release source 응답(= package·image 존재)을 Tool별로 보고한다.
 * - 요청 상한은 §4와 같다: allowlist host, timeout 10초, 응답 상한, redirect는 따라가지 않음(이전은 moved), retry·cache 없음.
 * - 인증 정보를 쓰지 않는다(비인증 REST). 결과는 보고서이며 Registry를 바꾸지 않는다.
 */

export const REMOTE_REPO_MAX_BYTES = 1024 * 1024;
export const REMOTE_REPOSITORY_STATUSES = ["ok", "archived", "moved", "not-found", "rate-limited", "unreachable", "error"] as const;
export const REMOTE_RELEASE_STATUSES = ["ok", "unreachable", "not-found", "moved", "rate-limited", "unsupported", "error"] as const;
export type RemoteRepositoryStatus = (typeof REMOTE_REPOSITORY_STATUSES)[number];
export type RemoteReleaseStatus = (typeof REMOTE_RELEASE_STATUSES)[number];

export interface RemoteToolReport {
  toolId: string;
  repo: string;
  repository: { status: RemoteRepositoryStatus; code: string | null; license: string | null };
  releaseSource: { source: VersionSource; status: RemoteReleaseStatus; code: string | null; latest: string | null };
}
export interface RemoteReport {
  schemaVersion: 1;
  checkedAt: string;
  tools: RemoteToolReport[];
  problems: number;
}

const repoStatusOf = (code: string): RemoteRepositoryStatus =>
  code === "RELEASE_SOURCE_MOVED" ? "moved" : code === "RELEASE_NOT_FOUND" ? "not-found" : code === "RELEASE_RATE_LIMITED" ? "rate-limited" : code === "RELEASE_TIMEOUT" || code === "RELEASE_OFFLINE" ? "unreachable" : "error";
const releaseStatusOf = (code: string): RemoteReleaseStatus =>
  code === "RELEASE_SOURCE_MOVED"
    ? "moved"
    : code === "RELEASE_NOT_FOUND"
      ? "not-found"
      : code === "RELEASE_RATE_LIMITED"
        ? "rate-limited"
        : code === "RELEASE_TIMEOUT" || code === "RELEASE_OFFLINE"
          ? "unreachable"
          : code === "RELEASE_SOURCE_UNSUPPORTED"
            ? "unsupported"
            : "error";

/** 저장소 메타데이터: archived·이전·license. */
export async function checkRepository(repo: string, options: ReleaseFetchOptions = {}): Promise<RemoteToolReport["repository"]> {
  try {
    const res = await boundedRequest(
      "https://api.github.com/repos/" + repo,
      { method: "GET", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "openhub-ai" }, maxBytes: REMOTE_REPO_MAX_BYTES, redirect: "manual" },
      options,
    );
    const doc = parseJsonObject(res.body);
    const license = doc["license"] !== null && typeof doc["license"] === "object" ? (doc["license"] as Record<string, unknown>)["spdx_id"] : null;
    const fullName = typeof doc["full_name"] === "string" ? doc["full_name"] : "";
    const licenseText = typeof license === "string" && /^[A-Za-z0-9.+-]{1,64}$/u.test(license) ? license : null;
    if (fullName.toLowerCase() !== repo.toLowerCase()) return { status: "moved", code: "RELEASE_SOURCE_MOVED", license: licenseText };
    return { status: doc["archived"] === true ? "archived" : "ok", code: null, license: licenseText };
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : "RELEASE_INVALID";
    return { status: repoStatusOf(code), code, license: null };
  }
}

/** Manifest의 버전 출처 요청(실행 artifact spec). 결정할 수 없으면 null. */
export function releaseRequestOf(manifest: Manifest): ReleaseRequest | null {
  const source = manifest.update.source;
  const preferred = manifest.install.preferredAdapter;
  if (source === "github-release") {
    const backend: InstallBackend = (INSTALL_BACKENDS as readonly string[]).includes(preferred) ? (preferred as InstallBackend) : "uvx";
    const pinokio = preferred === "pinokio" ? readPinokioTemplate(manifest) : null;
    const requested = pinokio !== null && pinokio.ok ? pinokio.value.package : manifest.name;
    return { toolId: manifest.name, versionSource: source, backend, requested, resolved: null, github: manifest.repository.github };
  }
  const backend = source === "npm" ? "npx" : source === "pypi" ? "uvx" : source === "docker-tag" ? "docker" : null;
  if (backend === null) return null;
  for (const { step } of installCandidates(manifest)) {
    if (step.adapter !== backend) continue;
    const planned = BACKEND_ADAPTERS[backend].planLaunch(manifest, step, "linux");
    if (planned.ok) return { toolId: manifest.name, versionSource: source, backend, requested: planned.value.artifact.spec, resolved: null };
  }
  return null;
}

/** Tool별 원격 검사. 실패해도 예외를 던지지 않고 보고서에 남긴다. */
export async function remoteValidateRegistry(entries: readonly RegistryEntry[], options: ReleaseFetchOptions & { now: () => Date }): Promise<RemoteReport> {
  const tools: RemoteToolReport[] = [];
  const fetchOptions: ReleaseFetchOptions = { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
  for (const { manifest } of [...entries].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))) {
    const repository = await checkRepository(manifest.repository.github, fetchOptions);
    const request = releaseRequestOf(manifest);
    let releaseSource: RemoteToolReport["releaseSource"];
    if (request === null) releaseSource = { source: manifest.update.source, status: "unsupported", code: "RELEASE_SOURCE_UNSUPPORTED", latest: null };
    else {
      const snap = await collectReleaseSnapshot(request, { ...fetchOptions, now: options.now });
      releaseSource = snap.ok
        ? { source: manifest.update.source, status: "ok", code: null, latest: snap.snapshot.target?.version ?? null }
        : { source: manifest.update.source, status: releaseStatusOf(snap.code), code: snap.code, latest: null };
    }
    tools.push({ toolId: manifest.name, repo: manifest.repository.github, repository, releaseSource });
  }
  const problems = tools.filter((t) => t.repository.status !== "ok" || t.releaseSource.status !== "ok").length;
  return { schemaVersion: 1, checkedAt: options.now().toISOString(), tools, problems };
}

/** job summary용 Markdown. 값은 상태 코드뿐이고 응답 본문은 넣지 않는다. */
export function formatRemoteReportMarkdown(report: RemoteReport): string {
  const lines = [
    "## Registry remote validation",
    "",
    "검사 시각 " + report.checkedAt + " · 문제 " + String(report.problems) + "개 (이 결과는 merge를 막지 않습니다)",
    "",
    "| Tool | 저장소 | 상태 | license | release source | 상태 | 최신 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const t of report.tools) {
    lines.push("| " + [t.toolId, t.repo, t.repository.status, t.repository.license ?? "-", t.releaseSource.source, t.releaseSource.status, t.releaseSource.latest ?? "-"].join(" | ") + " |");
  }
  return lines.join("\n") + "\n";
}

