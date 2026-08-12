/**
 * Dragging a folder-tree row onto a terminal, in pointer events.
 *
 * **Not HTML5 drag-and-drop.** `dragDropEnabled` hands the webview's whole drag
 * pipeline to Tauri's native file-drop handler on Windows, so `dragstart` and
 * `drop` never fire there — the same reason the split layout is pointer-driven
 * (see README). 0.5.0 shipped this as an HTML5 drag and it could only ever have
 * worked in a check that dispatched the events itself.
 *
 * Explorer drops are a different pipe again and live in `sidebar/dnd.ts`. Do not
 * try to serve both from one place: neither one's events reach the other.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { useWorkspace } from "../store/workspace";
import { dropTextFor } from "./dropText";
import { writeSession } from "./ipc";
import { getEntry } from "./termRegistry";

/** Far enough that clicking a folder row to expand it is never read as a drag. */
const DRAG_THRESHOLD_PX = 5;

export interface PathDragOptions {
  path: string;
  /** Carried under the pointer, so it is obvious what is being dragged. */
  label: string;
  /** Runs instead when the press turned out to be an ordinary click. */
  onTap?: () => void;
}

let ghost: HTMLDivElement | null = null;
let hovered: HTMLElement | null = null;

/** Says which pane the path will land in. One at a time, by construction. */
function markHover(host: HTMLElement | null): void {
  if (hovered === host) return;
  hovered?.classList.remove("drop-active");
  host?.classList.add("drop-active");
  hovered = host;
}

/**
 * The terminal under the pointer, or null.
 *
 * Panes of the projects that are not on screen are `display: none`, so they
 * cannot answer — which is exactly the right answer for them.
 */
function hostAt(x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y);
  return element instanceof HTMLElement ? element.closest<HTMLElement>(".terminal-host") : null;
}

function clearVisuals(): void {
  markHover(null);
  ghost?.remove();
  ghost = null;
}

/** Types the path at that pane's cursor and gives it the keyboard. */
function dropInto(host: HTMLElement, path: string): void {
  const paneId = host.closest<HTMLElement>("[data-pane]")?.dataset.pane;
  if (!paneId) return;
  void writeSession(paneId, dropTextFor([path]));
  // The text landed at this pane's cursor, so the keyboard belongs here too —
  // otherwise the next keystroke goes to whichever pane was focused before.
  const meta = useWorkspace.getState().panes[paneId];
  if (meta) useWorkspace.getState().setFocusedPane(meta.projectId, paneId);
  getEntry(paneId)?.term.focus();
}

/**
 * Call from a row's `onPointerDown`. Nothing happens until the pointer has
 * actually moved, so the row keeps its click and its double-click.
 */
export function beginPathDrag(event: ReactPointerEvent, options: PathDragOptions): void {
  // The right button belongs to the context menu, the middle one to nothing here.
  if (event.button !== 0) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;

  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
  };

  const onMove = (moved: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      ghost = document.createElement("div");
      // On <body>, which carries no `zoom`, so the label sits under the pointer
      // whatever the UI scale is — the same reason the context menu is portalled.
      ghost.className = "drag-ghost";
      ghost.textContent = options.label;
      document.body.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.left = `${moved.clientX + 14}px`;
      ghost.style.top = `${moved.clientY + 16}px`;
    }
    markHover(hostAt(moved.clientX, moved.clientY));
  };

  const onUp = (up: PointerEvent) => {
    stop();
    // Read before the outline is cleared; clearing does not move anything, but
    // the order is what keeps that true.
    const host = dragging ? hostAt(up.clientX, up.clientY) : null;
    clearVisuals();
    if (!dragging) {
      options.onTap?.();
      return;
    }
    if (host) dropInto(host, options.path);
  };

  const onKey = (key: KeyboardEvent) => {
    if (key.key !== "Escape") return;
    stop();
    clearVisuals();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
}
