/**
 * Single source of truth for projects, their split trees, and their panes.
 *
 * Deliberately free of side effects: PTY lifetime follows the React tree, because
 * `TerminalPane` spawns a session when it mounts and kills it when it unmounts.
 * Removing a pane or a project here is therefore enough to stop its shell.
 */
import { create } from "zustand";
import type { PaneNode, PaneStatus, Project, SessionKind, SplitDir } from "../types";
import {
  flipSplit,
  largestPane,
  leaf,
  movePane,
  paneIds,
  removePane,
  setRatio,
  splitPane,
  type DropEdge,
} from "../layout/tree";

/** Chrome sizes the user can adjust, kept with the rest of the persisted state. */
export interface UiPrefs {
  sidebarWidth: number;
  rightPanelWidth: number;
  /** Terminal text size in px. Separate from uiScale on purpose. */
  fontSize: number;
  /** Multiplier for the chrome around the terminals. */
  uiScale: number;
}

/**
 * The user's own remembered pair, distinct from the factory default.
 * Sliders get nudged all day; this is the "put it back the way I like it" anchor,
 * which the 100% / 13px default is not.
 */
export interface SavedSizes {
  fontSize: number;
  uiScale: number;
}

/**
 * What the right mouse button does over a terminal.
 *
 * Two honest answers exist and terminals disagree about which is right, so it is
 * a setting rather than a guess: `menu` shows this app's own copy/paste menu,
 * `paste` behaves like a console with QuickEdit on and pastes straight away.
 */
export type RightClickAction = "menu" | "paste";

/** Behaviour the user picks in 설정, kept apart from the sizes above. */
export interface AppPrefs {
  rightClick: RightClickAction;
  /** Redraw folder rows when the folder changes on disk, without a refresh. */
  watchFolders: boolean;
  /**
   * Tell plain shells to emit colour instead of letting them work it out.
   * CLI panes are told regardless; this is for the machine where a CLI started
   * by hand from a shell pane comes out in black and white.
   */
  forceColor: boolean;
  /**
   * Take the claude reading from its source rather than from the cache the CLI
   * only refreshes when it feels like it.
   */
  liveUsage: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  rightClick: "menu",
  watchFolders: true,
  forceColor: false,
  liveUsage: true,
};

export const UI_LIMITS = {
  sidebar: { min: 140, max: 460 },
  rightPanel: { min: 180, max: 520 },
  fontSize: { min: 9, max: 24 },
  uiScale: { min: 0.8, max: 1.6 },
};

export const UI_SCALE_STEP = 0.05;

export const DEFAULT_UI: UiPrefs = {
  sidebarWidth: 200,
  rightPanelWidth: 248,
  fontSize: 13,
  uiScale: 1,
};

const clampTo = (value: number, range: { min: number; max: number }) =>
  Math.round(Math.min(range.max, Math.max(range.min, value)));

/** Scale keeps two decimals; rounding to whole pixels would quantise it away. */
const clampScale = (value: number) =>
  Math.round(Math.min(UI_LIMITS.uiScale.max, Math.max(UI_LIMITS.uiScale.min, value)) * 100) / 100;

export interface PaneMeta {
  paneId: string;
  projectId: string;
  cwd: string;
  kind: SessionKind;
}

interface WorkspaceState {
  projects: Project[];
  layouts: Record<string, PaneNode | null>;
  panes: Record<string, PaneMeta>;
  activeProjectId: string | null;
  /** Last focused pane per project, so switching back restores focus. */
  focusedPane: Record<string, string | undefined>;
  /**
   * Folder-tree rows the user has opened, per project.
   *
   * Kept here rather than in the tree component because the component is remounted
   * on every project change: local state would put the tree back to just its root
   * each time, which is exactly what it used to do.
   */
  expandedFolders: Record<string, string[]>;
  status: Record<string, PaneStatus>;
  ui: UiPrefs;
  prefs: AppPrefs;
  /** null until the user saves one. */
  mySizes: SavedSizes | null;
  hydrated: boolean;

  addProject: (path: string, name: string) => string | null;
  removeProject: (projectId: string) => void;
  /** Drag-reorder in the sidebar. `toIndex` is a slot in the *current* list. */
  moveProject: (projectId: string, toIndex: number) => void;
  setActiveProject: (projectId: string) => void;
  setFocusedPane: (projectId: string, paneId: string) => void;
  /** Opens a folder row if it is closed, closes it if it is open. */
  toggleFolder: (projectId: string, path: string) => void;

  splitPaneWith: (paneId: string, dir: SplitDir, kind: SessionKind) => void;
  /** `cwd` defaults to the project folder; the folder tree passes a subfolder. */
  openCli: (projectId: string, kind: SessionKind, cwd?: string) => void;
  closePane: (paneId: string) => void;
  adjustRatio: (projectId: string, path: string, ratio: number) => void;
  movePaneTo: (projectId: string, sourceId: string, targetId: string, edge: DropEdge) => void;
  flipSplitAt: (projectId: string, path: string) => void;

  setStatus: (projectId: string, status: PaneStatus) => void;
  setSidebarWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setFontSize: (size: number) => void;
  nudgeFontSize: (delta: number) => void;
  setUiScale: (scale: number) => void;
  nudgeUiScale: (delta: number) => void;
  saveMySizes: () => void;
  applyMySizes: () => void;
  clearMySizes: () => void;
  setPrefs: (patch: Partial<AppPrefs>) => void;
  replaceAll: (snapshot: WorkspaceSnapshot) => void;
}

export interface WorkspaceSnapshot {
  projects: Project[];
  layouts: Record<string, PaneNode | null>;
  panes: Record<string, PaneMeta>;
  activeProjectId: string | null;
  expandedFolders: Record<string, string[]>;
  ui: UiPrefs;
  prefs: AppPrefs;
  mySizes: SavedSizes | null;
}

const newPaneId = () => `pane-${crypto.randomUUID()}`;

/** Windows paths are case-insensitive, so the key must be too. */
export const projectIdFor = (path: string) => path.replace(/[\\/]+$/, "").toLowerCase();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projects: [],
  layouts: {},
  panes: {},
  activeProjectId: null,
  focusedPane: {},
  expandedFolders: {},
  status: {},
  ui: DEFAULT_UI,
  prefs: DEFAULT_PREFS,
  mySizes: null,
  hydrated: false,

  addProject: (path, name) => {
    const projectId = projectIdFor(path);
    if (get().projects.some((p) => p.id === projectId)) {
      // Already tracked: just bring it forward.
      set({ activeProjectId: projectId });
      return projectId;
    }
    const paneId = newPaneId();
    set((state) => ({
      projects: [...state.projects, { id: projectId, name, path }],
      layouts: { ...state.layouts, [projectId]: leaf(paneId) },
      panes: {
        ...state.panes,
        [paneId]: { paneId, projectId, cwd: path, kind: "shell" },
      },
      activeProjectId: projectId,
      focusedPane: { ...state.focusedPane, [projectId]: paneId },
    }));
    return projectId;
  },

  removeProject: (projectId) => {
    set((state) => {
      const doomed = new Set(paneIds(state.layouts[projectId] ?? null));
      const panes = Object.fromEntries(
        Object.entries(state.panes).filter(([id]) => !doomed.has(id)),
      );
      const projects = state.projects.filter((p) => p.id !== projectId);
      const { [projectId]: _layout, ...layouts } = state.layouts;
      const { [projectId]: _focus, ...focusedPane } = state.focusedPane;
      const { [projectId]: _open, ...expandedFolders } = state.expandedFolders;
      const { [projectId]: _status, ...status } = state.status;
      const activeProjectId =
        state.activeProjectId === projectId
          ? (projects[0]?.id ?? null)
          : state.activeProjectId;
      return {
        projects,
        layouts,
        panes,
        focusedPane,
        expandedFolders,
        status,
        activeProjectId,
      };
    });
  },

  /*
   * Only the sidebar's order changes. Nothing else reads the array's order —
   * `App` draws the stages in a fixed order of its own — so a reorder can never
   * move a pane's DOM node and disturb the shell living in it.
   */
  moveProject: (projectId, toIndex) =>
    set((state) => {
      const from = state.projects.findIndex((project) => project.id === projectId);
      if (from < 0) return state;
      const target = Math.min(Math.max(toIndex, 0), state.projects.length - 1);
      if (target === from) return state;
      const projects = [...state.projects];
      const [moved] = projects.splice(from, 1);
      projects.splice(target, 0, moved);
      return { projects };
    }),

  setActiveProject: (projectId) => set({ activeProjectId: projectId }),

  setFocusedPane: (projectId, paneId) =>
    set((state) =>
      state.focusedPane[projectId] === paneId
        ? state
        : { focusedPane: { ...state.focusedPane, [projectId]: paneId } },
    ),

  toggleFolder: (projectId, path) =>
    set((state) => {
      const open = state.expandedFolders[projectId] ?? [];
      const next = open.includes(path)
        ? open.filter((candidate) => candidate !== path)
        : [...open, path];
      return { expandedFolders: { ...state.expandedFolders, [projectId]: next } };
    }),

  splitPaneWith: (paneId, dir, kind) => {
    const meta = get().panes[paneId];
    if (!meta) return;
    const layout = get().layouts[meta.projectId];
    if (!layout) return;
    const created = newPaneId();
    set((state) => ({
      layouts: {
        ...state.layouts,
        [meta.projectId]: splitPane(layout, paneId, dir, created),
      },
      panes: {
        ...state.panes,
        [created]: { paneId: created, projectId: meta.projectId, cwd: meta.cwd, kind },
      },
      focusedPane: { ...state.focusedPane, [meta.projectId]: created },
    }));
  },

  openCli: (projectId, kind, cwd) => {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const layout = state.layouts[projectId] ?? null;
    const created = newPaneId();

    // With no pane yet the CLI becomes the root; otherwise it halves the
    // roomiest pane, splitting along its longer edge.
    const target = largestPane(layout);
    const nextLayout =
      target && layout
        ? splitPane(layout, target.paneId, target.dir, created)
        : leaf(created);

    set({
      layouts: { ...state.layouts, [projectId]: nextLayout },
      panes: {
        ...state.panes,
        [created]: { paneId: created, projectId, cwd: cwd ?? project.path, kind },
      },
      focusedPane: { ...state.focusedPane, [projectId]: created },
    });
  },

  closePane: (paneId) => {
    const meta = get().panes[paneId];
    if (!meta) return;
    const layout = get().layouts[meta.projectId] ?? null;
    if (!layout) return;
    const next = removePane(layout, paneId);
    set((state) => {
      const { [paneId]: _gone, ...panes } = state.panes;
      const focused = state.focusedPane[meta.projectId];
      return {
        layouts: { ...state.layouts, [meta.projectId]: next },
        panes,
        focusedPane:
          focused === paneId
            ? { ...state.focusedPane, [meta.projectId]: paneIds(next)[0] }
            : state.focusedPane,
      };
    });
  },

  adjustRatio: (projectId, path, ratio) =>
    set((state) => {
      const layout = state.layouts[projectId];
      if (!layout) return state;
      return { layouts: { ...state.layouts, [projectId]: setRatio(layout, path, ratio) } };
    }),

  movePaneTo: (projectId, sourceId, targetId, edge) =>
    set((state) => {
      const layout = state.layouts[projectId];
      if (!layout) return state;
      const next = movePane(layout, sourceId, targetId, edge);
      if (next === layout) return state;
      return {
        layouts: { ...state.layouts, [projectId]: next },
        focusedPane: { ...state.focusedPane, [projectId]: sourceId },
      };
    }),

  flipSplitAt: (projectId, path) =>
    set((state) => {
      const layout = state.layouts[projectId];
      if (!layout) return state;
      const next = flipSplit(layout, path);
      return next === layout ? state : { layouts: { ...state.layouts, [projectId]: next } };
    }),

  setStatus: (projectId, status) =>
    set((state) =>
      state.status[projectId] === status
        ? state
        : { status: { ...state.status, [projectId]: status } },
    ),

  setSidebarWidth: (width) =>
    set((state) => ({
      ui: { ...state.ui, sidebarWidth: clampTo(width, UI_LIMITS.sidebar) },
    })),

  setRightPanelWidth: (width) =>
    set((state) => ({
      ui: { ...state.ui, rightPanelWidth: clampTo(width, UI_LIMITS.rightPanel) },
    })),

  setFontSize: (size) =>
    set((state) => ({ ui: { ...state.ui, fontSize: clampTo(size, UI_LIMITS.fontSize) } })),

  nudgeFontSize: (delta) =>
    set((state) => ({
      ui: { ...state.ui, fontSize: clampTo(state.ui.fontSize + delta, UI_LIMITS.fontSize) },
    })),

  setUiScale: (scale) => set((state) => ({ ui: { ...state.ui, uiScale: clampScale(scale) } })),

  nudgeUiScale: (delta) =>
    set((state) => ({ ui: { ...state.ui, uiScale: clampScale(state.ui.uiScale + delta) } })),

  saveMySizes: () =>
    set((state) => ({
      mySizes: { fontSize: state.ui.fontSize, uiScale: state.ui.uiScale },
    })),

  applyMySizes: () =>
    set((state) =>
      state.mySizes
        ? {
            ui: {
              ...state.ui,
              // Re-clamp on the way in: a hand-edited state file could hold anything.
              fontSize: clampTo(state.mySizes.fontSize, UI_LIMITS.fontSize),
              uiScale: clampScale(state.mySizes.uiScale),
            },
          }
        : state,
    ),

  clearMySizes: () => set({ mySizes: null }),

  setPrefs: (patch) => set((state) => ({ prefs: { ...state.prefs, ...patch } })),

  replaceAll: (snapshot) =>
    set({
      projects: snapshot.projects,
      layouts: snapshot.layouts,
      panes: snapshot.panes,
      activeProjectId: snapshot.activeProjectId,
      expandedFolders: snapshot.expandedFolders,
      ui: snapshot.ui,
      prefs: snapshot.prefs,
      mySizes: snapshot.mySizes,
      focusedPane: {},
      status: {},
      hydrated: true,
    }),
}));
