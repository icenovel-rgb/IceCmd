import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useWorkspace } from "../store/workspace";
import { paneIds } from "../layout/tree";
import { clearAttention } from "../terminal/status";
import { openInFileManager } from "../terminal/ipc";
import ContextMenu from "../chrome/ContextMenu";
import ProjectItem from "./ProjectItem";
import { listenForPathDrop } from "./dnd";
import UpdateBanner from "./UpdateBanner";

interface Menu {
  projectId: string;
  x: number;
  y: number;
}

interface Reorder {
  projectId: string;
  from: number;
  /** Where it would land, as an index into the list as it is now. */
  to: number;
}

/** Below this the press is a click on a project, not a drag of it. */
const REORDER_THRESHOLD_PX = 5;

export default function Sidebar() {
  const projects = useWorkspace((s) => s.projects);
  const layouts = useWorkspace((s) => s.layouts);
  const status = useWorkspace((s) => s.status);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const addProject = useWorkspace((s) => s.addProject);
  const removeProject = useWorkspace((s) => s.removeProject);
  const moveProject = useWorkspace((s) => s.moveProject);
  const setActiveProject = useWorkspace((s) => s.setActiveProject);
  const fontSize = useWorkspace((s) => s.ui.fontSize);

  const listRef = useRef<HTMLDivElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // A drag ends with a `click` on the row it started from; that one is not a
  // choice of project, it is the tail of the gesture.
  const swallowClick = useRef(false);

  useEffect(() => {
    const pending = listenForPathDrop({
      element: () => listRef.current,
      onHover: setDropActive,
      // Files are ignored here: only a directory can become a project.
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

  const select = (projectId: string) => {
    if (swallowClick.current) return;
    setActiveProject(projectId);
    clearAttention(projectId);
  };

  /**
   * Where the dragged row would land, given a pointer height.
   *
   * Counts the rows whose middle is above the pointer, then accounts for the
   * dragged row being lifted out of the list: everything below it shifts up by
   * one. Pointer events, not HTML5 drag — Tauri owns the webview's drag pipeline
   * on Windows, so `dragstart` never fires there.
   */
  const slotAt = (clientY: number, from: number): number => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(".project-item") ?? [],
    );
    let above = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top + rect.height / 2) above += 1;
    }
    return above > from ? above - 1 : above;
  };

  const beginReorder = (event: ReactPointerEvent, projectId: string, from: number) => {
    if (event.button !== 0 || projects.length < 2) return;
    const startY = event.clientY;
    let moving = false;
    let to = from;

    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };

    const onMove = (moved: PointerEvent) => {
      if (!moving) {
        if (Math.abs(moved.clientY - startY) < REORDER_THRESHOLD_PX) return;
        moving = true;
      }
      to = slotAt(moved.clientY, from);
      setReorder({ projectId, from, to });
    };

    const onUp = () => {
      stop();
      setReorder(null);
      if (!moving) return;
      swallowClick.current = true;
      // Cleared on the next task: `click` is dispatched before any timer runs.
      window.setTimeout(() => {
        swallowClick.current = false;
      }, 0);
      moveProject(projectId, to);
    };

    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      stop();
      setReorder(null);
      moving = false;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
  };

  /** The line drawn on a row: above it when the drop lands there, below when past it. */
  const insertMark = (index: number): "before" | "after" | null => {
    if (!reorder || reorder.to === reorder.from || index !== reorder.to) return null;
    return reorder.to < reorder.from ? "before" : "after";
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>프로젝트</span>
        {/* Ctrl +/- has no other visible feedback. */}
        <span className="zoom-readout" title="Ctrl + / − / 0 · Ctrl+휠">
          {fontSize}px
        </span>
      </div>
      <div
        ref={listRef}
        className={`project-list${dropActive ? " drop-active" : ""}`}
      >
        {projects.map((project, index) => (
          <ProjectItem
            key={project.id}
            project={project}
            status={status[project.id] ?? "idle"}
            active={project.id === activeProjectId}
            paneCount={paneIds(layouts[project.id] ?? null).length}
            dragging={reorder?.projectId === project.id}
            insert={insertMark(index)}
            onSelect={() => select(project.id)}
            onPointerDown={(event) => beginReorder(event, project.id, index)}
            onContextMenu={(position) =>
              setMenu({ projectId: project.id, x: position.x, y: position.y })
            }
          />
        ))}
        {projects.length === 0 && (
          <p className="sidebar-empty">
            탐색기에서 폴더를
            <br />
            여기로 끌어다 놓으세요
          </p>
        )}
      </div>

      <UpdateBanner />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          entries={[
            {
              label: "탐색기에서 열기",
              onSelect: () => {
                const target = projects.find((p) => p.id === menu.projectId);
                if (target) void openInFileManager(target.path).catch(() => {});
              },
            },
            {
              label: "프로젝트 제거",
              danger: true,
              onSelect: () => removeProject(menu.projectId),
            },
          ]}
        />
      )}
    </aside>
  );
}
