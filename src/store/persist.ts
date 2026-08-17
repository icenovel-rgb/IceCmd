/**
 * Projects and layout shape survive restarts; PTYs do not. Restored panes come
 * back as plain shells so reopening the app never auto-launches a CLI.
 */
import type { PaneNode, Project, SessionKind } from "../types";
import { loadState, pathInfo, saveState } from "../terminal/ipc";
import { paneIds } from "../layout/tree";
import {
  DEFAULT_PREFS,
  DEFAULT_UI,
  UI_LIMITS,
  useWorkspace,
  type AppPrefs,
  type PaneMeta,
  type SavedSizes,
  type UiPrefs,
  type WorkspaceSnapshot,
} from "./workspace";

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 600;

interface Stored {
  version: number;
  projects: Project[];
  layouts: Record<string, PaneNode | null>;
  panes: Record<string, PaneMeta>;
  activeProjectId: string | null;
  expandedFolders?: Record<string, string[]>;
  ui?: UiPrefs;
  prefs?: AppPrefs;
  mySizes?: SavedSizes | null;
}

/**
 * Open folder rows, as last left. Written by older builds without this field, and
 * editable by hand, so anything unrecognised is dropped rather than trusted.
 * Projects that no longer exist are dropped with them.
 */
function readExpandedFolders(
  stored: Record<string, string[]> | undefined,
  keep: Set<string>,
): Record<string, string[]> {
  if (!stored || typeof stored !== "object") return {};
  const open: Record<string, string[]> = {};
  for (const [projectId, paths] of Object.entries(stored)) {
    if (!keep.has(projectId) || !Array.isArray(paths)) continue;
    const valid = paths.filter((path): path is string => typeof path === "string");
    if (valid.length > 0) open[projectId] = valid;
  }
  return open;
}

/** Written by older builds, or by hand. Anything unrecognised falls back. */
function readPrefs(stored: AppPrefs | undefined): AppPrefs {
  if (!stored) return DEFAULT_PREFS;
  return {
    rightClick: stored.rightClick === "paste" ? "paste" : DEFAULT_PREFS.rightClick,
    watchFolders:
      typeof stored.watchFolders === "boolean" ? stored.watchFolders : DEFAULT_PREFS.watchFolders,
    forceColor:
      typeof stored.forceColor === "boolean" ? stored.forceColor : DEFAULT_PREFS.forceColor,
    liveUsage:
      typeof stored.liveUsage === "boolean" ? stored.liveUsage : DEFAULT_PREFS.liveUsage,
  };
}

/** Older state files predate `ui`, and a hand-edited one may hold nonsense. */
function readUi(stored: UiPrefs | undefined): UiPrefs {
  if (!stored) return DEFAULT_UI;
  const pick = (value: unknown, fallback: number, range: { min: number; max: number }) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(range.max, Math.max(range.min, value)))
      : fallback;
  const scale =
    typeof stored.uiScale === "number" && Number.isFinite(stored.uiScale)
      ? Math.min(UI_LIMITS.uiScale.max, Math.max(UI_LIMITS.uiScale.min, stored.uiScale))
      : DEFAULT_UI.uiScale;
  return {
    sidebarWidth: pick(stored.sidebarWidth, DEFAULT_UI.sidebarWidth, UI_LIMITS.sidebar),
    rightPanelWidth: pick(
      stored.rightPanelWidth,
      DEFAULT_UI.rightPanelWidth,
      UI_LIMITS.rightPanel,
    ),
    fontSize: pick(stored.fontSize, DEFAULT_UI.fontSize, UI_LIMITS.fontSize),
    uiScale: Math.round(scale * 100) / 100,
  };
}

function isPaneNode(value: unknown): value is PaneNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") return typeof node.paneId === "string";
  if (node.type === "split") {
    return (
      (node.dir === "row" || node.dir === "col") &&
      typeof node.ratio === "number" &&
      isPaneNode(node.a) &&
      isPaneNode(node.b)
    );
  }
  return false;
}

/** The saved pair is user-editable on disk, so it is re-validated like any input. */
function readMySizes(stored: SavedSizes | null | undefined): SavedSizes | null {
  if (!stored) return null;
  const { fontSize, uiScale } = stored;
  if (!Number.isFinite(fontSize) || !Number.isFinite(uiScale)) return null;
  return {
    fontSize: Math.round(
      Math.min(UI_LIMITS.fontSize.max, Math.max(UI_LIMITS.fontSize.min, fontSize)),
    ),
    uiScale:
      Math.round(Math.min(UI_LIMITS.uiScale.max, Math.max(UI_LIMITS.uiScale.min, uiScale)) * 100) /
      100,
  };
}

export async function hydrate(): Promise<void> {
  const raw = await loadState().catch(() => null);
  if (!raw) {
    useWorkspace.setState({ hydrated: true });
    return;
  }

  let parsed: Stored;
  try {
    parsed = JSON.parse(raw) as Stored;
  } catch {
    useWorkspace.setState({ hydrated: true });
    return;
  }
  if (parsed.version !== VERSION || !Array.isArray(parsed.projects)) {
    useWorkspace.setState({ hydrated: true });
    return;
  }

  // Folders get moved and deleted between runs; drop the ones that are gone.
  const checked = await Promise.all(
    parsed.projects.map(async (project) => ({
      project,
      alive: await pathInfo(project.path)
        .then((info) => info.exists && info.isDir)
        .catch(() => false),
    })),
  );
  const projects = checked.filter((c) => c.alive).map((c) => c.project);
  const keep = new Set(projects.map((p) => p.id));

  const layouts: Record<string, PaneNode | null> = {};
  const panes: Record<string, PaneMeta> = {};
  for (const project of projects) {
    const layout = parsed.layouts?.[project.id];
    if (!isPaneNode(layout)) continue;
    layouts[project.id] = layout;
    for (const paneId of paneIds(layout)) {
      const stored = parsed.panes?.[paneId];
      panes[paneId] = {
        paneId,
        projectId: project.id,
        cwd: stored?.cwd ?? project.path,
        // Always a shell: a restored `claude` pane would start a CLI unprompted.
        kind: "shell" as SessionKind,
      };
    }
  }
  // A project whose layout failed validation still needs one pane to be usable.
  for (const project of projects) {
    if (layouts[project.id]) continue;
    const paneId = `pane-${crypto.randomUUID()}`;
    layouts[project.id] = { type: "leaf", paneId };
    panes[paneId] = { paneId, projectId: project.id, cwd: project.path, kind: "shell" };
  }

  const activeProjectId =
    parsed.activeProjectId && keep.has(parsed.activeProjectId)
      ? parsed.activeProjectId
      : (projects[0]?.id ?? null);

  const snapshot: WorkspaceSnapshot = {
    projects,
    layouts,
    panes,
    activeProjectId,
    expandedFolders: readExpandedFolders(parsed.expandedFolders, keep),
    ui: readUi(parsed.ui),
    prefs: readPrefs(parsed.prefs),
    mySizes: readMySizes(parsed.mySizes),
  };
  useWorkspace.getState().replaceAll(snapshot);
}

/** Subscribes to the store and writes a debounced snapshot. Returns an unsubscriber. */
export function startAutoSave(): () => void {
  let timer: number | null = null;

  const unsubscribe = useWorkspace.subscribe((state, previous) => {
    if (!state.hydrated) return;
    // Status ticks every second; only persist when real structure changes.
    const unchanged =
      state.projects === previous.projects &&
      state.layouts === previous.layouts &&
      state.panes === previous.panes &&
      state.activeProjectId === previous.activeProjectId &&
      state.expandedFolders === previous.expandedFolders &&
      state.ui === previous.ui &&
      state.prefs === previous.prefs &&
      state.mySizes === previous.mySizes;
    if (unchanged) return;

    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const current = useWorkspace.getState();
      const stored: Stored = {
        version: VERSION,
        projects: current.projects,
        layouts: current.layouts,
        panes: current.panes,
        activeProjectId: current.activeProjectId,
        expandedFolders: current.expandedFolders,
        ui: current.ui,
        prefs: current.prefs,
        mySizes: current.mySizes,
      };
      void saveState(JSON.stringify(stored)).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  });

  return () => {
    if (timer !== null) window.clearTimeout(timer);
    unsubscribe();
  };
}
