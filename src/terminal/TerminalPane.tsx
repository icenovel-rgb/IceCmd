import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionKind } from "../types";
import ContextMenu from "../chrome/ContextMenu";
import { useWorkspace } from "../store/workspace";
import { listenForPathDrop } from "../sidebar/dnd";
import { copyText, pasteInto, selectionOf } from "./clipboard";
import { dropTextFor } from "./dropText";
import { createSession, killSession, writeSession } from "./ipc";
import {
  attachWebgl,
  createEntry,
  disposeEntry,
  getEntry,
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
  const rightClick = useWorkspace((s) => s.prefs.rightClick);

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
      {
        sessionId: paneId,
        cwd,
        kind,
        cols: entry.term.cols,
        rows: entry.term.rows,
        // Read here rather than subscribed to: the child's environment is fixed
        // at spawn, so making this a dependency would kill and respawn a live
        // shell the moment the switch was flipped.
        forceColor: useWorkspace.getState().prefs.forceColor,
      },
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

  /*
   * The right button never reaches xterm.js.
   *
   * A TUI that has asked for mouse reporting — claude and codex both do — gets
   * every button press forwarded to it as an escape sequence, and a CLI that
   * treats button 2 as "paste" then pastes on its own while this app is also
   * putting up its menu. That is the duplicate: two independent pastes from one
   * click. Swallowing the press in the capture phase, on an ancestor of xterm's
   * own element, means only one of them can ever happen — the one asked for
   * here. `contextmenu` is a separate event and still arrives.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const swallowRightButton = (event: MouseEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
      host.addEventListener(type, swallowRightButton, true);
    }
    return () => {
      for (const type of ["mousedown", "mouseup", "auxclick"] as const) {
        host.removeEventListener(type, swallowRightButton, true);
      }
    };
  }, []);

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
        /*
         * Blocking the WebView2 menu took Edge's copy/paste with it, so the pane
         * offers its own — or pastes outright, if that is what the user set in
         * 설정. Ctrl+Shift+C/V do the same two things either way.
         */
        onContextMenu={(event) => {
          event.preventDefault();
          if (rightClick === "paste") {
            void pasteInto(paneId);
            return;
          }
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
            { label: "모두 선택", onSelect: () => getEntry(paneId)?.term.selectAll() },
            // Scrollback only: the shell keeps its prompt and whatever is typed
            // on it, which `cls` would not.
            { label: "화면 지우기", onSelect: () => getEntry(paneId)?.term.clear() },
          ]}
        />
      )}
    </>
  );
}
