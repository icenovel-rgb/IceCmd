/**
 * Copy and paste for a terminal pane.
 *
 * Kept in one place because two callers need it — Ctrl+Shift+C/V and the pane's
 * own context menu — and a second copy would drift from this one.
 */
import { writeSession } from "./ipc";
import { getEntry } from "./termRegistry";

/** What is selected in the pane, or "" when nothing is. */
export const selectionOf = (paneId: string): string =>
  getEntry(paneId)?.term.getSelection() ?? "";

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const copySelection = (paneId: string): Promise<boolean> => copyText(selectionOf(paneId));

/** Pasted text goes to the PTY, not to xterm: the shell decides what it means. */
export async function pasteInto(paneId: string): Promise<boolean> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return false;
    await writeSession(paneId, text);
    return true;
  } catch {
    return false;
  }
}
