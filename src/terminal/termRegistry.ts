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
  /** The element `term.open()` was handed, so a size can be checked before fitting. */
  host: HTMLElement | null;
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
    host: null,
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
 * Whether the pane has a real box on screen to measure.
 *
 * A stage that is not the active one is `display: none`, and a computed style
 * inside one does not resolve percentages — `.terminal-host` is `100%`, so the
 * answer comes back as the string "100%", which FitAddon parses as 100 *pixels*
 * and turns into a grid about ten columns wide. `clientWidth`/`clientHeight` are
 * 0 for anything that is not laid out, and that is the one answer which cannot
 * be mistaken for a real measurement.
 */
export function isMeasurable(entry: TermEntry): boolean {
  const host = entry.host;
  return !!host && host.clientWidth > 0 && host.clientHeight > 0;
}

/**
 * Refits the terminal and tells the PTY only when the grid actually changed.
 * ConPTY repaints its whole screen on every resize, and a repaint can lose a line
 * of history, so a no-op resize is worth avoiding.
 */
export function syncSize(entry: TermEntry): void {
  if (entry.disposed) return;
  /*
   * Never fit a pane that is not on screen.
   *
   * Leaving a project hides its stage, which fires the pane's ResizeObserver, and
   * fitting there hands the PTY the ten-column guess described above. A shell would
   * only wrap its next line, but claude and codex repaint their whole interface at
   * whatever width they are told — and they emit real newlines and box characters
   * to do it, so there is nothing left for xterm to unwrap when the pane comes back.
   * The narrow banner then sits in the scrollback for the rest of the session.
   */
  if (!isMeasurable(entry)) return;
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
