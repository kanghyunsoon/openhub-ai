// v0.2.1 P0-4 프로세스 간 커밋 경쟁용 worker. argv: <homeDir> <expectedDigest> <serverName> <goFile>
// goFile이 생길 때까지 기다렸다가(모든 worker가 거의 같은 순간 출발) commitLifecycleState 결과 code를 stdout에 쓴다.
import { existsSync } from "node:fs";
import { commitLifecycleState } from "../../../src/index";
import { stateOf, toolState } from "../helpers";

const [homeDir, expected, serverName, goFile] = process.argv.slice(2) as [string, string, string, string];
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 2));
const next = stateOf(toolState({ target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName, projectName: "demo", projectKey: "0123456789abcdef" } }));
const r = await commitLifecycleState(next, expected, { homeDir });
process.stdout.write(r.ok ? "ok" : r.code);
