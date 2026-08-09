import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionExit } from "./types";
import { DEFAULT_UI, useWorkspace } from "./store/workspace";
import { hydrate, startAutoSave } from "./store/persist";
import PaneStage from "./layout/PaneStage";
import Sidebar from "./sidebar/Sidebar";
import RightPanel from "./rightpanel/RightPanel";
import ResizeHandle from "./chrome/ResizeHandle";
import {
  allEntries,
  applyFontSize,
  attachWebgl,
  detachWebgl,
  getEntry,
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

  useShortcuts();

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
      void exitListener.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    applyFontSize(ui.fontSize);
  }, [ui.fontSize]);

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
    <div className="app-shell" style={{ "--ui-scale": ui.uiScale } as React.CSSProperties}>
      <div className="sidebar-wrap" style={{ width: ui.sidebarWidth }}>
        <Sidebar />
      </div>
      <ResizeHandle
        side="right"
        widthFrom={(clientX) => clientX / ui.uiScale}
        onWidth={setSidebarWidth}
        onReset={() => setSidebarWidth(DEFAULT_UI.sidebarWidth)}
      />

      <div className="workspace">
        {projects.map((project) => {
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
                </div>
              )}
            </div>
          );
        })}
        {hydrated && projects.length === 0 && (
          <div className="empty-hint">
            왼쪽 사이드바로 폴더를 끌어다 놓으면
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
  );
}
