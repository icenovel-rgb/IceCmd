import { useCallback, useEffect, useState } from "react";
import type { FsEntry } from "../types";
import { openInFileManager, openPath, readDir, revealPath } from "../terminal/ipc";
import { startPathDrag } from "../terminal/pathDrag";
import { useWorkspace } from "../store/workspace";
import ContextMenu from "../chrome/ContextMenu";

interface Props {
  projectId: string;
  rootPath: string;
}

interface Menu {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

/** Children are fetched on expand and cached; nothing is watched, so idle cost is zero. */
export default function FolderTree({ projectId, rootPath }: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openCli = useWorkspace((s) => s.openCli);

  const load = useCallback(async (path: string) => {
    try {
      const entries = await readDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch {
      setFailed((prev) => new Set(prev).add(path));
    }
  }, []);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setFailed(new Set());
    void load(rootPath);
  }, [rootPath, load]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!children[path]) void load(path);
      }
      return next;
    });
  };

  const menuEntries = (target: Menu) =>
    target.isDir
      ? [
          {
            label: "탐색기에서 열기",
            onSelect: () => void openInFileManager(target.path).catch(() => {}),
          },
          {
            label: "여기서 cmd 열기",
            onSelect: () => openCli(projectId, "shell", target.path),
          },
        ]
      : [
          { label: "열기", onSelect: () => void openPath(target.path).catch(() => {}) },
          { label: "폴더에서 보기", onSelect: () => void revealPath(target.path).catch(() => {}) },
        ];

  const renderLevel = (path: string, depth: number) => {
    const entries = children[path];
    if (failed.has(path)) {
      return <p className="tree-note">읽을 수 없는 폴더입니다</p>;
    }
    if (!entries) return <p className="tree-note">…</p>;
    if (entries.length === 0) return <p className="tree-note">빈 폴더</p>;

    return entries.map((entry) => {
      const childPath = `${path}\\${entry.name}`;
      const isOpen = expanded.has(childPath);
      return (
        <div key={childPath}>
          <div
            className={`tree-row${entry.isDir ? " tree-dir" : ""}`}
            // The row carries its own path so a check never has to rebuild one
            // from the label and depth, and get it wrong.
            data-path={childPath}
            style={{ paddingLeft: 6 + depth * 12 }}
            // Dragging a row onto a terminal types its path there, the same way
            // dragging in from Explorer does.
            draggable
            onDragStart={(event) => startPathDrag(event, childPath)}
            onClick={() => entry.isDir && toggle(childPath)}
            // A folder row opens in Explorer on double-click; single click still
            // expands, so the two gestures do not fight.
            onDoubleClick={() => {
              if (entry.isDir) void openInFileManager(childPath).catch(() => {});
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                path: childPath,
                isDir: entry.isDir,
              });
            }}
            title={
              entry.isDir
                ? "클릭: 펼치기 · 더블클릭: 탐색기에서 열기 · 끌어서 터미널에 놓으면 경로 입력"
                : `${entry.name} · 끌어서 터미널에 놓으면 경로 입력`
            }
          >
            <span className="tree-caret">{entry.isDir ? (isOpen ? "▾" : "▸") : ""}</span>
            <span className="tree-name">{entry.name}</span>
          </div>
          {entry.isDir && isOpen && renderLevel(childPath, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="folder-tree">
      <div className="tree-header">
        <span>폴더</span>
        <span className="tree-header-actions">
          <button
            type="button"
            title="탐색기에서 열기"
            onClick={() => void openInFileManager(rootPath).catch(() => {})}
          >
            {/* An open folder, not the grid glyph that used to sit here and read
                as a "switch to grid view" button. */}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                fill="currentColor"
                d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.1l1.2 1.4H12a1.5 1.5 0 0 1 1.5 1.5v.6h-9a1.5 1.5 0 0 0-1.45 1.1L1.5 12Z"
              />
              <path
                fill="currentColor"
                d="M4.55 7.1h10.2l-1.6 5.6a1.5 1.5 0 0 1-1.44 1.1H2.4a1.5 1.5 0 0 0 1.44-1.1Z"
              />
            </svg>
          </button>
          <button type="button" title="새로 읽기" onClick={() => void load(rootPath)}>
            ⟳
          </button>
        </span>
      </div>
      <div className="tree-body">{renderLevel(rootPath, 0)}</div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} entries={menuEntries(menu)} />
      )}
    </div>
  );
}
