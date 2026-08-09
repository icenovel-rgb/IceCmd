import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionKind } from "../types";
import ContextMenu from "../chrome/ContextMenu";
import { listenForPathDrop } from "../sidebar/dnd";
import { copyText, pasteInto, selectionOf } from "./clipboard";
import { dropTextFor } from "./dropText";
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

interface Menu {
  x: number;
  y: number;
  /** Captured when the menu opens, so "복사" copies what was right-clicked. */
  selection: string;
}

export default function TerminalPane({ paneId, cwd, kind, initialFontSize }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fontSizeRef = useRef(initialFontSize);
  fontSizeRef.current = initialFontSize;
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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

  // Dropping files or folders on a pane types their paths at the cursor.
  useEffect(() => {
    // The class is toggled by hand rather than through state: a drag fires an
    // `over` event continuously, and re-rendering a terminal on each one would
    // cost far more than the outline is worth.
    const mark = (inside: boolean) => hostRef.current?.classList.toggle("drop-active", inside);
    const pending = listenForPathDrop({
      element: () => hostRef.current,
      onHover: mark,
      onDrop: (dropped) => {
        mark(false);
        void writeSession(paneId, dropTextFor(dropped.map((entry) => entry.path)));
      },
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [paneId]);

  return (
    <>
      <div
        className="terminal-host"
        ref={hostRef}
        // Blocking the WebView2 menu took Edge's copy/paste with it, so the pane
        // offers its own. Ctrl+Shift+C/V still do the same two things.
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, selection: selectionOf(paneId) });
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          entries={[
            // Offered only when there is something to copy, rather than shown greyed.
            ...(menu.selection
              ? [{ label: "복사", onSelect: () => void copyText(menu.selection) }]
              : []),
            { label: "붙여넣기", onSelect: () => void pasteInto(paneId) },
          ]}
        />
      )}
    </>
  );
}
