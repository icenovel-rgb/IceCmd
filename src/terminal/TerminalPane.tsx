import { useEffect, useRef } from "react";
import type { SessionKind } from "../types";
import { createSession, killSession, writeSession } from "./ipc";
import {
  attachWebgl,
  createEntry,
  disposeEntry,
  syncSize,
  writeOutput,
} from "./termRegistry";

/** ConPTY repaints the whole screen on resize, so coalesce bursts of them. */
const RESIZE_DEBOUNCE_MS = 80;

interface Props {
  paneId: string;
  cwd: string;
  kind: SessionKind;
  /** Only used when the terminal is first created; later changes go through applyFontSize. */
  initialFontSize: number;
}

export default function TerminalPane({ paneId, cwd, kind, initialFontSize }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fontSizeRef = useRef(initialFontSize);
  fontSizeRef.current = initialFontSize;

  // Owns the whole lifetime of one PTY. React.StrictMode is deliberately not
  // used (see main.tsx): its double-mount would spawn two shells per pane.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const entry = createEntry(paneId, fontSizeRef.current);
    entry.term.open(host);
    attachWebgl(entry);
    entry.fit.fit();

    // Wire input before spawning: ConPTY opens with a cursor-position query and
    // stays silent until the terminal answers, and that answer comes through
    // onData like any keystroke.
    const onData = entry.term.onData((data) => {
      void writeSession(paneId, data);
    });
    const onBinary = entry.term.onBinary((data) => {
      void writeSession(paneId, data);
    });

    entry.sentCols = entry.term.cols;
    entry.sentRows = entry.term.rows;
    void createSession(
      { sessionId: paneId, cwd, kind, cols: entry.term.cols, rows: entry.term.rows },
      (chunk) => writeOutput(entry, chunk),
    );

    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        syncSize(entry);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      onData.dispose();
      onBinary.dispose();
      void killSession(paneId);
      disposeEntry(paneId);
    };
  }, [paneId, cwd, kind]);

  return <div className="terminal-host" ref={hostRef} />;
}
