/**
 * xterm.js instances live here, outside React, so they survive re-renders and
 * project switching with their scrollback intact.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { guardImeInput } from "./ime";
import { ackOutput, resizeSession } from "./ipc";
import { isWindows } from "../platform";

/** Ack early enough that the reader never hits its high-water mark. */
const ACK_THRESHOLD = 128 * 1024;
/** Also ack after a lull, or trailing bytes below the threshold are never released. */
const ACK_IDLE_MS = 40;
/**
 * How long the cursor stays solid after the last byte of output.
 *
 * xterm.js restarts the blink animation every time the cursor moves, so a TUI
 * that repaints continuously — codex and claude both do — makes the cursor
 * strobe instead of blink. Holding it solid while output is flowing costs
 * nothing and is also the honest signal: a still cursor means "working".
 */
const BLINK_RESUME_MS = 700;

export interface TermEntry {
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Bytes parsed but not yet reported to the backend. */
  pendingAck: number;
  ackTimer: number | null;
  /** Size the PTY was last told about, so unchanged layouts cause no repaint. */
  sentCols: number;
  sentRows: number;
  /** Set once the pane is torn down so late callbacks do nothing. */
  disposed: boolean;
  /**
   * Latest PTY output time, used for the busy indicator.
   *
   * `-Infinity` until the first byte arrives, so "has produced nothing yet" is
   * never mistaken for "produced something just now" — with 0 here, every pane
   * reported busy for the first couple of seconds after launch, because
   * `performance.now()` is small then and the gap looked recent.
   */
  lastOutputAt: number;
  /** Set while the cursor is held solid because output is still arriving. */
  blinkHeld: boolean;
  blinkTimer: number | null;
  /** True after a BEL until the user looks at the project. */
  attention: boolean;
  exited: boolean;
}

const entries = new Map<string, TermEntry>();

/**
 * D2Coding first: its Hangul glyphs are exactly two Latin cells wide, which is
 * what xterm.js assumes. Mixing a Latin font with a fallback Hangul font makes
 * columns drift. Falls back to the stack the other ICE apps use.
 * Keep in sync with `--font-mono` in styles.css.
 *
 * 맥에는 Consolas·Malgun Gothic 이 없다. D2Coding 을 깔지 않은 맥에서는
 * ui-monospace(SF Mono) → Menlo 가 잡히고 한글은 Apple SD Gothic Neo 로 떨어지는데,
 * 그 조합은 한글 폭이 라틴의 정확히 2배가 아니다 — **맥에서 표가 어긋나 보이면
 * D2Coding 을 설치하는 것이 답이다.**
 */
const FONT_STACK =
  '"D2Coding", ui-monospace, Consolas, Menlo, "Malgun Gothic", "Apple SD Gothic Neo", monospace';

export function createEntry(paneId: string, fontSize: number): TermEntry {
  const existing = entries.get(paneId);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: FONT_STACK,
    fontSize,
    lineHeight: 1.15,
    scrollback: 5000,
    cursorBlink: true,
    // Required by the unicode11 addon.
    allowProposedApi: true,
    // ConPTY는 줄을 접을 때 스스로 개행을 끼워 넣는다. xterm은 이 옵션을 보고
    // 그 개행을 되돌려 붙이는데, 유닉스 pty는 그런 짓을 하지 않으므로 맥에서
    // 켜 두면 멀쩡한 줄바꿈까지 이어 붙여 화면이 어긋난다.
    ...(isWindows ? { windowsPty: { backend: "conpty" as const } } : {}),
    // Mirrors --terminal-bg / --text / --accent-hi from styles.css.
    theme: {
      background: "#1e1e1e",
      foreground: "#e8e8e8",
      cursor: "#92d6dd",
      cursorAccent: "#1e1e1e",
      selectionBackground: "rgba(42, 191, 193, 0.30)",
    },
  });

  guardImeInput(term);

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  const entry: TermEntry = {
    paneId,
    term,
    fit,
    webgl: null,
    pendingAck: 0,
    ackTimer: null,
    sentCols: 0,
    sentRows: 0,
    disposed: false,
    lastOutputAt: Number.NEGATIVE_INFINITY,
    blinkHeld: false,
    blinkTimer: null,
    attention: false,
    exited: false,
  };
  entries.set(paneId, entry);
  return entry;
}

export const getEntry = (paneId: string) => entries.get(paneId);

export const allEntries = () => Array.from(entries.values());

/**
 * Redraws every row, whether or not xterm thinks anything changed.
 *
 * xterm only paints rows it believes are dirty, which is right almost always and
 * wrong in exactly the cases where the canvas is empty *and it does not know*:
 * a renderer that has just been swapped in has drawn nothing yet, and a window
 * that was minimised or covered comes back with its GPU surface thrown away.
 * The screen then shows only the rows that happened to be rewritten since —
 * usually just the prompt at the bottom — and scrolling appears to "fix" it,
 * because scrolling is what finally marks every row dirty. This is that, on
 * purpose, at the moments where it is needed.
 */
export function repaint(entry: TermEntry): void {
  if (entry.disposed) return;
  entry.term.refresh(0, entry.term.rows - 1);
}

/**
 * The GPU renderer is the cheapest option per frame, but browsers cap live WebGL
 * contexts, so only visible panes get one.
 */
export function attachWebgl(entry: TermEntry): void {
  if (entry.disposed || entry.webgl) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      entry.webgl = null;
      // Back on the DOM renderer, which has drawn nothing of what is on screen.
      repaint(entry);
    });
    entry.term.loadAddon(addon);
    entry.webgl = addon;
    // A brand-new canvas holds nothing; without this the pane stays blank until
    // something else dirties its rows.
    repaint(entry);
  } catch {
    // Falls back to the DOM renderer; nothing else to do.
    entry.webgl = null;
  }
}

export function detachWebgl(entry: TermEntry): void {
  if (!entry.webgl) return;
  entry.webgl.dispose();
  entry.webgl = null;
}

/**
 * Refits the terminal and tells the PTY only when the grid actually changed.
 * ConPTY repaints its whole screen on every resize, and a repaint can lose a line
 * of history, so a no-op resize is worth avoiding.
 */
export function syncSize(entry: TermEntry): void {
  if (entry.disposed) return;
  entry.fit.fit();
  const { cols, rows } = entry.term;
  if (cols === entry.sentCols && rows === entry.sentRows) return;
  entry.sentCols = cols;
  entry.sentRows = rows;
  void resizeSession(entry.paneId, cols, rows);
}

/**
 * Applies a font size to every terminal and refits. Changing the size changes how
 * many columns fit, so the PTY has to be told; syncSize handles that.
 */
export function applyFontSize(size: number): void {
  for (const entry of entries.values()) {
    if (entry.disposed || entry.term.options.fontSize === size) continue;
    entry.term.options.fontSize = size;
    syncSize(entry);
  }
}

/**
 * Holds the cursor solid until the output stops. The timer is only restarted
 * here; the option itself changes twice per burst, not once per chunk.
 */
function holdCursor(entry: TermEntry): void {
  if (!entry.blinkHeld) {
    entry.blinkHeld = true;
    entry.term.options.cursorBlink = false;
  }
  if (entry.blinkTimer !== null) window.clearTimeout(entry.blinkTimer);
  entry.blinkTimer = window.setTimeout(() => {
    entry.blinkTimer = null;
    if (entry.disposed) return;
    entry.blinkHeld = false;
    entry.term.options.cursorBlink = true;
  }, BLINK_RESUME_MS);
}

/** Writes PTY bytes and acks them once xterm has parsed them. */
export function writeOutput(entry: TermEntry, chunk: Uint8Array | string): void {
  if (entry.disposed) return;
  const length = typeof chunk === "string" ? chunk.length : chunk.byteLength;
  entry.lastOutputAt = performance.now();
  holdCursor(entry);
  entry.term.write(chunk, () => {
    if (entry.disposed) return;
    entry.pendingAck += length;
    if (entry.pendingAck >= ACK_THRESHOLD) {
      flushAck(entry);
    } else if (entry.ackTimer === null) {
      entry.ackTimer = window.setTimeout(() => {
        entry.ackTimer = null;
        flushAck(entry);
      }, ACK_IDLE_MS);
    }
  });
}

function flushAck(entry: TermEntry): void {
  if (entry.ackTimer !== null) {
    window.clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
  }
  const bytes = entry.pendingAck;
  if (bytes === 0) return;
  entry.pendingAck = 0;
  void ackOutput(entry.paneId, bytes);
}

export function disposeEntry(paneId: string): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  entry.disposed = true;
  if (entry.ackTimer !== null) window.clearTimeout(entry.ackTimer);
  if (entry.blinkTimer !== null) window.clearTimeout(entry.blinkTimer);
  detachWebgl(entry);
  entry.term.dispose();
  entries.delete(paneId);
}
