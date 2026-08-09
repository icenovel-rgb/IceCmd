/**
 * xterm.js instances live here, outside React, so they survive re-renders and
 * project switching with their scrollback intact.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { ackOutput, resizeSession } from "./ipc";

/** Ack early enough that the reader never hits its high-water mark. */
const ACK_THRESHOLD = 128 * 1024;
/** Also ack after a lull, or trailing bytes below the threshold are never released. */
const ACK_IDLE_MS = 40;

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
  /** Latest PTY output time, used for the busy indicator. */
  lastOutputAt: number;
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
 */
const FONT_STACK = '"D2Coding", ui-monospace, Consolas, "Malgun Gothic", monospace';

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
    windowsPty: { backend: "conpty" },
    // Mirrors --terminal-bg / --text / --accent-hi from styles.css.
    theme: {
      background: "#1e1e1e",
      foreground: "#e8e8e8",
      cursor: "#92d6dd",
      cursorAccent: "#1e1e1e",
      selectionBackground: "rgba(42, 191, 193, 0.30)",
    },
  });

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
    lastOutputAt: 0,
    attention: false,
    exited: false,
  };
  entries.set(paneId, entry);
  return entry;
}

export const getEntry = (paneId: string) => entries.get(paneId);

export const allEntries = () => Array.from(entries.values());

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
    });
    entry.term.loadAddon(addon);
    entry.webgl = addon;
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

/** Writes PTY bytes and acks them once xterm has parsed them. */
export function writeOutput(entry: TermEntry, chunk: Uint8Array | string): void {
  if (entry.disposed) return;
  const length = typeof chunk === "string" ? chunk.length : chunk.byteLength;
  entry.lastOutputAt = performance.now();
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
  detachWebgl(entry);
  entry.term.dispose();
  entries.delete(paneId);
}
