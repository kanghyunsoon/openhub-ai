import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { containsAbsolutePath } from "../analyzer/index";
import { CATALOG_FILE, isoDateOf } from "../catalog/catalog";
import { CANDIDATES_DIR, discoveryCandidateSchema, draftManifestOf, type DiscoveryCandidate } from "../discovery/candidates";
import { canonicalize } from "../installer/plan";
import { parseManifest } from "../manifest/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, redactSensitive } from "../recommendation/index";
import { fastManifestIssues } from "../registry-ci/fast-checks";
import { remoteValidateRegistry, type RemoteReport } from "../registry-ci/remote-checks";
import type { ReleaseFetchOptions } from "../release/fetch";

/**
 * Candidate Contribution Package — Phase A(TASK-064, D-031). DiscoveryCandidate에서 사람이 검토·제출할 local package를 만든다.
 * - 같은 Candidate + 같은 asOf면 같은 byte다. draft Manifest는 M6 규칙(package identity로만 install 생성, verification: draft)이다.
 * - README·description·install 문구 같은 비신뢰 텍스트는 실행 필드(install·command·package·image)에 쓰지 않는다.
 *   PR 본문에는 인용 블록으로만 넣는다.
 * - GitHub write 0: branch·fork·commit·push·PR·Draft PR·merge를 하지 않고 git·gh를 실행하지 않는다. 사용자가 실행할 명령만 적는다.
 * - remote validation은 options.remote를 명시할 때만(M6 allowlist·상한, 비인증). 기본 network 0.
 * - 출력 디렉터리가 이미 있으면 거부하고 경로 traversal을 거부한다. 파일에 절대 경로·token이 없다.
 */

export const CONTRIBUTION_DIR = "contrib";
export const CONTRIBUTION_FILES = ["manifest.yaml", "catalog.patch.yaml", "validation.json", "changes.diff", "pr-title.txt", "pr-body.md", "provenance.json", "COMMANDS.md"] as const;
export type ContributionFile = (typeof CONTRIBUTION_FILES)[number];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ContributionOptions {
  /** 준비일(catalog addedAt 초안·provenance). 주입한다. */
  asOf: Date;
  /** 현재 registry/catalog.yaml 원문(diff 기준). 없으면 빈 catalog로 본다. */
  catalogText: string | null;
  /** OpenHub 버전(provenance). */
  toolVersion: string;
  /** 명시할 때만 bounded remote validation(비인증). */
  remote?: ReleaseFetchOptions;
}

export type ContributionResult =
  | { ok: true; candidateId: string; status: "ready" | "insufficient-evidence"; files: Partial<Record<ContributionFile, string>> }
  | { ok: false; code: "CONTRIBUTION_INVALID_CANDIDATE" | "CONTRIBUTION_INVALID_ID"; message: string };

const lines = (text: string) => text.split("\n");
const quote = (text: string | null) =>
  text === null
    ? "> (none)"
    : lines(redactSensitive(text).replace(/\r\n?/gu, "\n"))
        .map((l) => "> " + l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " "))
        .join("\n");

/** 새 파일 추가 unified diff. */
function addFileDiff(file: string, content: string): string {
  const body = lines(content.endsWith("\n") ? content.slice(0, -1) : content);
  return ["diff --git a/" + file + " b/" + file, "new file mode 100644", "--- /dev/null", "+++ b/" + file, "@@ -0,0 +1," + String(body.length) + " @@", ...body.map((l) => "+" + l)].join("\n") + "\n";
}

/** catalog 끝에 한 줄을 더하는 unified diff(앞 3줄 context). 원문은 LF로 다룬다. */
function appendLineDiff(file: string, original: string, added: string): string {
  const text = original.replace(/\r\n/gu, "\n");
  const hadTrailing = text.endsWith("\n");
  const body = lines(hadTrailing ? text.slice(0, -1) : text);
  const ctx = body.slice(-3);
  const start = body.length - ctx.length + 1;
  const header = "@@ -" + String(start) + "," + String(ctx.length) + " +" + String(start) + "," + String(ctx.length + 1) + " @@";
  const out = ["diff --git a/" + file + " b/" + file, "--- a/" + file, "+++ b/" + file, header, ...ctx.map((l) => " " + l)];
  if (!hadTrailing) out.push("\\ No newline at end of file");
  out.push("+" + added);
  return out.join("\n") + "\n";
}

const EMPTY_CATALOG = "schemaVersion: 1\nkind: openhub-registry-catalog\ntools:\n";

/** local contribution package의 파일 내용을 만든다(쓰기 없음). */
export async function prepareContribution(input: unknown, options: ContributionOptions): Promise<ContributionResult> {
  const parsed = discoveryCandidateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "CONTRIBUTION_INVALID_CANDIDATE", message: "Candidate 형식이 올바르지 않거나 credential이 들어 있습니다" };
  const c: DiscoveryCandidate = parsed.data;
  if (!ID.test(c.id)) return { ok: false, code: "CONTRIBUTION_INVALID_ID", message: "candidate id 형식이 올바르지 않습니다" };
  const date = isoDateOf(options.asOf);
  const provenance =
    JSON.stringify(
      canonicalize({
        schemaVersion: 1,
        kind: "openhub-contribution-provenance",
        candidateId: c.id,
        repository: c.repository,
        package: c.package === null ? null : { kind: c.package.kind, name: c.package.name },
        sources: c.sources,
        evidence: c.evidence,
        confidence: c.confidence,
        discoveredAt: c.discoveredAt,
        preparedAt: date,
        preparedBy: "openhub " + options.toolVersion,
        untrustedText: {
          description: c.signals.description === null ? null : redactSensitive(c.signals.description),
          installText: c.untrustedInstallText === null ? null : redactSensitive(c.untrustedInstallText),
        },
      }),
      null,
      2,
    ) + "\n";

  const draft = draftManifestOf(c);
  if (draft === null) {
    const validation = JSON.stringify({ status: "insufficient-evidence", reason: "저장소와 package(npm·PyPI·docker) 근거가 모두 있어야 draft Manifest를 만들 수 있습니다" }, null, 2) + "\n";
    const commands = ["# " + c.id + " — insufficient evidence", "", "OpenHub did not create a draft Manifest for this Candidate (no repository or package evidence).", "Check the repository and package yourself and write the Manifest by hand. OpenHub does not run git or gh.", ""].join("\n");
    return { ok: true, candidateId: c.id, status: "insufficient-evidence", files: { "provenance.json": provenance, "validation.json": validation, "COMMANDS.md": commands } };
  }

  const manifestYaml = "# Draft Manifest generated by OpenHub from a Discovery Candidate. A human must review and complete it.\n" + stringifyYaml(draft);
  const manifest = parseManifest(manifestYaml);
  const fast = manifest.ok ? fastManifestIssues(manifest.manifest) : [];
  let remote: RemoteReport | null = null;
  if (options.remote !== undefined && manifest.ok) {
    remote = await remoteValidateRegistry([{ file: "mcp/" + c.id + ".yaml", directory: "mcp", manifest: manifest.manifest }], { ...options.remote, now: () => options.asOf });
  }
  const validation =
    JSON.stringify(
      canonicalize({
        schemaVersion: 1,
        kind: "openhub-contribution-validation",
        schema: manifest.ok ? "ok" : "invalid",
        schemaIssues: manifest.ok ? [] : manifest.issues.map((i) => i.path + ": " + i.message),
        fast: fast.map((i) => i.path + ": " + i.message),
        remote: remote === null ? "not-run (use --remote)" : remote.tools.map((t) => ({ repository: t.repository.status, releaseSource: t.releaseSource.status, license: t.repository.license })),
        humanReviewRequired: ["verification을 community 이상으로 올리기 전 사람이 저장소·package·설치 명령을 검토한다", "summary·capabilities·targets·platform·env를 사람이 채운다", "catalog addedAt을 실제 수용일로 바꾼다"],
      }),
      null,
      2,
    ) + "\n";
  const manifestPath = "registry/mcp/" + c.id + ".yaml";
  const catalogLine = "  " + c.id + ': { addedAt: "' + date + '" }';
  const catalogPatch = "# registry/catalog.yaml에 추가할 항목. addedAt은 maintainer가 실제 수용일로 바꾼다.\n" + catalogLine.trimStart() + "\n";
  const diff = addFileDiff(manifestPath, manifestYaml) + appendLineDiff("registry/" + CATALOG_FILE, options.catalogText ?? EMPTY_CATALOG, catalogLine);
  const title = "registry: add " + c.id + (c.package === null ? "" : " (" + c.package.kind + " " + c.package.name + ")") + " [draft]";
  const body = [
    "## Summary",
    "",
    "Adds a **draft** Registry Manifest for `" + c.id + "` prepared by OpenHub from a Discovery Candidate. It is UNVERIFIED until a maintainer reviews it.",
    "",
    "- Repository: " + (c.repository ?? "(none)"),
    "- Package: " + (c.package === null ? "(none)" : c.package.kind + " `" + c.package.name + "`"),
    "- Discovery confidence: " + c.confidence + " · sources: " + c.sources.join(", "),
    "",
    "## Provenance / evidence",
    "",
    ...c.evidence.map((e) => "- " + e.source + ": `" + e.ref + "`"),
    "",
    "## Validation",
    "",
    "- Schema: " + (manifest.ok ? "ok" : "invalid"),
    "- Fast checks: " + (fast.length === 0 ? "no issues" : fast.map((i) => i.path).join(", ") + " (draft Manifests are rejected until verification is raised)"),
    "- Remote checks: " + (remote === null ? "not run" : String(remote.problems) + " problem(s)"),
    "",
    "## Untrusted candidate text (quoted, not used for install commands)",
    "",
    "Description:",
    "",
    quote(c.signals.description),
    "",
    "Install text found in metadata:",
    "",
    quote(c.untrustedInstallText),
    "",
    "## Maintainer checklist",
    "",
    "- [ ] Review the repository and package; confirm the install command is built from the package name only",
    "- [ ] Fill summary, capabilities, targets, platform and env",
    "- [ ] Raise `verification` from `draft` to `community` only after human review",
    "- [ ] Set `addedAt` in registry/catalog.yaml to the actual acceptance date",
    "- [ ] `pnpm registry:validate` passes",
    "",
    "OpenHub did not create a branch, push, or open a pull request.",
    "",
  ].join("\n");
  const commands = [
    "# " + c.id + " contribution — commands for you to run",
    "",
    "OpenHub does not run git or gh and does not write to GitHub. Review the files in this folder, then run the commands yourself from a clone of the OpenHub repository.",
    "",
    "```sh",
    "git switch -c registry/add-" + c.id,
    "git apply <this-folder>/changes.diff",
    "# edit " + manifestPath + " (summary, capabilities, verification) after review",
    "pnpm registry:validate",
    "git add " + manifestPath + " registry/" + CATALOG_FILE,
    'git commit -m "' + title + '"',
    "git push -u origin registry/add-" + c.id,
    "gh pr create --draft --title " + JSON.stringify(title) + " --body-file <this-folder>/pr-body.md",
    "```",
    "",
  ].join("\n");
  const files: Record<ContributionFile, string> = {
    "manifest.yaml": manifestYaml,
    "catalog.patch.yaml": catalogPatch,
    "validation.json": validation,
    "changes.diff": diff,
    "pr-title.txt": title + "\n",
    "pr-body.md": body,
    "provenance.json": provenance,
    "COMMANDS.md": commands,
  };
  for (const [name, content] of Object.entries(files)) {
    // unified diff의 새 파일 머리말("--- /dev/null")은 git 형식의 고정 줄이라 경로 검사에서 뺀다.
    const checked = name === "changes.diff" ? content.replace(/^--- \/dev\/null$/gmu, "") : content;
    if (checked.split("\n").some((l) => containsAbsolutePath(l)) || TOKEN_PATTERN.test(content) || URL_CREDENTIAL_PATTERN.test(content)) {
      return { ok: false, code: "CONTRIBUTION_INVALID_CANDIDATE", message: name + "에 절대 경로·credential이 들어갈 수 있어 만들지 않았습니다" };
    }
  }
  return { ok: true, candidateId: c.id, status: "ready", files };
}

export type WriteContributionResult = { ok: true; dir: string; files: string[] } | { ok: false; code: "CONTRIBUTION_EXISTS" | "CONTRIBUTION_INVALID_ID" | "CONTRIBUTION_WRITE_FAILED"; message: string };

/** <outRoot>/<candidateId>/에 파일을 쓴다. 이미 있으면 거부(덮어쓰기 없음). 결과에는 논리 경로만 남는다. */
export async function writeContributionPackage(outRoot: string, prepared: Extract<ContributionResult, { ok: true }>): Promise<WriteContributionResult> {
  if (!ID.test(prepared.candidateId)) return { ok: false, code: "CONTRIBUTION_INVALID_ID", message: "candidate id 형식이 올바르지 않습니다" };
  const base = path.resolve(outRoot);
  const dir = path.join(base, prepared.candidateId);
  if (path.dirname(dir) !== base) return { ok: false, code: "CONTRIBUTION_INVALID_ID", message: "출력 경로가 지정한 폴더 밖입니다" };
  try {
    await mkdir(base, { recursive: true });
    await mkdir(dir); // 이미 있으면 EEXIST
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, code: "CONTRIBUTION_EXISTS", message: prepared.candidateId + " 폴더가 이미 있습니다. 덮어쓰지 않습니다" };
    return { ok: false, code: "CONTRIBUTION_WRITE_FAILED", message: "출력 폴더를 만들지 못했습니다" };
  }
  const written: string[] = [];
  for (const name of CONTRIBUTION_FILES) {
    const content = prepared.files[name];
    if (content === undefined) continue;
    await writeFile(path.join(dir, name), content, { flag: "wx" });
    written.push(prepared.candidateId + "/" + name);
  }
  return { ok: true, dir: prepared.candidateId, files: written };
}

/** registry-candidates/<id>.yaml(M6 discover 출력)에서 Candidate를 읽는다. id는 kebab-case만 받는다. */
export async function readCandidateFile(
  candidatesDir: string,
  id: string,
): Promise<{ ok: true; candidate: DiscoveryCandidate } | { ok: false; code: "CANDIDATE_NOT_FOUND" | "CONTRIBUTION_INVALID_ID" | "CONTRIBUTION_INVALID_CANDIDATE"; message: string }> {
  if (!ID.test(id)) return { ok: false, code: "CONTRIBUTION_INVALID_ID", message: "candidate id는 소문자·숫자·하이픈만 씁니다" };
  let text: string;
  try {
    text = await readFile(path.join(path.resolve(candidatesDir), id + ".yaml"), "utf8");
  } catch {
    return { ok: false, code: "CANDIDATE_NOT_FOUND", message: CANDIDATES_DIR + "/" + id + ".yaml이 없습니다(openhub discover로 먼저 만드세요)" };
  }
  try {
    const doc = parseYaml(text) as { candidate?: unknown };
    const parsed = discoveryCandidateSchema.safeParse(doc?.candidate);
    return parsed.success ? { ok: true, candidate: parsed.data } : { ok: false, code: "CONTRIBUTION_INVALID_CANDIDATE", message: "Candidate 파일 형식이 올바르지 않습니다" };
  } catch {
    return { ok: false, code: "CONTRIBUTION_INVALID_CANDIDATE", message: "Candidate 파일을 해석하지 못했습니다" };
  }
}

