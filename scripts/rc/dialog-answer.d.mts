export interface DialogTestAnswer {
  action: "approve" | "reject";
  button?: number;
  mutate?: { file: string; text: string };
}
export interface DialogAnswer {
  action: "approve" | "reject";
  response: number;
  unexpected: boolean;
  mutate?: { file: string; text: string };
}
export interface DialogAudit {
  unexpected: string[];
  leftover: number;
  error?: string;
}
export declare function answerDialog(options: { title?: unknown; buttons?: unknown; cancelId?: unknown }, queue: DialogTestAnswer[], unexpected: string[]): DialogAnswer;
export declare function dialogAuditErrors(audits: readonly DialogAudit[]): string[];
export declare function installDialogAnswers(dialog: { showMessageBox?: unknown }, fs: { writeFileSync(file: string, text: string): void }, state: Record<string, unknown>): void;

