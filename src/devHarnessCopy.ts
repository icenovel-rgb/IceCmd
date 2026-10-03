/**
 * Harness checks for copy-on-select. Dev-only: loaded with the harness.
 *
 * The clipboard itself refuses to work for a window without focus, which the
 * harness window usually is, so `writeText` is borrowed for the duration and
 * what the app *tried* to copy is asserted instead. Drags are dispatched as real
 * mouse events on xterm's own screen element, so the road from the mouse to the
 * copy is checked, not just the function at the end of it.
 */
import { logLine, writeSession } from "./terminal/ipc";
import type { TermEntry } from "./terminal/termRegistry";
import { isMac } from "./platform";

type Check = (name: string, ok: boolean, detail?: string) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (value: string | null) => JSON.stringify(value);

/** Where a buffer cell's left edge sits on screen, at mid-height of its row. */
function cellEdge(entry: TermEntry, column: number, bufferRow: number) {
  const screen = entry.term.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  const cellWidth = rect.width / entry.term.cols;
  const cellHeight = rect.height / entry.term.rows;
  const viewRow = bufferRow - entry.term.buffer.active.viewportY;
  return {
    target: screen,
    x: rect.left + column * cellWidth,
    y: rect.top + (viewRow + 0.5) * cellHeight,
    cellWidth,
  };
}

const mouse = (type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1,
    clientX: x,
    clientY: y,
    ...extra,
  });

interface Word {
  text: string;
  row: number;
  column: number;
}

/** Prints a fresh word and finds it as output — not on the line that typed it. */
async function printWord(entry: TermEntry, text: string): Promise<Word | null> {
  await writeSession(entry.paneId, `echo ${text}\r`);
  await sleep(700);
  entry.term.scrollToBottom();
  const buffer = entry.term.buffer.active;
  for (let row = buffer.length - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(row)?.translateToString(true) ?? "";
    if (line.includes(text) && !line.includes("echo")) {
      return { text, row, column: line.indexOf(text) };
    }
  }
  return null;
}

/** Drags across the word; edges pulled a fifth of a cell inward round onto it. */
function drag(entry: TermEntry, word: Word, extra: MouseEventInit = {}): boolean {
  const start = cellEdge(entry, word.column, word.row);
  const end = cellEdge(entry, word.column + word.text.length, word.row);
  if (!start || !end) return false;
  const inset = start.cellWidth * 0.2;
  start.target.dispatchEvent(mouse("mousedown", start.x + inset, start.y, { detail: 1, ...extra }));
  document.dispatchEvent(mouse("mousemove", (start.x + end.x) / 2, end.y, extra));
  document.dispatchEvent(mouse("mousemove", end.x - inset, end.y, extra));
  document.dispatchEvent(mouse("mouseup", end.x - inset, end.y, extra));
  return true;
}

/** A press and release on the word's first cell, without moving. */
function click(entry: TermEntry, word: Word): void {
  const at = cellEdge(entry, word.column, word.row);
  if (!at) return;
  const x = at.x + at.cellWidth * 0.2;
  at.target.dispatchEvent(mouse("mousedown", x, at.y, { detail: 1 }));
  document.dispatchEvent(mouse("mouseup", x, at.y));
}

/**
 * Swaps the Clipboard API for an in-memory one; call the result to put it back.
 *
 * Without focus the real API does not fail. In WebView2 it *waits*, and the
 * waiting calls all go through the moment the window is next focused. On
 * 2026-10-04 that put a pane's whole buffer on the user's clipboard and then
 * pasted it into cmd, which ran it line by line — each `D:\dev\IceCmd>cd` left
 * an empty file named `cd` in the repo. A run that could not get focus must
 * therefore never touch the real clipboard at all.
 */
export function installFakeClipboard(): () => void {
  const clipboard = navigator.clipboard;
  const realRead = clipboard.readText;
  const realWrite = clipboard.writeText;
  let held = "";
  clipboard.readText = async () => held;
  clipboard.writeText = async (text: string) => {
    held = text;
  };
  return () => {
    clipboard.readText = realRead;
    clipboard.writeText = realWrite;
  };
}

/** Runs `body` with `navigator.clipboard.writeText` recording instead of writing. */
async function withClipboardSpy(body: (copied: () => string | null, reset: () => void) => Promise<void>) {
  const clipboard = navigator.clipboard;
  const original = clipboard.writeText;
  let copied: string | null = null;
  clipboard.writeText = async (text: string) => {
    copied = text;
  };
  try {
    await body(
      () => copied,
      () => {
        copied = null;
      },
    );
  } finally {
    clipboard.writeText = original;
  }
}

/** On a plain shell: a drag copies, a repeated drag copies again, a click does not. */
export async function checkCopyOnSelect(entry: TermEntry, check: Check, mark: string): Promise<void> {
  const word = await printWord(entry, `${mark}-sel`);
  check("the word to select is on screen", word !== null);
  if (!word) return;

  await withClipboardSpy(async (copied, reset) => {
    check("the pane's screen can be measured", drag(entry, word));
    await sleep(150);
    // Asserted separately, so a failed copy can never be a drag that missed.
    check(
      "the drag selects exactly the word",
      entry.term.getSelection() === word.text,
      `selection=${shown(entry.term.getSelection())}`,
    );
    check("dragging over text copies it", copied() === word.text, `copied=${shown(copied())}`);

    /*
     * The same cells again, after the selection was cleared the way typing
     * clears it. xterm does not report a selection equal to the last one it
     * reported, so anything keyed on "the selection changed" copies nothing here.
     */
    reset();
    entry.term.clearSelection();
    drag(entry, word);
    await sleep(150);
    check("dragging the same text again copies it again", copied() === word.text, `copied=${shown(copied())}`);

    // A plain click clears the selection; there is then nothing to copy.
    reset();
    click(entry, word);
    await sleep(150);
    check("a click without a drag copies nothing", copied() === null, `copied=${shown(copied())}`);
  });
  entry.term.clearSelection();
}

/**
 * Under a program that asked for mouse reporting, the way claude does.
 *
 * Run on a pane of its own: the plain click below is reported to cmd.exe, which
 * echoes it, and the app's recovery then switches reporting off and says so on
 * that pane. On the main pane that note would be on screen before the recovery
 * check looks for it, and that check would pass for the wrong reason.
 */
export async function checkCopyUnderMouseTracking(
  entry: TermEntry,
  check: Check,
  mark: string,
): Promise<void> {
  const word = await printWord(entry, `${mark}-trk`);
  check("the tracked pane shows a word to select", word !== null);
  if (!word) return;

  await new Promise<void>((resolve) => entry.term.write("\x1b[?1000h", resolve));
  check(
    "a program can switch mouse reporting on",
    entry.term.modes.mouseTrackingMode !== "none",
    entry.term.modes.mouseTrackingMode,
  );

  await withClipboardSpy(async (copied, reset) => {
    if (isMac) {
      // On macOS only Option forces a selection, and only with an option this app leaves off.
      await logLine("harness SKIP a forced drag under mouse reporting copies — no force modifier on macOS");
    } else {
      drag(entry, word, { shiftKey: true });
      await sleep(150);
      check(
        "a Shift-drag under mouse reporting is xterm's, and is copied",
        copied() === word.text,
        `copied=${shown(copied())}`,
      );
    }

    // An xterm selection left on screen, then a press that belongs to the program.
    reset();
    entry.term.select(word.column, word.row, word.text.length);
    click(entry, word);
    await sleep(150);
    check(
      "a press the program takes never copies an older selection",
      copied() === null && entry.term.hasSelection(),
      `copied=${shown(copied())} selection=${entry.term.hasSelection()}`,
    );
  });

  entry.term.clearSelection();
  entry.term.write("\x1b[?1000l");
  // The reported click was typed at a live shell; clear the line it built.
  await writeSession(entry.paneId, "\x1b");
  await sleep(300);
}
