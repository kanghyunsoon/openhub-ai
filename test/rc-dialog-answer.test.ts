import { describe, expect, it } from "vitest";
import { checkRcResult, REQUIRED_CHECKS, REQUIRED_STEPS } from "../scripts/rc/check-rc-result.mjs";
import { answerDialog, dialogAuditErrors, installDialogAnswers } from "../scripts/rc/dialog-answer.mjs";

/**
 * v0.2.1 packaged RC harness: test answers to native approval dialogs (PR #68).
 * The harness injects answerDialog and installDialogAnswers into Electron as source text; these tests run the
 * module functions and the same source text in a separate scope with a fake dialog (no Electron, no real dialog).
 */
type Answer = { action: "approve" | "reject"; button?: number; mutate?: { file: string; text: string } };
const INSTALL = { title: "OpenHub install approval", buttons: ["Cancel", "Approve install"], defaultId: 0, cancelId: 0 };
const AI_NO_CANCEL_ID = { title: "AI Summary", buttons: ["Send", "Cancel"], defaultId: 1 };

/** The exact text the harness injects (packaged-rc.mjs PATCH_DIALOG), evaluated without the module scope. */
function injected() {
  const source = "const answerDialog = " + answerDialog.toString() + ";\nconst installDialogAnswers = " + installDialogAnswers.toString() + ";\ninstallDialogAnswers(dialog, fs, state);";
  const dialog: { showMessageBox?: (o: unknown) => Promise<{ response: number }> } = {};
  const writes: string[] = [];
  const state: Record<string, any> = {};
  new Function("dialog", "fs", "state", source)(dialog, { writeFileSync: (f: string) => writes.push(f) }, state);
  return { show: (o: unknown) => dialog.showMessageBox!(o), state, writes };
}
const pass = (os: "windows" | "linux") => ({
  os,
  steps: Object.fromEntries(REQUIRED_STEPS.map((n) => [String(n), { status: "PASS", evidence: {} }])),
  checks: Object.fromEntries(REQUIRED_CHECKS[os].map((id) => [id, { status: "PASS", evidence: {} }])) as Record<string, unknown>,
  notRun: os === "windows" ? [{ id: "korean-os-first-start", step: 3, detail: "runner" }] : [],
  errors: [] as string[],
});

describe("RC harness dialog answers (behaviour)", () => {
  it("no queued answer: the dialog is rejected with cancelId, never approved, and recorded as unexpected", () => {
    const unexpected: string[] = [];
    expect(answerDialog(INSTALL, [], unexpected)).toEqual({ action: "reject", response: 0, unexpected: true });
    expect(unexpected).toEqual(["OpenHub install approval"]);
  });

  it("no queued answer and no cancelId: the Cancel-labelled button is used, not index 0 (index 0 would be Send)", () => {
    const unexpected: string[] = [];
    const r = answerDialog(AI_NO_CANCEL_ID, [], unexpected);
    expect(r).toMatchObject({ action: "reject", response: 1, unexpected: true });
    expect(answerDialog({ title: "ko", buttons: ["승인", "취소"] }, [], unexpected).response).toBe(1);
    expect(answerDialog({ title: "no", buttons: ["Yes", "&No"] }, [], unexpected).response).toBe(1);
    expect(unexpected).toHaveLength(3);
  });

  it("no queued answer and no rejectable button: the harness refuses to answer (throws), so nothing is approved", () => {
    const unexpected: string[] = [];
    expect(() => answerDialog({ title: "Send summary", buttons: ["Send", "Send later"] }, [], unexpected)).toThrow(/no cancel button/u);
    expect(() => answerDialog({ title: "No buttons" }, [], unexpected)).toThrow(/no cancel button/u);
    expect(unexpected).toEqual(["Send summary", "No buttons"]);
  });

  it("explicit approve answers the non-cancel button and is consumed; explicit reject answers cancel", () => {
    const queue: Answer[] = [{ action: "approve" }, { action: "reject" }];
    const unexpected: string[] = [];
    expect(answerDialog(INSTALL, queue, unexpected)).toEqual({ action: "approve", response: 1, unexpected: false });
    expect(answerDialog(INSTALL, queue, unexpected)).toEqual({ action: "reject", response: 0, unexpected: false });
    expect(queue).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  it("an approve answer that would press the cancel button or a missing button is an error, not an approval", () => {
    expect(() => answerDialog(INSTALL, [{ action: "approve", button: 0 }], [])).toThrow(/non-cancel button/u);
    expect(() => answerDialog({ title: "one", buttons: ["Cancel"], cancelId: 0 }, [{ action: "approve" }], [])).toThrow(/non-cancel button/u);
  });

  it("the injected source works on its own: no answer -> rejected and logged as unexpected; explicit approve -> approved", async () => {
    const { show, state, writes } = injected();
    expect(await show(INSTALL)).toEqual({ response: 0, checkboxChecked: false });
    expect(await show(AI_NO_CANCEL_ID)).toEqual({ response: 1, checkboxChecked: false });
    await expect(show({ title: "Send summary", buttons: ["Send"] })).rejects.toThrow(/no cancel button/u);
    state.__rcAnswers.push({ action: "approve", mutate: { file: "/tmp/x", text: "y" } });
    expect(await show(INSTALL)).toEqual({ response: 1, checkboxChecked: false });
    expect(writes).toEqual(["/tmp/x"]);
    expect(state.__rcUnexpected).toEqual(["OpenHub install approval", "AI Summary", "Send summary"]);
    expect(state.__rcDialogs.map((d: { action: string; unexpected: boolean }) => d.action + ":" + d.unexpected)).toEqual(["reject:true", "reject:true", "approve:false"]);
  });

  it("audit: unexpected dialogs and unused test answers become RC errors and fail the verdict; a clean audit passes", () => {
    expect(dialogAuditErrors([{ unexpected: [], leftover: 0 }, { unexpected: [], leftover: 0 }])).toEqual([]);
    const errs = dialogAuditErrors([{ unexpected: ["OpenHub install approval"], leftover: 0 }, { unexpected: [], leftover: 2 }, { unexpected: [], leftover: 0, error: "closed" }]);
    expect(errs).toEqual([
      "dialog audit (launch 1): 1 dialog(s) without an explicit test answer were rejected or refused: OpenHub install approval",
      "dialog audit (launch 2): 2 queued test answer(s) were not used",
      "dialog audit (launch 3): could not read: closed",
    ]);
    for (const os of ["windows", "linux"] as const) {
      const unused = pass(os);
      unused.errors.push(...dialogAuditErrors([{ unexpected: [], leftover: 1 }]));
      expect(checkRcResult(unused, { os }).ok, os).toBe(false);
      const unexpected = pass(os);
      unexpected.errors.push(...dialogAuditErrors([{ unexpected: ["x"], leftover: 0 }]));
      expect(checkRcResult(unexpected, { os }).ok, os).toBe(false);
      // normal scenario: only the needed explicit approvals, all used
      const normal = pass(os);
      normal.errors.push(...dialogAuditErrors([{ unexpected: [], leftover: 0 }]));
      expect(checkRcResult(normal, { os }), os).toMatchObject({ ok: true });
    }
  });
});

