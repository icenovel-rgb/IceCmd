import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionKind } from "../types";
import ContextMenu from "../chrome/ContextMenu";
import { listenForPathDrop } from "../sidebar/dnd";
import { copyText, pasteInto, selectionOf } from "./clipboard";
import { dropTextFor } from "./dropText";
import { dragCarriesPath, pathFromDrag } from "./pathDrag";
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

    // Opt-in IME tracing; the module is never pulled into a normal build.
    let stopImeWatch: (() => void) | null = null;
    let paneGone = false;
    if (import.meta.env.VITE_ICECMD_IME_DEBUG) {
      void import("./imeDebug").then((module) => {
        if (paneGone) return;
        stopImeWatch = module.watchIme(paneId, entry.term);
      });
    }

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
      paneGone = true;
      stopImeWatch?.();
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      onData.dispose();
      onBinary.dispose();
      void killSession(paneId);
      disposeEntry(paneId);
    };
  }, [paneId, cwd, kind]);

  // The class is toggled by hand rather than through state: a drag fires an
  // `over` event continuously, and re-rendering a terminal on each one would
  // cost far more than the outline is worth.
  const markDrop = useCallback(
    (inside: boolean) => hostRef.current?.classList.toggle("drop-active", inside),
    [],
  );

  // Dropping files or folders on a pane types their paths at the cursor.
  useEffect(() => {
    const pending = listenForPathDrop({
      element: () => hostRef.current,
      onHover: markDrop,
      onDrop: (dropped) => {
        markDrop(false);
        void writeSession(paneId, dropTextFor(dropped.map((entry) => entry.path)));
      },
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [paneId, markDrop]);

  return (
    <>
      <div
        className="terminal-host"
        ref={hostRef}
        // The same outcome as an Explorer drop, but an in-app drag arrives
        // through the DOM rather than through Tauri's own drop event.
        onDragOver={(event) => {
          if (!dragCarriesPath(event)) return;
          // Without this the drop never happens: the default is "reject".
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          markDrop(true);
        }}
        // Moving between the host's own children fires a leave; only a pointer
        // that has actually left the pane should clear the outline.
        onDragLeave={(event) => {
          if (hostRef.current?.contains(event.relatedTarget as Node | null)) return;
          markDrop(false);
        }}
        onDrop={(event) => {
          const path = pathFromDrag(event);
          if (!path) return;
          event.preventDefault();
          markDrop(false);
          void writeSession(paneId, dropTextFor([path]));
        }}
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
