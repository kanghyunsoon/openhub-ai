import path from "node:path";
import { isVerifiedPinokioPlan, type VerifiedPinokioPlan } from "../pinokio/plan";
import type { PinokioScriptArg, PinokioScriptName } from "../pinokio/compiler";
import { nodeExecSpawner, type ExecChild, type ExecSpawner } from "./executor";

/**
 * pterm 실행(TASK-052·053, D-027 A-1).
 * - `node <pterm/index.js> start|stop <생성 script 이름> --ref pinokio://127.0.0.1:42000/api/openhub-<toolId> [-- --key=value …]`만 만든다.
 * - shell:false, stdin ignore(pterm start는 stdin 키 입력을 pinokiod 셸로 넘기기 때문), env key 없음.
 * - cmd·cmd.exe·sh·.cmd·.bat·.ps1을 실행하지 않는다. `run --default`·download·open·registry·push·upload를 쓰지 않는다.
 * - VerifiedPinokioPlan(공통 kernel이 발급)과 그 Plan의 script·ref·인자만 받는다.
 * - pterm exit code는 성공 근거가 아니다(stop 패킷을 받으면 script 결과와 무관하게 0이다). 호출 측이 완료 표시·Health로 판정한다.
 */

export const PTERM_VERBS = ["start", "stop"] as const;
export type PtermVerb = (typeof PTERM_VERBS)[number];
const FORBIDDEN_EXECUTABLES = /^(?:cmd|cmd\.exe|sh|bash|zsh|pwsh|powershell)(?:\.exe)?$|\.(?:cmd|bat|ps1)$/iu;

/** 비실행 probe가 찾은 node·pterm index.js(절대 경로, 실행 시점에만 쓴다). process 모듈은 probe를 import하지 않는다(AC-029-07). */
export interface PtermLaunch {
  readonly node: string;
  readonly indexJs: string;
}

export interface PtermInvocation {
  executable: string;
  args: string[];
}

/** VerifiedPinokioPlan의 값만으로 argv를 만든다. 다른 verb·script·ref는 거부한다. */
export function ptermInvocation(verified: VerifiedPinokioPlan, entry: PtermLaunch, verb: PtermVerb, script: PinokioScriptName): PtermInvocation {
  if (!isVerifiedPinokioPlan(verified)) throw new Error("APPROVAL_REQUIRED");
  if (!(PTERM_VERBS as readonly string[]).includes(verb)) throw new Error("pterm은 start·stop만 실행합니다");
  if (!verified.plan.scripts.some((s) => s.name === script)) throw new Error("Plan에 없는 script입니다");
  const base = path.basename(entry.node);
  if (FORBIDDEN_EXECUTABLES.test(base) || !/^node(?:\.exe)?$/iu.test(base) || path.basename(entry.indexJs) !== "index.js") throw new Error("pterm은 node + index.js로만 실행합니다");
  const args: PinokioScriptArg[] = verb === "start" && script === "openhub-start.js" ? verified.plan.start.args : [];
  return {
    executable: entry.node,
    args: [entry.indexJs, verb, script, "--ref", verified.plan.ref, ...(args.length > 0 ? ["--", ...args.map((a) => "--" + a.key + "=" + a.value)] : [])],
  };
}

export interface PtermRun {
  child: ExecChild;
  /** 종료 코드(성공 근거로 쓰지 않는다) */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>;
}

/** shell:false·stdin ignore로 pterm을 시작한다. cwd는 호출 측이 준 OpenHub 소유 디렉터리다. */
export function spawnPterm(invocation: PtermInvocation, options: { cwd: string; spawner?: ExecSpawner }): PtermRun {
  const spawner = options.spawner ?? nodeExecSpawner;
  const child = spawner(invocation.executable, invocation.args, { shell: false, cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>((resolve) => {
    let done = false;
    child.on("close", (code, signal) => {
      if (!done) resolve({ code, signal, error: false });
      done = true;
    });
    child.on("error", () => {
      if (!done) resolve({ code: null, signal: null, error: true });
      done = true;
    });
  });
  // 출력은 보관하지 않는다(pinokiod 셸 출력에 경로·값이 섞일 수 있다). 파이프가 차지 않도록 읽고 버린다.
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return { child, exited };
}

