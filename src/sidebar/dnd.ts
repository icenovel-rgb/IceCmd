/**
 * Native file and folder drops. Tauri intercepts OS drags before the webview
 * sees them, so HTML5 drop handlers never fire; this listens to Tauri's own
 * event instead.
 *
 * Every target registers its own listener and checks the drop position against
 * its own element, so the sidebar and each terminal pane can accept drops
 * without knowing about each other.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { pathInfo } from "../terminal/ipc";

export interface DroppedPath {
  path: string;
  name: string;
  isDir: boolean;
}

/** Only the coordinates are used, so a plain object is enough to stand in. */
interface DropPosition {
  x: number;
  y: number;
}

/** Mirrors what Tauri hands `onDragDropEvent`, narrowed to what is used here. */
export type DropPayload =
  | { type: "enter"; paths: string[]; position: DropPosition }
  | { type: "over"; position: DropPosition }
  | { type: "drop"; paths: string[]; position: DropPosition }
  | { type: "leave" };

export interface DropTarget {
  /** Element the drop must land on, checked in CSS pixels. */
  element: () => HTMLElement | null;
  onHover: (inside: boolean) => void;
  /** Files and folders both, in the order the OS gave them. */
  onDrop: (paths: DroppedPath[]) => void;
}

/** Drop coordinates arrive in physical pixels; DOM rects are in CSS pixels. */
function isInside(element: HTMLElement | null, position: DropPosition): boolean {
  if (!element) return false;
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  const rect = element.getBoundingClientRect();
  // A hidden pane measures 0×0; without this it would claim a drop at the origin.
  if (rect.width === 0 || rect.height === 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Exported so a check can drive a drop without Tauri's event plumbing in the
 * way — the plumbing is the one part of this that a harness cannot reach.
 */
export async function handleDropPayload(payload: DropPayload, target: DropTarget): Promise<void> {
  if (payload.type === "leave") {
    target.onHover(false);
    return;
  }
  if (payload.type === "enter" || payload.type === "over") {
    target.onHover(isInside(target.element(), payload.position));
    return;
  }

  target.onHover(false);
  if (!isInside(target.element(), payload.position)) return;

  const checked = await Promise.all(
    payload.paths.map(async (path) => ({ path, info: await pathInfo(path) })),
  );
  const dropped = checked
    .filter((entry) => entry.info.exists)
    .map((entry) => ({ path: entry.path, name: entry.info.name, isDir: entry.info.isDir }));

  if (dropped.length > 0) target.onDrop(dropped);
}

export async function listenForPathDrop(target: DropTarget) {
  return getCurrentWebview().onDragDropEvent((event) => {
    void handleDropPayload(event.payload as DropPayload, target);
  });
}
