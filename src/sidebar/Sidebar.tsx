import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../store/workspace";
import { paneIds } from "../layout/tree";
import { clearAttention } from "../terminal/status";
import { openInFileManager } from "../terminal/ipc";
import ProjectItem from "./ProjectItem";
import { listenForFolderDrop } from "./dnd";
import UpdateBanner from "./UpdateBanner";

interface Menu {
  projectId: string;
  x: number;
  y: number;
}

export default function Sidebar() {
  const projects = useWorkspace((s) => s.projects);
  const layouts = useWorkspace((s) => s.layouts);
  const status = useWorkspace((s) => s.status);
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const addProject = useWorkspace((s) => s.addProject);
  const removeProject = useWorkspace((s) => s.removeProject);
  const setActiveProject = useWorkspace((s) => s.setActiveProject);
  const fontSize = useWorkspace((s) => s.ui.fontSize);

  const listRef = useRef<HTMLDivElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    const pending = listenForFolderDrop({
      element: () => listRef.current,
      onHover: setDropActive,
      onDrop: (folders) => {
        for (const folder of folders) addProject(folder.path, folder.name);
      },
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [addProject]);

  // Any click elsewhere dismisses the context menu.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", dismiss, { once: true });
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  const select = (projectId: string) => {
    setActiveProject(projectId);
    clearAttention(projectId);
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
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            status={status[project.id] ?? "idle"}
            active={project.id === activeProjectId}
            paneCount={paneIds(layouts[project.id] ?? null).length}
            onSelect={() => select(project.id)}
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

      {/*
        Rendered on <body>: the sidebar carries the UI-scale zoom, and a fixed
        element inside a zoomed ancestor gets its coordinates scaled too, which
        would place the menu away from the pointer.
      */}
      {menu &&
        createPortal(
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              type="button"
              onClick={() => {
                const target = projects.find((p) => p.id === menu.projectId);
                if (target) void openInFileManager(target.path).catch(() => {});
                setMenu(null);
              }}
            >
              탐색기에서 열기
            </button>
            <button
              type="button"
              className="context-danger"
              onClick={() => {
                removeProject(menu.projectId);
                setMenu(null);
              }}
            >
              프로젝트 제거
            </button>
          </div>,
          document.body,
        )}
    </aside>
  );
}
