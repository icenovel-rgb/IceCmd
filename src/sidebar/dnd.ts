/**
 * Native folder drop. Tauri intercepts OS file drags before the webview sees
 * them, so HTML5 drop handlers never fire; this listens to Tauri's own event.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { pathInfo } from "../terminal/ipc";

export interface DropTarget {
  /** Element the drop must land on, checked in CSS pixels. */
  element: () => HTMLElement | null;
  onHover: (inside: boolean) => void;
  onDrop: (folders: { path: string; name: string }[]) => void;
}

/** Drop coordinates arrive in physical pixels; DOM rects are in CSS pixels. */
function isInside(element: HTMLElement | null, position: PhysicalPosition): boolean {
  if (!element) return false;
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export async function listenForFolderDrop(target: DropTarget) {
  return getCurrentWebview().onDragDropEvent(async (event) => {
    const payload = event.payload;

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

    // Files are ignored: only directories can become projects.
    const checked = await Promise.all(
      payload.paths.map(async (path) => ({ path, info: await pathInfo(path) })),
    );
    const folders = checked
      .filter((entry) => entry.info.exists && entry.info.isDir)
      .map((entry) => ({ path: entry.path, name: entry.info.name }));

    if (folders.length > 0) target.onDrop(folders);
  });
}
