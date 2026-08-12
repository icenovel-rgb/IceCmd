import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionExit } from "./types";
import { DEFAULT_UI, useWorkspace } from "./store/workspace";
import { hydrate, startAutoSave } from "./store/persist";
import PaneStage from "./layout/PaneStage";
import Sidebar from "./sidebar/Sidebar";
import { listenForPathDrop } from "./sidebar/dnd";
import RightPanel from "./rightpanel/RightPanel";
import ResizeHandle from "./chrome/ResizeHandle";
import UsageBar from "./chrome/UsageBar";
import {
  allEntries,
  applyFontSize,
  attachWebgl,
  detachWebgl,
  getEntry,
  repaint,
  syncSize,
} from "./terminal/termRegistry";
import { markExited, startStatusMonitor, stopStatusMonitor } from "./terminal/status";
import { useShortcuts } from "./useShortcuts";

export default function App() {
  const projects = useWorkspace((s) => s.projects);
  const layouts = useWorkspace((s) => s.layouts);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const hydrated = useWorkspace((s) => s.hydrated);
  const ui = useWorkspace((s) => s.ui);
  const setSidebarWidth = useWorkspace((s) => s.setSidebarWidth);
  const setRightPanelWidth = useWorkspace((s) => s.setRightPanelWidth);
  const addProject = useWorkspace((s) => s.addProject);

  useShortcuts();

  /*
   * Stages are drawn in a fixed order, not in the sidebar's order.
   *
   * Only one stage is ever visible, so their order on screen means nothing — but
   * reordering keyed children makes React move the DOM nodes, and a pane's node
   * carries a live terminal. Sorting by id keeps every node exactly where it was
   * while the sidebar list is being dragged about.
   */
  const stages = useMemo(
    () => [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [projects],
  );

  // With no terminal on screen there is nothing else the middle could mean, so
  // a folder dropped there joins the sidebar. Once panes exist they own their
  // own drops (a path typed at the cursor), and this target steps aside.
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [workspaceDrop, setWorkspaceDrop] = useState(false);
  const stageEmpty = !activeProjectId || !layouts[activeProjectId];
  const stageEmptyRef = useRef(stageEmpty);
  stageEmptyRef.current = stageEmpty;

  useEffect(() => {
    const pending = listenForPathDrop({
      // Returning null while panes are up is what makes the pane win: the drop
      // is then simply outside this target.
      element: () => (stageEmptyRef.current ? workspaceRef.current : null),
      onHover: setWorkspaceDrop,
      onDrop: (dropped) => {
        for (const entry of dropped) {
          if (entry.isDir) addProject(entry.path, entry.name);
        }
      },
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [addProject]);

  useEffect(() => {
    void hydrate();
    startStatusMonitor();
    const stopAutoSave = startAutoSave();

    const exitListener = listen<SessionExit>("session-exit", (event) => {
      const { sessionId, exitCode } = event.payload;
      markExited(sessionId);
      getEntry(sessionId)?.term.write(
        `\r\n\x1b[90m[셸이 종료되었습니다 (코드 ${exitCode ?? "?"})]\x1b[0m\r\n`,
      );
    });

    /*
     * Anywhere the app does not put up a menu of its own, WebView2 shows Edge's —
     * "장치에 탭 내보내기" and friends, which belong to a browser, not to this app.
     * Shift is left as an escape hatch so the DevTools element picker is still
     * reachable while developing.
     */
    const blockNativeMenu = (event: MouseEvent) => {
      if (!event.shiftKey) event.preventDefault();
    };
    window.addEventListener("contextmenu", blockNativeMenu);

    const harnessMode = import.meta.env.VITE_ICECMD_HARNESS;
    if (harnessMode) {
      void import("./devHarness").then((module) => module.runHarness(harnessMode));
    }
    if (import.meta.env.VITE_ICECMD_TOUR) {
      void import("./devTour").then((module) => module.runTour());
    }

    return () => {
      stopStatusMonitor();
      stopAutoSave();
      window.removeEventListener("contextmenu", blockNativeMenu);
      void exitListener.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    applyFontSize(ui.fontSize);
  }, [ui.fontSize]);

  /*
   * A window that was minimised or covered comes back with its canvases empty:
   * WebView2 throws the GPU surface away and xterm is never told, so the terminal
   * shows only whatever has been rewritten since — the prompt at the bottom, and
   * nothing above it until you scroll. Coming back is the moment to redraw.
   */
  useEffect(() => {
    const repaintVisible = () => {
      const { panes, activeProjectId: active } = useWorkspace.getState();
      for (const entry of allEntries()) {
        if (panes[entry.paneId]?.projectId === active) repaint(entry);
      }
    };
    window.addEventListener("focus", repaintVisible);
    document.addEventListener("visibilitychange", repaintVisible);
    return () => {
      window.removeEventListener("focus", repaintVisible);
      document.removeEventListener("visibilitychange", repaintVisible);
    };
  }, []);

  // Hidden panes keep their scrollback but give up their WebGL context: browsers
  // cap live contexts, and nothing offscreen is being painted anyway.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const { panes } = useWorkspace.getState();
      for (const entry of allEntries()) {
        const meta = panes[entry.paneId];
        if (!meta) continue;
        if (meta.projectId === activeProjectId) {
          attachWebgl(entry);
          syncSize(entry);
          // syncSize only tells the PTY when the grid actually changed, and an
          // unchanged grid means no repaint — so a pane coming back on screen
          // would keep whatever the renderer last drew, which may be nothing.
          repaint(entry);
        } else {
          detachWebgl(entry);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeProjectId, layouts, ui.sidebarWidth, ui.rightPanelWidth, ui.uiScale]);

  return (
    // --ui-scale drives the `zoom` on the chrome. Panel widths are stored unzoomed,
    // so the pointer position has to be divided by the scale to match.
    <div className="app-root" style={{ "--ui-scale": ui.uiScale } as React.CSSProperties}>
      <div className="app-shell">
        <div className="sidebar-wrap" style={{ width: ui.sidebarWidth }}>
          <Sidebar />
        </div>
        <ResizeHandle
          side="right"
          widthFrom={(clientX) => clientX / ui.uiScale}
          onWidth={setSidebarWidth}
          onReset={() => setSidebarWidth(DEFAULT_UI.sidebarWidth)}
        />

        <div
          ref={workspaceRef}
          className={`workspace${workspaceDrop ? " drop-active" : ""}`}
        >
          {stages.map((project) => {
            const layout = layouts[project.id];
            const isActive = project.id === activeProjectId;
            return (
              <div
                key={project.id}
                className="project-stage"
                // Kept mounted so switching projects is instant and scrollback survives.
                style={{ display: isActive ? "block" : "none" }}
              >
                {layout ? (
                  <PaneStage projectId={project.id} layout={layout} active={isActive} />
                ) : (
                  <div className="empty-hint">
                    페인이 없습니다.
                    <br />
                    오른쪽에서 cmd·claude·codex를 눌러 새로 여세요.
                    <br />
                    폴더를 여기로 끌어다 놓으면 프로젝트로 추가됩니다.
                  </div>
                )}
              </div>
            );
          })}
          {hydrated && projects.length === 0 && (
            <div className="empty-hint">
              폴더를 여기나 왼쪽 사이드바로 끌어다 놓으면
              <br />
              프로젝트가 추가되고 터미널이 열립니다.
            </div>
          )}
        </div>

        <ResizeHandle
          side="left"
          widthFrom={(clientX) => (window.innerWidth - clientX) / ui.uiScale}
          onWidth={setRightPanelWidth}
          onReset={() => setRightPanelWidth(DEFAULT_UI.rightPanelWidth)}
        />
        <div className="rightpanel-wrap" style={{ width: ui.rightPanelWidth }}>
          <RightPanel />
        </div>
      </div>

      <UsageBar />
    </div>
  );
}
