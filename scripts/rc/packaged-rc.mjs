#!/usr/bin/env node
// v0.2.0 RC: 패키징된 OpenHub Desktop을 실제 백엔드(실제 npm·실제 MCP Health)로 실행해 RC 단계(3~14)를 확인한다.
// 격리 환경(일회용 CI runner·VM)에서만 쓴다. 사용자 프로필·자격증명·클러스터·DB를 쓰지 않는다(합성 프로젝트, 127.0.0.1 합성
// Kubernetes API, 가짜 token). 앱은 실제 바이너리 그대로 실행하며 smoke 모드(가짜 backend)를 쓰지 않는다.
// - 렌더러: --remote-debugging-port로 붙어 화면의 버튼을 누르는 기존 진입점(window.__openhub*)을 부른다.
// - main: --inspect로 붙어 네이티브 승인 대화상자(dialog.showMessageBox)에 정해진 응답(승인·거절·대화상자 중 파일 변경)을
//   돌려주고 제목·본문을 기록한다(사람이 누르는 것을 대신한다). 그 밖의 main 동작은 바꾸지 않는다.
// 사용:
//   node scripts/rc/packaged-rc.mjs run --exe <app> --work <dir> --out <json> [--os windows|linux] [--arg <extra electron arg>]...
//   node scripts/rc/packaged-rc.mjs snapshot --work <dir> --out <json>   (설정·Version State byte digest, 제거 전후 비교용)
//   node scripts/rc/packaged-rc.mjs compare <before.json> <after.json>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = (name) => argv.flatMap((a, i) => (a === "--" + name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 합성 데이터
const TOKEN = ["openhub", "rc", "fake", "bearer", "4417"].join("-");
const SECRET_PLAIN = ["openhub", "rc", "fake", "secret", "value"].join("-");
const SECRET_B64 = Buffer.from(SECRET_PLAIN).toString("base64");
const meta = (name) => ({ name, namespace: "default", uid: name + "-uid", resourceVersion: "1", creationTimestamp: "2026-10-01T00:00:00Z" });
const secret = { apiVersion: "v1", kind: "Secret", metadata: meta("demo"), type: "Opaque", data: { password: SECRET_B64 } };
const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: meta("app-config"), data: { LOG_LEVEL: "info" } };
const ROUTES = {
  "/version": { major: "1", minor: "31", gitVersion: "v1.31.0" },
  "/api": { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] },
  "/apis": { kind: "APIGroupList", apiVersion: "v1", groups: [] },
  "/api/v1": {
    kind: "APIResourceList",
    groupVersion: "v1",
    resources: [
      { name: "secrets", singularName: "secret", namespaced: true, kind: "Secret", verbs: ["get", "list"] },
      { name: "configmaps", singularName: "configmap", namespaced: true, kind: "ConfigMap", verbs: ["get", "list"] },
      { name: "pods", singularName: "pod", namespaced: true, kind: "Pod", verbs: ["get", "list"] },
      { name: "namespaces", singularName: "namespace", namespaced: false, kind: "Namespace", verbs: ["get", "list"] },
    ],
  },
  "/api/v1/namespaces/default/secrets/demo": secret,
  "/api/v1/namespaces/default/secrets": { kind: "SecretList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [secret] },
  "/api/v1/namespaces/default/configmaps/app-config": configMap,
};
const CALLS = [
  { name: "resources_get", arguments: { apiVersion: "v1", kind: "Secret", namespace: "default", name: "demo" } },
  { name: "resources_list", arguments: { apiVersion: "v1", kind: "Secret", namespace: "default" } },
  { name: "resources_get", arguments: { apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "app-config" } },
];
const BANNED = ["configuration_view", "pods_delete", "pods_exec", "pods_run", "resources_create_or_update", "resources_delete", "resources_scale"];
const NOTES = { command: "uvx", args: ["notes-mcp==1.0.0"] };
const CURSOR_USER = '{\n  "theme": "dark",\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
const CODEX_USER = '# my codex settings\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';
const PROJECT_MCP = JSON.stringify({ mcpServers: { notes: NOTES } }, null, 2) + "\n";
const PROJECT_FILES = {
  "package.json": '{ "name": "rc-ops", "private": true }\n',
  ".mcp.json": PROJECT_MCP,
  "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n",
  "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
};

async function startFakeApi() {
  const requests = [];
  const api = http.createServer((req, res) => {
    const p = (req.url ?? "").split("?")[0];
    requests.push(p);
    const body = ROUTES[p];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { kind: "Status", apiVersion: "v1", status: "Failure", code: 404, reason: "NotFound" }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", () => r()));
  return { port: api.address().port, requests, close: () => api.close() };
}

// ---------------------------------------------------------------- CDP
async function targetsOf(port, type, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      const found = list.find((t) => (type === "page" ? t.type === "page" && !String(t.url).startsWith("devtools") : true) && t.webSocketDebuggerUrl);
      if (found) return found.webSocketDebuggerUrl;
    } catch {
      // 아직 열리지 않음
    }
    await sleep(500);
  }
  throw new Error("CDP target not found on port " + port);
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP connect failed " + url)));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const k = ++id;
      const timer = setTimeout(() => (pending.delete(k), reject(new Error("CDP timeout " + method))), timeoutMs);
      pending.set(k, (m) => (clearTimeout(timer), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: k, method, params }));
    });
  const evaluate = async (expression, timeoutMs = 120000) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error("evaluate failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + " :: " + expression.slice(0, 120));
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

// ---------------------------------------------------------------- 앱 실행
const PATCH_DIALOG = String.raw`(async () => {
  const { dialog, app } = process.mainModule.require("electron");
  const fs = process.mainModule.require("node:fs");
  // inspector는 앱이 준비되기 전에 붙을 수 있다(Linux에서 실측). 준비된 뒤에 대화상자를 바꾸고 언어를 읽는다.
  await app.whenReady();
  globalThis.__rcDialogs = globalThis.__rcDialogs || [];
  globalThis.__rcAnswers = globalThis.__rcAnswers || [];
  dialog.showMessageBox = async (a, b) => {
    const o = b === undefined ? a : b;
    const next = globalThis.__rcAnswers.length > 0 ? globalThis.__rcAnswers.shift() : { action: "approve" };
    if (next.mutate) fs.writeFileSync(next.mutate.file, next.mutate.text);
    globalThis.__rcDialogs.push({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons, action: next.action, mutated: Boolean(next.mutate) });
    return { response: next.action === "approve" ? 1 : 0, checkboxChecked: false };
  };
  return { userData: app.getPath("userData"), home: process.mainModule.require("node:os").homedir(), systemLanguages: [...app.getPreferredSystemLanguages(), app.getSystemLocale()] };
})()`;

async function launch(ctx, extraEnv = {}) {
  const env = { ...process.env, ...ctx.env, ...extraEnv };
  delete env.OPENHUB_REGISTRY;
  delete env.OPENHUB_METADATA;
  for (const k of Object.keys(env)) if (k.startsWith("OPENHUB_SMOKE_") && k !== "OPENHUB_SMOKE_PROJECT") delete env[k];
  // userData도 작업 폴더 안(--user-data-dir)으로 격리한다(Windows는 APPDATA 환경 변수를 따르지 않는다).
  const args = [...ctx.extraArgs, "--user-data-dir=" + ctx.userDataDir, "--inspect=" + ctx.inspectPort, "--remote-debugging-port=" + ctx.cdpPort];
  const child = spawn(ctx.exe, args, { env, cwd: ctx.work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  ctx.children.push(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  const exited = new Promise((r) => child.on("close", (code) => r(code)));
  let main;
  let page;
  let info;
  let tools;
  try {
    main = await connect(await targetsOf(ctx.inspectPort, "node"));
    info = await main.evaluate(PATCH_DIALOG);
    page = await connect(await targetsOf(ctx.cdpPort, "page"));
    await page.evaluate("new Promise((r) => { const f = () => (window.__openhubReady !== undefined ? r(true) : setTimeout(f, 200)); f(); })");
    tools = await page.evaluate("Promise.resolve(window.__openhubReady)");
  } catch (error) {
    // 붙지 못했으면 앱을 남기지 않는다(남으면 하네스가 끝나지 않는다).
    child.kill();
    main?.close();
    page?.close();
    ctx.logs.push(log.slice(-4000));
    throw error;
  }
  const quit = async () => {
    try {
      await main.evaluate('process.mainModule.require("electron").app.quit(), true', 5000);
    } catch {
      // 이미 닫힘
    }
    const code = await Promise.race([exited, sleep(30000).then(() => "timeout")]);
    if (code === "timeout") child.kill();
    main.close();
    page.close();
    ctx.logs.push(log.slice(-4000));
  };
  const answers = (list) => main.evaluate("globalThis.__rcAnswers.push(..." + JSON.stringify(list) + "), true");
  const dialogs = () => main.evaluate("globalThis.__rcDialogs.splice(0)");
  const reloadReady = () => page.evaluate("new Promise((r) => { const f = () => (document.readyState === 'complete' && window.__openhubReady !== undefined ? r(true) : setTimeout(f, 200)); f(); })");
  return { page, main, info, tools, quit, answers, dialogs, reloadReady };
}

// ---------------------------------------------------------------- MCP stdio 세션(앱이 쓴 Client 설정 그대로)
async function mcpSession(command, args, cwd, env) {
  const windows = process.platform === "win32";
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !windows });
  let buffer = "";
  let transcript = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    transcript += d.toString();
    buffer += d.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number") waiters.get(m.id)?.(m);
      } catch {
        // 로그 줄
      }
    }
  });
  child.stderr.on("data", (d) => (transcript += d.toString()));
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const k = ++id;
      const timer = setTimeout(() => reject(new Error("timeout " + method)), 180000);
      waiters.set(k, (m) => (clearTimeout(timer), resolve(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n");
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhub-rc", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await request("tools/list", {})).result.tools;
    const replies = [];
    for (const c of CALLS) replies.push(await request("tools/call", c));
    return { tools, replies, transcript };
  } finally {
    try {
      if (windows) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      // 이미 끝남
    }
  }
}

/** Codex TOML에서 [mcp_servers.<name>] 블록의 command·args(문자열 배열)를 읽는다(OpenHub가 쓴 형식). */
function codexEntry(text, name) {
  const start = text.indexOf("[mcp_servers." + name + "]");
  if (start < 0) return null;
  const block = text.slice(start).split(/\n\[/u)[0];
  const command = /^command = (".*")$/mu.exec(block);
  const args = /^args = (\[.*\])$/mu.exec(block);
  return command && args ? { command: JSON.parse(command[1]), args: JSON.parse(args[1]) } : null;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------------------------------------------------------------- run
async function run() {
  const exe = path.resolve(opt("exe"));
  const work = path.resolve(opt("work"));
  const out = path.resolve(opt("out"));
  const osName = opt("os") ?? (process.platform === "win32" ? "windows" : "linux");
  const results = { os: osName, exe: path.basename(exe), startedAt: new Date().toISOString(), steps: {}, checks: {}, notRun: [], dialogs: [], errors: [] };
  const step = (n, status, evidence) => (results.steps[n] = { status, evidence });
  const check = (name, ok, evidence) => (results.checks[name] = { status: ok ? "PASS" : "FAIL", evidence });
  const home = path.join(work, "home");
  const project = path.join(work, "project");
  const empty = path.join(work, "empty");
  await mkdir(work, { recursive: true });
  for (const [rel, text] of Object.entries(PROJECT_FILES)) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), text);
  }
  await mkdir(empty, { recursive: true });
  await writeFile(path.join(empty, "README.md"), "# notes\nWe might use React, PostgreSQL and Kubernetes later.\n");
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), CURSOR_USER);
  await writeFile(path.join(home, ".codex", "config.toml"), CODEX_USER);
  const api = await startFakeApi();
  const kubeconfig = path.join(work, "kubeconfig.yaml");
  await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'http://127.0.0.1:" + api.port + "' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake, namespace: default }\ncurrent-context: fake\nusers:\n- name: fake\n  user: { token: " + TOKEN + " }\n");
  const ctx = {
    exe,
    work,
    logs: [],
    extraArgs: opts("arg"),
    children: [],
    userDataDir: path.join(work, "user-data"),
    inspectPort: 9339,
    cdpPort: 9333,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(work, "xdg"),
      OPENHUB_SMOKE_PROJECT: project,
      KUBECONFIG: kubeconfig,
      npm_config_cache: path.join(work, "npm-cache"),
      ...(osName === "linux" ? { LANG: "en_US.UTF-8", LANGUAGE: "en_US" } : {}),
    },
  };
  const p = (rel) => path.join(project, rel);
  const read = (f) => readFile(f, "utf8").catch(() => null);
  const ev = (app, expr, t) => app.page.evaluate(expr, t);
  const progress = (msg) => console.log("[rc " + new Date().toISOString().slice(11, 19) + "] " + msg);
  let app;
  try {
    // ---- 3 신규 사용자 첫 실행
    progress("launch 1");
    app = await launch(ctx);
    results.environment = { userData: path.relative(work, app.info.userData).startsWith("..") ? "outside work dir (runner profile)" : "work/" + path.relative(work, app.info.userData).replace(/\\/gu, "/"), homeIsolated: path.resolve(app.info.home) === path.resolve(home) };
    const onboarding = await ev(app, "window.__openhubOnboarding()");
    const i18n0 = await ev(app, "window.__openhubI18n()");
    // 첫 언어는 OS 언어를 따른다(첫 번째 선호 언어가 ko 계열이면 한국어, 그 밖에는 English).
    const expectedLocale = /^ko([-_]|$)/iu.test(String(app.info.systemLanguages[0] ?? "")) ? "ko" : "en";
    step(3, app.tools > 0 && onboarding.visible && i18n0.locale === expectedLocale && i18n0.missingKeys.length === 0 && results.environment.homeIsolated ? "PASS" : "FAIL", { tools: app.tools, onboarding, locale: i18n0.locale, expectedLocale, systemLanguage: app.info.systemLanguages[0], missingKeys: i18n0.missingKeys.length, environment: results.environment });

    // ---- 4 분석·추천
    progress("step 3 " + results.steps[3].status);
    const scanned = await ev(app, "window.__openhubScanProject()");
    const recCount = await ev(app, "window.__openhubRecommend()");
    const diag = await ev(app, "window.__openhubForYouDiagnosis()");
    const recIds = await ev(app, "[...document.querySelectorAll('#for-you-list li.rec')].map((li) => li.dataset.toolId)");
    const step4 = { scanned, recommended: recCount, ids: recIds, verification: diag.verification };

    // ---- 7 거절 → 쓰기 0, 승인 중 외부 변경 → PLAN_STALE(덮어쓰지 않음)
    const mcpBefore = await read(p(".mcp.json"));
    await app.answers([{ action: "reject" }]);
    const rejected = await ev(app, "window.__openhubInstall('memory-mcp', ['claude-code'])", 900000);
    const afterReject = await read(p(".mcp.json"));
    const external = JSON.stringify({ mcpServers: { notes: NOTES, external: { command: "uvx", args: ["external-mcp==1.0.0"] } } }, null, 2) + "\n";
    await app.answers([{ action: "approve", mutate: { file: p(".mcp.json"), text: external } }]);
    const stale = await ev(app, "window.__openhubInstall('memory-mcp', ['claude-code'])", 900000);
    const afterStale = await read(p(".mcp.json"));
    check("reject-writes-nothing", rejected.status === "rejected" && afterReject === mcpBefore, { status: rejected.status });
    check("plan-stale-blocks-and-keeps-external-change", stale.status === "stale" && afterStale === external, { status: stale.status });
    await writeFile(p(".mcp.json"), PROJECT_MCP);

    // ---- 5·6·7 설치 승인(Claude Code 프로젝트), 기존 항목 보존
    progress("reject/stale checks done");
    await ev(app, "window.__openhubRecommend()");
    const memInstall = await ev(app, "window.__openhubInstall('memory-mcp', ['claude-code'])", 900000);
    const mcpDoc = JSON.parse((await read(p(".mcp.json"))) ?? "{}");
    const installDialogs = await app.dialogs();
    results.dialogs.push(...installDialogs.map((d) => ({ title: d.title, action: d.action, mutated: d.mutated, lines: String(d.detail).split("\n").length })));
    const approvalOk = memInstall.status === "succeeded" && mcpDoc.mcpServers?.memory !== undefined && JSON.stringify(mcpDoc.mcpServers?.notes) === JSON.stringify(NOTES);
    step(7, approvalOk && results.checks["reject-writes-nothing"].status === "PASS" ? "PASS" : "FAIL", { reject: rejected.status, stale: stale.status, install: memInstall.status, configChanges: memInstall.configChanges, dialogsSeen: installDialogs.length });

    // ---- 14·6 다른 Client·Scope 추가(이미 사용 중 → [다른 Client·범위에 추가]), 사용자 범위 승인
    // 사람처럼 프로젝트를 다시 분석해야 추천이 새 설치를 반영한다(분석 결과는 [프로젝트 선택] 때만 바뀐다).
    await ev(app, "window.__openhubScanProject()");
    await ev(app, "window.__openhubRecommend()");
    const addUser = await ev(app, "window.__openhubInstall('memory-mcp', ['cursor'], null, 'user')", 900000);
    const cursorUser = JSON.parse((await read(path.join(home, ".cursor", "mcp.json"))) ?? "{}");
    const codexUserAfter = await read(path.join(home, ".codex", "config.toml"));
    const userOk = addUser.status === "succeeded" && addUser.entryNote === true && (addUser.requirements ?? []).includes("user-scope-config") && cursorUser.theme === "dark" && JSON.stringify(cursorUser.mcpServers?.notes) === JSON.stringify(NOTES) && cursorUser.mcpServers?.memory !== undefined && codexUserAfter === CODEX_USER;
    step(6, userOk ? "PASS" : "FAIL", { status: addUser.status, requirements: addUser.requirements, configChanges: addUser.configChanges, otherUserEntriesKept: cursorUser.theme === "dark" && codexUserAfter === CODEX_USER });

    // ---- Kubernetes(Codex 프로젝트), Client 검증 수준
    progress("steps 6/7 " + results.steps[6].status + "/" + results.steps[7].status);
    await ev(app, "window.__openhubRecommend()");
    const k8s = await ev(app, "window.__openhubInstall('kubernetes-mcp-server', ['codex'])", 1200000);
    const choices = Object.fromEntries((k8s.choices ?? []).map((c) => [c.client, c.verification]));
    const toolConfigs = walk(path.join(home, ".openhub", "tool-config")).filter((f) => f.endsWith("config.toml"));
    step(5, k8s.status === "succeeded" && (k8s.configChanges ?? []).length === 1 && choices.cursor === "not-verified" ? "PASS" : "FAIL", { status: k8s.status, configChanges: k8s.configChanges, verification: choices });
    // 같은 대상 재요청 → 변경 없음
    await ev(app, "window.__openhubScanProject()");
    await ev(app, "window.__openhubRecommend()");
    const again = await ev(app, "window.__openhubInstall('kubernetes-mcp-server', ['codex'])", 600000);
    // Codex 사용자 범위 추가(Kubernetes)
    const addCodexUser = await ev(app, "window.__openhubInstall('kubernetes-mcp-server', ['codex'], null, 'user')", 1200000);
    step(14, addUser.status === "succeeded" && again.status === "no-op" && addCodexUser.status === "succeeded" ? "PASS" : "FAIL", { addCursorUser: addUser.status, sameTarget: again.status, addCodexUser: addCodexUser.status, codexUserStillStartsWithOriginal: String(await read(path.join(home, ".codex", "config.toml"))).startsWith(CODEX_USER) });

    // ---- 8 실제 MCP Health
    progress("steps 5/14 " + results.steps[5].status + "/" + results.steps[14].status);
    await ev(app, "window.__openhubUserScopeOff('memory-mcp')");
    const memHealth = await ev(app, "window.__openhubLifecycleRun('memory-mcp', 'health')", 600000);
    const k8sHealth = await ev(app, "window.__openhubLifecycleRun('kubernetes-mcp-server', 'health')", 600000);
    const codexToml = (await read(p(".codex/config.toml"))) ?? "";
    const entry = codexEntry(codexToml, "kubernetes");
    let mcp = null;
    if (entry !== null) {
      const before = api.requests.filter((r) => r.includes("/secrets")).length;
      const s = await mcpSession(entry.command, entry.args, project, { ...process.env, ...ctx.env });
      const [getSecret, listSecret, getConfigMap] = s.replies;
      mcp = {
        tools: s.tools.length,
        secretGetDenied: /resource not allowed/u.test(JSON.stringify(getSecret)),
        secretListDenied: /resource not allowed/u.test(JSON.stringify(listSecret)),
        configMapRead: JSON.stringify(getConfigMap).includes("LOG_LEVEL"),
        bannedExposed: BANNED.filter((b) => s.tools.some((t) => t.name === b)),
        tokenInTranscript: s.transcript.includes(TOKEN) || s.transcript.includes(SECRET_PLAIN) || s.transcript.includes(SECRET_B64),
        secretRequestsToApi: api.requests.filter((r) => r.includes("/secrets")).length - before,
      };
    }
    const healthOk = memHealth.status === "health-checked" && memHealth.outcome === "succeeded" && k8sHealth.status === "health-checked" && k8sHealth.outcome === "succeeded";
    const mcpOk = mcp !== null && mcp.secretGetDenied && mcp.secretListDenied && mcp.configMapRead && mcp.bannedExposed.length === 0 && !mcp.tokenInTranscript && mcp.secretRequestsToApi === 0;
    check("kubernetes-secret-denied-configmap-read-no-token", mcpOk, mcp);
    check("kubernetes-reviewed-tool-config", toolConfigs.length >= 1 && toolConfigs.every((f) => readFileSync(f, "utf8").includes('kind = "Secret"')), { files: toolConfigs.length });
    step(8, healthOk && mcpOk ? "PASS" : "FAIL", { memory: { status: memHealth.status, outcome: memHealth.outcome, lines: memHealth.lines }, kubernetes: { status: k8sHealth.status, outcome: k8sHealth.outcome, lines: k8sHealth.lines }, mcp });

    // ---- 9·10 Update(고정 안 됨 → npm latest 정확한 버전) → Rollback(이전 고정 안 된 항목) → Health
    progress("step 8 " + results.steps[8].status);
    const memBefore = JSON.parse((await read(p(".mcp.json"))) ?? "{}").mcpServers?.memory;
    const upd = await ev(app, "window.__openhubLifecycle('memory-mcp')", 1200000);
    const memAfter = JSON.parse((await read(p(".mcp.json"))) ?? "{}").mcpServers?.memory;
    const pinned = (memAfter?.args ?? []).find((a) => /^@modelcontextprotocol\/server-memory@\d+\.\d+\.\d+$/u.test(a)) ?? null;
    step(9, upd.status === "updated" && pinned !== null && JSON.stringify(JSON.parse((await read(p(".mcp.json"))) ?? "{}").mcpServers?.notes) === JSON.stringify(NOTES) ? "PASS" : "FAIL", { status: upd.status, health: upd.health, before: memBefore?.args, after: memAfter?.args, exactVersion: pinned, note: "packaged app: unpinned → npm latest exact; exact V1→V2→V1 is NOT-RUN (no version choice in the app)" });
    const rb = await ev(app, "window.__openhubLifecycleRun('memory-mcp', 'rollback')", 1200000);
    const memRolled = JSON.parse((await read(p(".mcp.json"))) ?? "{}").mcpServers?.memory;
    const rbHealth = await ev(app, "window.__openhubLifecycleRun('memory-mcp', 'health')", 600000);
    step(10, rb.status === "rolled-back" && JSON.stringify(memRolled) === JSON.stringify(memBefore) && rbHealth.outcome === "succeeded" ? "PASS" : "FAIL", { status: rb.status, outcome: rb.outcome, lines: rb.lines, restoredToPrevious: JSON.stringify(memRolled) === JSON.stringify(memBefore), healthAfter: rbHealth.outcome });
    // Kubernetes는 검토된 0.0.67만: update는 바꿀 것이 없다.
    const k8sUpd = await ev(app, "window.__openhubLifecycle('kubernetes-mcp-server')", 600000);
    check("kubernetes-only-0.0.67", ["up-to-date", "not-updatable", "not-executable"].includes(k8sUpd.status) && codexToml.includes("kubernetes-mcp-server@0.0.67"), { update: k8sUpd.status });

    // ---- 11 Drift·Repair(프로젝트 tool config 삭제 → status drift → 승인 repair → 복구)
    progress("steps 9/10 " + results.steps[9].status + "/" + results.steps[10].status);
    const projectToolConfig = walk(path.join(home, ".openhub", "tool-config", "project")).find((f) => f.endsWith("config.toml"));
    let repair = null;
    if (projectToolConfig) {
      const original = readFileSync(projectToolConfig, "utf8");
      await unlink(projectToolConfig);
      repair = await ev(app, "window.__openhubRepair('kubernetes-mcp-server')", 1200000);
      repair.restored = (await read(projectToolConfig)) === original;
    }
    // 사용자 범위를 숨긴 동안 사용자 항목은 not-inspected(읽지 않음)가 정상이다.
    step(11, repair !== null && repair.status === "repaired" && repair.outcome === "succeeded" && repair.restored && repair.after.includes("state-consistent") && repair.after.every((s) => s === "state-consistent" || s === "not-inspected") ? "PASS" : "FAIL", repair);
    results.notRun.push("11: Health failure compensation in the packaged app (needs a failing real MCP server; covered only by automated tests)");

    // ---- 12 English / Korean, 승인 대화상자 언어
    progress("step 11 " + results.steps[11].status);
    await ev(app, "window.__openhubSetLanguage('ko')");
    await sleep(1500);
    await app.reloadReady();
    const ko = await ev(app, "window.__openhubI18n()");
    await ev(app, "window.__openhubScanProject()");
    await app.dialogs();
    const koHealth = await ev(app, "window.__openhubLifecycleRun('memory-mcp', 'health')", 600000);
    const koDialogs = await app.dialogs();
    const koDialogKorean = koDialogs.some((d) => /[\uac00-\ud7a3]/u.test(String(d.title) + String(d.message)));
    step(12, ko.locale === "ko" && ko.missingKeys.length === 0 && /[\uac00-\ud7a3]/u.test(ko.texts["project-select"]) && koDialogKorean && koHealth.outcome === "succeeded" ? "PASS" : "FAIL", { locale: ko.locale, projectSelect: ko.texts["project-select"], dialogKorean: koDialogKorean, health: koHealth.outcome });
    const stateFile = path.join(home, ".openhub", "state", "lifecycle.json");
    const stateBefore = await read(stateFile);
    const clientBefore = [await read(p(".mcp.json")), await read(p(".codex/config.toml")), await read(path.join(home, ".cursor", "mcp.json")), await read(path.join(home, ".codex", "config.toml"))];
    await app.quit();
    app = undefined;

    // ---- 13 재실행 후 유지(언어 ko, INSTALLED, Version State·설정 byte 그대로)
    progress("step 12 " + results.steps[12].status + "; launch 2");
    app = await launch(ctx);
    const lang2 = await ev(app, "window.__openhubI18n()");
    await ev(app, "window.__openhubScanProject()");
    const status2 = await ev(app, "window.openhub.lifecycleStatus({ includeUser: true })");
    const items = (status2.items ?? []).map((i) => i.id + "=" + i.state);
    const stateAfter = await read(stateFile);
    const clientAfter = [await read(p(".mcp.json")), await read(p(".codex/config.toml")), await read(path.join(home, ".cursor", "mcp.json")), await read(path.join(home, ".codex", "config.toml"))];
    step(13, lang2.locale === "ko" && stateAfter === stateBefore && JSON.stringify(clientAfter) === JSON.stringify(clientBefore) && items.length >= 4 && items.every((x) => x.endsWith("=state-consistent")) ? "PASS" : "FAIL", { locale: lang2.locale, items, stateUnchanged: stateAfter === stateBefore, clientFilesUnchanged: JSON.stringify(clientAfter) === JSON.stringify(clientBefore) });
    await ev(app, "window.__openhubSetLanguage('en')");
    await sleep(1500);
    await app.quit();
    app = undefined;

    // ---- 4(빈 프로젝트 진단)
    progress("step 13 " + results.steps[13].status + "; launch 3 (empty project)");
    app = await launch(ctx, { OPENHUB_SMOKE_PROJECT: empty });
    await ev(app, "window.__openhubScanProject()");
    const emptyCount = await ev(app, "window.__openhubRecommend()");
    const emptyDiag = await ev(app, "window.__openhubForYouDiagnosis()");
    await app.quit();
    app = undefined;
    step(4, scanned > 0 && recCount > 0 && recIds.includes("memory-mcp") && recIds.includes("kubernetes-mcp-server") && emptyCount === 0 && emptyDiag.emptyReason === "no-stack-detected" ? "PASS" : "FAIL", { ...step4, empty: { recommended: emptyCount, emptyReason: emptyDiag.emptyReason, lines: emptyDiag.lines } });

    // ---- 3(OS 언어가 ko일 때 첫 실행): Linux만 환경 변수로 바꿀 수 있다
    if (osName === "linux") {
      const fresh = { ...ctx, userDataDir: path.join(work, "user-data-ko"), env: { ...ctx.env, XDG_CONFIG_HOME: path.join(work, "xdg-ko"), LANG: "ko_KR.UTF-8", LANGUAGE: "ko_KR" } };
      const appKo = await launch(fresh);
      const k = await appKo.page.evaluate("window.__openhubI18n()");
      await appKo.quit();
      check("first-start-follows-os-korean", k.locale === "ko", { locale: k.locale });
    } else results.notRun.push("3: first start with a Korean OS language on Windows (the runner's OS language cannot be switched)");
  } catch (error) {
    results.errors.push(String(error instanceof Error ? error.stack ?? error.message : error));
  } finally {
    if (app) await app.quit();
    for (const c of ctx.children) if (c.exitCode === null && c.signalCode === null) c.kill();
    api.close();
    results.finishedAt = new Date().toISOString();
    results.appLogTail = ctx.logs.map((l) => l.replace(new RegExp(TOKEN, "gu"), "<token>"));
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) if (results.steps[n] === undefined) results.steps[n] = { status: "NOT-RUN", evidence: "not reached" };
    await mkdir(path.dirname(out), { recursive: true });
    const text = JSON.stringify(results, null, 2);
    if (text.includes(TOKEN) || text.includes(SECRET_PLAIN)) throw new Error("fake credential leaked into results");
    await writeFile(out, text + "\n");
    console.log(Object.entries(results.steps).map(([n, s]) => n + ":" + s.status).join(" "));
    for (const [n, c] of Object.entries(results.checks)) console.log("check " + n + ": " + c.status);
    for (const e of results.errors) console.error(e);
    // 남은 핸들(WebSocket·자식 프로세스)이 있어도 끝낸다.
    process.exit(0);
  }
}

// ---------------------------------------------------------------- 제거 전후 비교
async function snapshot() {
  const work = path.resolve(opt("work"));
  const home = path.join(work, "home");
  const files = [path.join(work, "project", ".mcp.json"), path.join(work, "project", ".codex", "config.toml"), path.join(home, ".cursor", "mcp.json"), path.join(home, ".codex", "config.toml"), ...walk(path.join(home, ".openhub"))];
  const out = {};
  for (const f of files) if (existsSync(f) && statSync(f).isFile()) out[path.relative(work, f).replace(/\\/gu, "/")] = sha(readFileSync(f));
  await writeFile(path.resolve(opt("out")), JSON.stringify(out, null, 2) + "\n");
  console.log("snapshot: " + Object.keys(out).length + " files");
}
function compare() {
  const a = JSON.parse(readFileSync(argv[1], "utf8"));
  const b = JSON.parse(readFileSync(argv[2], "utf8"));
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  console.log(changed.length === 0 ? "unchanged: " + Object.keys(a).length + " files" : "changed: " + changed.join(", "));
  process.exit(changed.length === 0 && Object.keys(a).length > 0 ? 0 : 1);
}

if (mode === "run") await run();
else if (mode === "snapshot") await snapshot();
else if (mode === "compare") compare();
else {
  console.error("usage: packaged-rc.mjs run|snapshot|compare …");
  process.exit(2);
}

