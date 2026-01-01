// Electron 메인·preload를 CJS로 번들한다. @openhub/core(TypeScript 소스)도 함께 번들된다.
// TASK-071: esbuild metafile(dist/metafile.json, bundle inventory 검사용)을 남기고, 개발 실행용 Registry 리소스를
// resources/registry에 staging한다(metadata snapshot은 있으면 포함). 패키징은 scripts/pack-desktop.ts가 snapshot 필수로 다시 staging한다.
import { writeFileSync } from "node:fs";
import { build } from "esbuild";
import { snapshotCandidates, stageRegistry } from "../../scripts/stage-registry.mjs";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
};

const main = await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
const preload = await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
writeFileSync("dist/metafile.json", JSON.stringify({ inputs: { ...main.metafile.inputs, ...preload.metafile.inputs } }, null, 2) + "\n");
stageRegistry("resources/registry", snapshotCandidates()[0] ?? null);
