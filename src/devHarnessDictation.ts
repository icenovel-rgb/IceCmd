/**
 * Harness checks for typed, spoken and pasted text on its way to the PTY, and
 * for the pane's mic button. Dev-only: loaded with the harness, never part of a
 * normal build.
 *
 * The shell does the arithmetic, so a check passes only if the command really
 * ran — the echo of the command line alone can never contain the answer.
 */
import { isMac, isWindows } from "./platform";
import type { TermEntry } from "./terminal/termRegistry";

type Check = (name: string, ok: boolean, detail?: string) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACE = "　";
const PLUS = "＋";
const FULL_A = "Ａ";
const FULL_B = "Ｂ";
const SHELL_SETTLE_MS = 1500;

/** A sum the shell has to compute: the answer is not in the command line. */
function sumCommand(n: number): string {
  return isWindows ? `set${SPACE}/a ${n}${PLUS}1` : `echo${SPACE}$((${n}${PLUS}1))`;
}

async function checkTypedIsHalfWidth(entry: TermEntry, paneId: string, screen: (id: string) => string, check: Check): Promise<void> {
  const n = 400000 + Math.floor(Math.random() * 500000);
  // term.input is xterm's own "as if typed" entry: it fires onData like a key.
  entry.term.input(`${sumCommand(n)}\r`, true);
  await sleep(SHELL_SETTLE_MS);
  check("full-width space and ＋ typed into the terminal reach the shell half-width", screen(paneId).includes(String(n + 1)), `want ${n + 1}`);
}

async function checkPasteIsUntouched(entry: TermEntry, paneId: string, screen: (id: string) => string, check: Check, mark: string): Promise<void> {
  const area = entry.term.textarea;
  if (!area) {
    check("the terminal has a textarea to paste into", false);
    return;
  }
  const token = `${mark}p`;
  const data = new DataTransfer();
  data.setData("text/plain", `echo ${FULL_A}${FULL_B}${token}`);
  area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  await sleep(100);
  entry.term.input("\r", true);
  await sleep(SHELL_SETTLE_MS);
  const text = screen(paneId);
  const converted = text.includes(`AB${token}`);
  const arrived = text.includes(`${FULL_A}${FULL_B}${token}`);
  check(
    "a pasted full-width name arrives as it was",
    arrived && !converted,
    converted ? "it was converted" : arrived ? "" : "nothing arrived",
  );
}

async function checkMicButton(entry: TermEntry, paneId: string, check: Check): Promise<void> {
  const mic = document.querySelector<HTMLButtonElement>(`[data-pane="${paneId}"] .pane-mic`);
  check("the pane toolbar has a mic button", Boolean(mic));
  if (!mic) return;
  entry.term.focus();
  const press = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  mic.dispatchEvent(press);
  check("pressing the mic does not take focus from the terminal", press.defaultPrevented);

  // With focus, a click is a real Win+H / dictation panel on the user's
  // screen. Only the unfocused path is driven here; the button still goes all
  // the way to Rust, which is what refuses.
  if ((isWindows || isMac) && document.hasFocus()) {
    check("mic click skipped: the window has focus and would open voice typing", true);
    return;
  }
  mic.click();
  await sleep(400);
  const notice = document.querySelector(`[data-pane="${paneId}"] .pane-notice`)?.textContent ?? "";
  const expected = isWindows || isMac ? "IceCmd 창을 선택한" : "시스템 받아쓰기";
  check("the mic reports back on the pane", notice.includes(expected), JSON.stringify(notice));
  check("and the terminal holds focus for the voice panel", document.activeElement === entry.term.textarea);
  document.querySelector<HTMLElement>(`[data-pane="${paneId}"] .pane-notice`)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await sleep(100);
  check("the notice closes when pressed", !document.querySelector(`[data-pane="${paneId}"] .pane-notice`));
}

export async function checkTypedAndSpoken(
  entry: TermEntry,
  paneId: string,
  screen: (id: string) => string,
  check: Check,
  mark: string,
): Promise<void> {
  await checkTypedIsHalfWidth(entry, paneId, screen, check);
  await checkPasteIsUntouched(entry, paneId, screen, check, mark);
  await checkMicButton(entry, paneId, check);
}
