/**
 * Per-project status without any monitoring cost.
 *
 * Every signal is already produced by work we do anyway: xterm.js parses each
 * byte for display and raises `onBell`, and the output timestamp is stamped by the
 * same function that writes to the terminal. All this module adds is one shared
 * 1 Hz timer doing a timestamp comparison per pane.
 */
import type { PaneStatus } from "../types";
import { useWorkspace } from "../store/workspace";
import { allEntries, getEntry } from "./termRegistry";

/** Claude Code repaints continuously while working and goes quiet when waiting. */
const BUSY_WINDOW_MS = 2500;
const TICK_MS = 1000;

const RANK: Record<PaneStatus, number> = { idle: 0, busy: 1, attention: 2 };
const strongest = (a: PaneStatus, b: PaneStatus) => (RANK[b] > RANK[a] ? b : a);

let timer: number | null = null;

export function startStatusMonitor(): void {
  if (timer !== null) return;
  timer = window.setInterval(tick, TICK_MS);
}

export function stopStatusMonitor(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/**
 * Whether being on this project counts as having seen its bell.
 *
 * It does when the window is in front: the pane is on screen and whatever rang is
 * right there. It does not when the app is behind something else — the taskbar
 * will not say which project wanted you, so the bell has to wait.
 */
export const bellIsSeen = (isActiveProject: boolean, windowFocused: boolean): boolean =>
  isActiveProject && windowFocused;

function tick(): void {
  const { projects, panes, activeProjectId, setStatus } = useWorkspace.getState();
  if (projects.length === 0) return;

  const rollup = new Map<string, PaneStatus>(projects.map((p) => [p.id, "idle"]));
  const now = performance.now();
  const windowFocused = document.hasFocus();

  for (const entry of allEntries()) {
    const meta = panes[entry.paneId];
    if (!meta || !rollup.has(meta.projectId)) continue;

    /*
     * Clearing the bell used to happen in one place only — clicking the project
     * row in the sidebar. So a bell rung on the project you were *already*
     * looking at could never be cleared: there was no row left to click. And
     * because attention outranks busy, one such bell pinned the indicator for the
     * rest of the session and the "working" spinner never appeared again.
     */
    if (bellIsSeen(meta.projectId === activeProjectId, windowFocused)) {
      entry.attention = false;
    }

    const paneStatus: PaneStatus = entry.attention
      ? "attention"
      : !entry.exited && now - entry.lastOutputAt < BUSY_WINDOW_MS
        ? "busy"
        : "idle";
    rollup.set(meta.projectId, strongest(rollup.get(meta.projectId)!, paneStatus));
  }

  for (const [projectId, status] of rollup) setStatus(projectId, status);
}

/** Called when the user looks at a project, which is what "seen it" means here. */
export function clearAttention(projectId: string): void {
  const { panes } = useWorkspace.getState();
  for (const entry of allEntries()) {
    if (panes[entry.paneId]?.projectId === projectId) entry.attention = false;
  }
}

export function markExited(paneId: string): void {
  const entry = getEntry(paneId);
  if (entry) entry.exited = true;
}
