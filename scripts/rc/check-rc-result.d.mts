export declare const REQUIRED_STEPS: number[];
export declare const ALLOWED_NOT_RUN: Readonly<Record<string, { step: number; os: readonly string[]; reason: string }>>;
export interface RcVerdict {
  ok: boolean;
  failures: string[];
  notRunRecorded: { id: string; step: number; reason: string }[];
}
export declare function checkRcResult(
  result: unknown,
  options?: { os?: string; requiredSteps?: readonly number[]; allowedNotRun?: typeof ALLOWED_NOT_RUN },
): RcVerdict;
export declare function formatVerdict(verdict: RcVerdict): string;
