import type { Finding } from "../detector";
import type { AiClientId, AiToolKind, Evidence, ProfileCategory } from "../profile";

/** Detector 안에서 같은 (카테고리, id[, kind]) 탐지를 모으는 도우미. 모든 결과는 project scope다. */
export class FindingSet {
  readonly #items = new Map<string, Finding>();

  add(category: ProfileCategory, id: string, name: string, evidence: Evidence, extra: { kind?: AiToolKind; client?: AiClientId } = {}): void {
    const key = `${category}\u0000${id}\u0000${extra.kind ?? ""}`;
    const found = this.#items.get(key);
    if (found === undefined) {
      this.#items.set(key, {
        category,
        id,
        name,
        scope: "project",
        evidence: [evidence],
        ...(extra.kind === undefined ? {} : { kind: extra.kind }),
        ...(extra.client === undefined ? {} : { clients: [extra.client] }),
      });
      return;
    }
    found.evidence.push(evidence);
    if (extra.client !== undefined && !found.clients?.includes(extra.client)) found.clients = [...(found.clients ?? []), extra.client];
  }

  has(category: ProfileCategory, id: string): boolean {
    return [...this.#items.values()].some((f) => f.category === category && f.id === id);
  }

  toArray(): Finding[] {
    return [...this.#items.values()];
  }
}
