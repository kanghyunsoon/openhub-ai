// @ts-check
/**
 * Packaged RC harness: how a test answers a native dialog (v0.2.1).
 * answerDialog is injected into the Electron main process as source text (Function.prototype.toString),
 * so it must be self-contained: no imports, no outer variables.
 *
 * Rules
 * - A dialog is approved only with an explicit queued test answer { action: "approve" }.
 * - No queued answer: the dialog is rejected with its cancel button and recorded as unexpected.
 * - The cancel button is options.cancelId, otherwise the button labelled Cancel / No / 취소 / 아니요
 *   (Electron's own default). If there is no such button there is no safe rejection, so the harness throws:
 *   the app call fails and nothing is approved.
 * - An approve answer must point at a button that is not the cancel button (default index 1).
 */

/**
 * @param {{ title?: unknown; buttons?: unknown; cancelId?: unknown }} options Electron MessageBoxOptions
 * @param {Array<{ action: "approve" | "reject"; button?: number; mutate?: { file: string; text: string } }>} queue explicit test answers (consumed)
 * @param {string[]} unexpected titles of dialogs that had no explicit answer (appended)
 * @returns {{ action: "approve" | "reject"; response: number; unexpected: boolean; mutate?: { file: string; text: string } }}
 */
export function answerDialog(options, queue, unexpected) {
  const title = String(options.title);
  const buttons = Array.isArray(options.buttons) ? options.buttons.map((b) => String(b)) : [];
  const cancelIndex =
    typeof options.cancelId === "number" ? options.cancelId : buttons.findIndex((b) => /^(cancel|no|취소|아니요?)$/iu.test(b.replace(/[&()]/gu, "").trim()));
  const next = queue.length > 0 ? queue.shift() : undefined;
  if (next === undefined) {
    unexpected.push(title);
    if (cancelIndex < 0) throw new Error("RC harness: unexpected dialog has no cancel button; not answering it: " + title);
    return { action: "reject", response: cancelIndex, unexpected: true };
  }
  if (next.action === "approve") {
    const approveIndex = typeof next.button === "number" ? next.button : 1;
    if (approveIndex === cancelIndex || approveIndex < 0 || approveIndex >= buttons.length) {
      throw new Error("RC harness: approve answer does not point at a non-cancel button (" + approveIndex + "): " + title);
    }
    return { action: "approve", response: approveIndex, unexpected: false, ...(next.mutate === undefined ? {} : { mutate: next.mutate }) };
  }
  if (cancelIndex < 0) throw new Error("RC harness: reject answer but the dialog has no cancel button: " + title);
  return { action: "reject", response: cancelIndex, unexpected: false, ...(next.mutate === undefined ? {} : { mutate: next.mutate }) };
}

/**
 * Turns the per-launch dialog audit into RC errors (check-rc-result rule D fails on any error).
 * @param {Array<{ unexpected: string[]; leftover: number; error?: string }>} audits one entry per app launch
 * @returns {string[]}
 */
export function dialogAuditErrors(audits) {
  /** @type {string[]} */
  const errors = [];
  audits.forEach((a, i) => {
    const launch = "dialog audit (launch " + (i + 1) + "): ";
    if (a.unexpected.length > 0) errors.push(launch + a.unexpected.length + " dialog(s) without an explicit test answer were rejected or refused: " + a.unexpected.join(" | "));
    if (a.leftover > 0) errors.push(launch + a.leftover + " queued test answer(s) were not used");
    if (a.error !== undefined) errors.push(launch + "could not read: " + a.error);
  });
  return errors;
}

/**
 * Replaces dialog.showMessageBox in the Electron main process (the harness injects this source and answerDialog's).
 * State lives on `state` (globalThis in Electron): __rcAnswers (queue), __rcUnexpected, __rcDialogs (log for the harness).
 * Uses the free name answerDialog, which is the injected copy in Electron and the module function in tests.
 * @param {{ showMessageBox?: Function }} dialog
 * @param {{ writeFileSync(file: string, text: string): void }} fs
 * @param {Record<string, any>} state
 */
export function installDialogAnswers(dialog, fs, state) {
  state.__rcDialogs = state.__rcDialogs || [];
  state.__rcAnswers = state.__rcAnswers || [];
  state.__rcUnexpected = state.__rcUnexpected || [];
  /** @param {any} a @param {any} [b] */
  dialog.showMessageBox = async (a, b) => {
    const o = b === undefined ? a : b;
    const r = answerDialog(o, state.__rcAnswers, state.__rcUnexpected);
    if (r.mutate) fs.writeFileSync(r.mutate.file, r.mutate.text);
    state.__rcDialogs.push({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons, action: r.action, mutated: Boolean(r.mutate), unexpected: r.unexpected });
    return { response: r.response, checkboxChecked: false };
  };
}

