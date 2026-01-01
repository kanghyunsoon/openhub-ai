import type { InstallStep, Manifest } from "../manifest/index";
import type { InstallContext, InstallTarget, InstallerAdapter } from "./adapter";

export type RouteResult =
  | { ok: true; adapter: InstallerAdapter; target: InstallTarget; source: "preferred" | "fallback"; reasons: string[] }
  | { ok: false; reasons: string[] };

/** Manifest의 설치 후보를 우선순위 순서로 펼친다: preferredAdapter → fallback[0] → fallback[1] … */
export function installCandidates(manifest: Manifest): { step: InstallStep; source: "preferred" | "fallback" }[] {
  const preferred: InstallStep = {
    adapter: manifest.install.preferredAdapter,
    ...(manifest.install.options === undefined ? {} : { options: manifest.install.options }),
  };
  return [{ step: preferred, source: "preferred" }, ...manifest.install.fallback.map((step) => ({ step, source: "fallback" as const }))];
}

/**
 * Installation Router 골격(기획서 §8, §12).
 * 실행하지 않고 "어떤 Adapter로 설치할지"와 그 이유만 결정한다.
 */
export class InstallationRouter {
  readonly #adapters: ReadonlyMap<string, InstallerAdapter>;

  constructor(adapters: readonly InstallerAdapter[]) {
    const map = new Map<string, InstallerAdapter>();
    for (const a of adapters) {
      if (map.has(a.id)) throw new Error(`Adapter '${a.id}'가 두 번 등록되었습니다`);
      map.set(a.id, a);
    }
    this.#adapters = map;
  }

  select(manifest: Manifest, ctx: InstallContext): RouteResult {
    const reasons: string[] = [];
    if (manifest.verification === "draft") {
      return { ok: false, reasons: [`${manifest.name}: 검증되지 않은 draft Manifest는 실행 대상으로 고르지 않습니다(CON-005)`] };
    }
    if (!manifest.platform[ctx.platform]) {
      return { ok: false, reasons: [`${manifest.name}: ${ctx.platform} 플랫폼을 지원하지 않습니다`] };
    }
    for (const { step, source } of installCandidates(manifest)) {
      const label = source === "preferred" ? `선호 Adapter ${step.adapter}` : `대체 Adapter ${step.adapter}`;
      const adapter = this.#adapters.get(step.adapter);
      if (adapter === undefined) {
        reasons.push(`${label}: OpenHub에 아직 구현되지 않았습니다`);
        continue;
      }
      if (!ctx.availableAdapters.has(step.adapter)) {
        reasons.push(`${label}: 이 PC에서 사용할 수 없습니다(런타임 미설치)`);
        continue;
      }
      const target: InstallTarget = { manifest, step };
      if (!adapter.canHandle(target, ctx)) {
        reasons.push(`${label}: 이 Manifest를 처리할 수 없다고 응답했습니다`);
        continue;
      }
      reasons.push(`${label}을(를) 선택했습니다`);
      return { ok: true, adapter, target, source, reasons };
    }
    reasons.push(`${manifest.name}: 사용할 수 있는 설치 방법이 없습니다`);
    return { ok: false, reasons };
  }
}
