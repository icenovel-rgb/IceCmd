/**
 * Drags that start inside the app rather than in Explorer.
 *
 * The native drops handled by `sidebar/dnd.ts` never reach the webview — Tauri
 * takes them first — so a folder-tree row cannot reuse that path. These are
 * ordinary HTML5 drags, and the two ends only need to agree on a type.
 */
import type { DragEvent } from "react";

/** Own type so a drop can tell an app drag from a stray text selection. */
export const PATH_MIME = "application/x-icecmd-path";

export function startPathDrag(event: DragEvent, path: string): void {
  event.dataTransfer.setData(PATH_MIME, path);
  // Plain text as well, so dropping into anything else still yields the path.
  event.dataTransfer.setData("text/plain", path);
  event.dataTransfer.effectAllowed = "copy";
}

/** During `dragover` the payload is unreadable; only its types are exposed. */
export const dragCarriesPath = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer.types).includes(PATH_MIME);

export const pathFromDrag = (event: DragEvent): string | null =>
  event.dataTransfer.getData(PATH_MIME) || null;
