/**
 * Projects, the open folders and the settings survive restarts; panes do not.
 *
 * Panes used to come back in their old arrangement, but only ever as plain cmd
 * shells — a restored `claude` pane must not start a CLI unprompted — so what
 * reopened was a stage full of cmd windows nobody had asked for, which the
 * claude button then had to split. Every project now reopens empty, the same
 * as a newly added one, and the layout is no longer written at all. Files from
 * older builds still carry `layouts`/`panes`; they are ignored.
 */
import type { Project } from "../types";
import { loadState, pathInfo, saveState } from "../terminal/ipc";
import {
  DEFAULT_PREFS,
  DEFAULT_UI,
  UI_LIMITS,
  useWorkspace,
  type AppPrefs,
  type SavedSizes,
  type UiPrefs,
  type WorkspaceSnapshot,
} from "./workspace";

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 600;

interface Stored {
  version: number;
  projects: Project[];
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

  const activeProjectId =
    parsed.activeProjectId && keep.has(parsed.activeProjectId)
      ? parsed.activeProjectId
      : (projects[0]?.id ?? null);

  const snapshot: WorkspaceSnapshot = {
    projects,
    // Every project reopens empty; see the top of this file.
    layouts: {},
    panes: {},
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
    // Status ticks every second; only persist when something saved changes.
    // Panes are not saved, so opening and closing them writes nothing.
    const unchanged =
      state.projects === previous.projects &&
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
