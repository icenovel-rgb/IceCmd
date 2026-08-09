/**
 * Window-level shortcuts. Registered in the capture phase because xterm.js
 * otherwise forwards the keystroke straight to the PTY, and because WebView2 has
 * its own Ctrl+/Ctrl-/Ctrl+wheel page zoom that must not fire.
 */
import { useEffect } from "react";
import { DEFAULT_UI, useWorkspace } from "./store/workspace";
import { copySelection, pasteInto, selectionOf } from "./terminal/clipboard";

/** Ctrl+= and Ctrl++ both mean "bigger", across keyboard layouts. */
const ZOOM_IN_KEYS = new Set(["+", "=", "Add"]);
const ZOOM_OUT_KEYS = new Set(["-", "_", "Subtract"]);

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      const { activeProjectId, focusedPane, splitPaneWith, closePane, nudgeFontSize, setFontSize } =
        useWorkspace.getState();
      const paneId = activeProjectId ? focusedPane[activeProjectId] : undefined;

      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // Zoom works with or without Shift, and needs no focused pane.
      if (ZOOM_IN_KEYS.has(event.key)) {
        consume();
        nudgeFontSize(1);
        return;
      }
      if (ZOOM_OUT_KEYS.has(event.key)) {
        consume();
        nudgeFontSize(-1);
        return;
      }
      if (event.key === "0") {
        consume();
        setFontSize(DEFAULT_UI.fontSize);
        return;
      }

      if (!event.shiftKey || !paneId) return;

      switch (event.key.toLowerCase()) {
        case "d":
          consume();
          splitPaneWith(paneId, "row", "shell");
          break;
        case "e":
          consume();
          splitPaneWith(paneId, "col", "shell");
          break;
        case "w":
          consume();
          closePane(paneId);
          break;
        // Both share their implementation with the pane's context menu.
        case "c":
          // Without a selection the keystroke belongs to the shell (Ctrl+C).
          if (selectionOf(paneId)) {
            consume();
            void copySelection(paneId);
          }
          break;
        case "v":
          consume();
          void pasteInto(paneId);
          break;
        default:
          break;
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      useWorkspace.getState().nudgeFontSize(event.deltaY < 0 ? 1 : -1);
    };

    window.addEventListener("keydown", onKeyDown, true);
    // Not passive: the browser's own zoom has to be cancelled.
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    };
  }, []);
}
