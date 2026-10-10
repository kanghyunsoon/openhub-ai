import { BACKEND_ADAPTERS } from "../installer/backends";
import { checkCatalog, loadCatalog } from "../catalog/catalog";
import { isValidDockerImage, parseNpmSpec } from "../installer/command";
import { INSTALL_BACKENDS, type InstallBackend } from "../installer/plan";
import type { InstallStep, Manifest } from "../manifest/index";
import { readPinokioTemplate } from "../pinokio/compiler";
import { loadRegistry, type RegistryEntry, type RegistryIssue } from "../registry/load";
import { toolConfigIssues } from "../tool-config/index";

/**
 * Registry fast validation(TASK-054, D-025). PR마다 실행하며 network·spawn이 0이다(입력은 이미 읽은 Manifest뿐).
 * - registry 모듈은 installer를 import하지 않는다(CON-003). 그래서 이 검사는 registry-ci 모듈에 두고
 *   `registry validate`(validateRegistry)가 loadRegistry 결과에 적용한다.
 * - update.source ↔ 설치 adapter 정합: npm↔npx, pypi↔uvx, docker-tag↔docker는 엄격히, pinokio는 github-release·git만,
 *   git은 pinokio 전용. github-release는 repository.github가 늘 있으므로 지원 backend 어디에나 쓸 수 있다(TASK-048).
 * - 지원 backend: 우선 adapter는 npx·uvx·docker·pinokio만(M6). fallback의 npm·uv·pip·docker 단계는 package·image 문법만 본다.
 * - package·image 문법: 선언된 명령·package·image는 M4 Adapter의 launch 계획(strict tokenizer·parseNpmSpec·isValidDockerImage)을
 *   통과해야 한다. 선언이 없는 것(M1 v1 Manifest처럼 adapter만 있는 경우)은 "설치 불가"이지 문법 오류가 아니므로 통과시킨다.
 * - required env: 같은 이름이 두 번 나오면 오류다.
 * - Pinokio: options를 선언했다면 허용 template과 loopback http healthCheck(readPinokioTemplate)를 통과해야 한다.
 * 규칙을 어긴 항목은 entries에서 빼고 issues로만 보고한다(예외를 던지지 않는다).
 */

export const REGISTRY_SUPPORTED_BACKENDS = [...INSTALL_BACKENDS, "pinokio"] as const;
const STRICT_SOURCE: Readonly<Record<string, string>> = { npm: "npx", pypi: "uvx", "docker-tag": "docker" };
const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?(?:==[0-9][0-9A-Za-z.+!-]*)?$/u;

function stepOf(manifest: Manifest): InstallStep {
  return { adapter: manifest.install.preferredAdapter, ...(manifest.install.options === undefined ? {} : { options: manifest.install.options }) };
}
const optionString = (step: InstallStep, key: "package" | "image") => (typeof step[key] === "string" ? step[key] : typeof step.options?.[key] === "string" ? (step.options[key] as string) : undefined);

/** Manifest 하나의 fast 검사 결과(경로·메시지). */
export function fastManifestIssues(manifest: Manifest): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  out.push(...toolConfigIssues(manifest));
  const preferred = manifest.install.preferredAdapter;
  const source = manifest.update.source;
  if (!(REGISTRY_SUPPORTED_BACKENDS as readonly string[]).includes(preferred)) {
    out.push({ path: "install.preferredAdapter", message: "지원하지 않는 backend입니다(" + preferred + "). 우선 adapter는 " + REGISTRY_SUPPORTED_BACKENDS.join("·") + "만 쓸 수 있습니다" });
  }
  const strict = STRICT_SOURCE[source];
  if (strict !== undefined && strict !== preferred) out.push({ path: "update.source", message: "update.source(" + source + ")는 " + strict + " adapter와 함께 써야 합니다(현재 " + preferred + ")" });
  if (preferred === "pinokio" && source !== "github-release" && source !== "git") out.push({ path: "update.source", message: "pinokio adapter의 update.source는 github-release 또는 git이어야 합니다" });
  if (source === "git" && preferred !== "pinokio") out.push({ path: "update.source", message: "update.source git은 pinokio adapter에서만 씁니다" });

  if ((INSTALL_BACKENDS as readonly string[]).includes(preferred)) {
    const planned = BACKEND_ADAPTERS[preferred as InstallBackend].planLaunch(manifest, stepOf(manifest), "linux");
    if (!planned.ok && planned.kind === "rejected") out.push({ path: "install.options", message: "설치 명령·패키지·image가 올바르지 않습니다: " + planned.reason });
  }
  if (preferred === "pinokio" && manifest.install.options !== undefined && Object.keys(manifest.install.options).length > 0) {
    const spec = readPinokioTemplate(manifest);
    if (!spec.ok) out.push({ path: spec.code === "PINOKIO_HEALTH_UNSUPPORTED" ? "healthCheck" : "install.options", message: "Pinokio template 검사 실패(" + spec.code + "): " + spec.reason });
  }
  manifest.install.fallback.forEach((step, i) => {
    const at = "install.fallback[" + String(i) + "]";
    const pkg = optionString(step, "package");
    const image = optionString(step, "image");
    if ((INSTALL_BACKENDS as readonly string[]).includes(step.adapter)) {
      const planned = BACKEND_ADAPTERS[step.adapter as InstallBackend].planLaunch(manifest, step, "linux");
      if (!planned.ok && planned.kind === "rejected") out.push({ path: at, message: "설치 단계가 올바르지 않습니다: " + planned.reason });
    } else if (step.adapter === "npm") {
      if (pkg !== undefined && parseNpmSpec(pkg) === null) out.push({ path: at + ".package", message: "npm package 이름이 올바르지 않습니다" });
    } else if (step.adapter === "uv" || step.adapter === "pip") {
      if (pkg !== undefined && !PY_NAME.test(pkg)) out.push({ path: at + ".package", message: "Python package 이름이 올바르지 않습니다" });
    }
    if (image !== undefined && step.adapter === "docker" && !isValidDockerImage(image)) out.push({ path: at + ".image", message: "docker image 형식이 올바르지 않습니다" });
  });
  const names = manifest.env.map((e) => e.name);
  names.forEach((name, i) => {
    if (names.indexOf(name) !== i) out.push({ path: "env[" + String(i) + "]", message: "환경변수 " + name + "이(가) 두 번 선언됐습니다" });
  });
  // Discovery draft(TASK-055)는 사람이 검토해 verification을 올린 뒤에만 registry/에 들어간다.
  if (manifest.verification === "draft") out.push({ path: "verification", message: "draft Manifest는 registry/에 둘 수 없습니다. 사람이 검토·수정한 뒤 verification을 community 이상으로 바꾸세요" });
  return out;
}

export function checkRegistryConsistency(entries: readonly RegistryEntry[]): { entries: RegistryEntry[]; issues: RegistryIssue[] } {
  const issues: RegistryIssue[] = [];
  const kept: RegistryEntry[] = [];
  for (const entry of entries) {
    const found = fastManifestIssues(entry.manifest);
    for (const f of found) issues.push({ file: entry.file, ...f });
    if (found.length === 0) kept.push(entry);
  }
  return { entries: kept, issues };
}

export interface ValidateRegistryOptions {
  /** Catalog Metadata v1 검사(D-035). CLI registry validate·CI는 켠다. asOf는 미래 날짜 판정 기준일이다. */
  catalog?: { asOf: Date };
}

/** registry validate: loadRegistry(schema·이름·카테고리·alias) + fast 정합성 검사(+ catalog). network 0. */
export async function validateRegistry(root: string, options: ValidateRegistryOptions = {}): Promise<{ entries: RegistryEntry[]; issues: RegistryIssue[] }> {
  const loaded = await loadRegistry(root);
  const checked = checkRegistryConsistency(loaded.entries);
  const issues = [...loaded.issues, ...checked.issues];
  if (options.catalog !== undefined) {
    const catalog = await loadCatalog(root);
    // 1:1 비교는 schema를 통과한 Manifest 전체 기준이다(fast 정합성 실패로 빠진 Manifest도 catalog entry가 있어야 한다).
    issues.push(...(catalog.ok ? checkCatalog(catalog.catalog, loaded.entries, options.catalog.asOf) : catalog.issues));
  }
  return { entries: checked.entries, issues };
}

