import type { AgentTarget, Category } from "../manifest/index";
import type { RegistryEntry } from "./load";

/** 목록 조회 조건. 여러 조건을 주면 모두 만족하는 Tool만 돌려준다. */
export interface RegistryFilter {
  category?: Category;
  capability?: string;
  target?: AgentTarget;
}

/**
 * 메모리에 적재된 Registry 조회 API.
 * 설치 기술(installer)을 알지 못하며 Manifest의 식별·분류 정보로만 조회한다(CON-003).
 */
export class Registry {
  readonly #byName: ReadonlyMap<string, RegistryEntry>;

  constructor(entries: readonly RegistryEntry[]) {
    this.#byName = new Map(entries.map((e) => [e.manifest.name, e]));
  }

  get size(): number {
    return this.#byName.size;
  }

  get(name: string): RegistryEntry | undefined {
    return this.#byName.get(name);
  }

  list(filter: RegistryFilter = {}): RegistryEntry[] {
    const { category, capability, target } = filter;
    return [...this.#byName.values()]
      .filter((e) => category === undefined || e.manifest.category.includes(category))
      .filter((e) => capability === undefined || e.manifest.capabilities.includes(capability))
      .filter((e) => target === undefined || e.manifest.targets.includes(target))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /** 등록된 Capability와 각 Capability를 제공하는 Tool 수. Gap Detector(M3)의 입력이 된다. */
  capabilities(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of this.#byName.values()) {
      for (const c of e.manifest.capabilities) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)));
  }
}
