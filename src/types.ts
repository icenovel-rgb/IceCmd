export type SessionKind = "shell" | "claude" | "codex";

/** Ordered by priority: a project shows the strongest state among its panes. */
export type PaneStatus = "idle" | "busy" | "attention";

export type SplitDir = "row" | "col";

export type PaneNode =
  | { type: "leaf"; paneId: string }
  | { type: "split"; dir: SplitDir; ratio: number; a: PaneNode; b: PaneNode };

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface FsEntry {
  name: string;
  isDir: boolean;
}

export interface PathInfo {
  exists: boolean;
  isDir: boolean;
  name: string;
}

export interface SessionExit {
  sessionId: string;
  exitCode: number | null;
}
