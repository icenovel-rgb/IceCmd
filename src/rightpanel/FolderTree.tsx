import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FsEntry } from "../types";
import { openInFileManager, openPath, readDir, revealPath, watchDirs } from "../terminal/ipc";
import { beginPathDrag } from "../terminal/pathDrag";
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

/**
 * Windows compares paths case-insensitively, and the watcher can answer with a
 * different case (or a trailing separator) than the tree asked with.
 */
const sameDirKey = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "").toLowerCase();

/**
 * Children are fetched on expand and cached. Folders that are actually on screen
 * are watched, so the list follows the disk without a refresh; nothing else is,
 * and the watch can be turned off entirely in 설정.
 */
export default function FolderTree({ projectId, rootPath }: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openCli = useWorkspace((s) => s.openCli);
  const watchFolders = useWorkspace((s) => s.prefs.watchFolders);

  const load = useCallback(async (path: string) => {
    try {
      const entries = await readDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
      setFailed((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
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
        // Always re-read on the way open. A folder that was collapsed was not
        // being watched, so its cached listing is exactly the one that can be wrong.
        void load(path);
      }
      return next;
    });
  };

  /** The folders whose rows a user can actually see right now. */
  const visible = useMemo(() => [rootPath, ...expanded], [rootPath, expanded]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    void watchDirs(watchFolders ? visible : []).catch(() => {});
  }, [visible, watchFolders]);

  // Only on unmount — leaving the tree must not leave watches running behind it.
  useEffect(() => () => void watchDirs([]).catch(() => {}), []);

  useEffect(() => {
    if (!watchFolders) return;
    const pending = listen<string[]>("fs-changed", (event) => {
      const changed = new Set(event.payload.map(sameDirKey));
      for (const dir of visibleRef.current) {
        if (changed.has(sameDirKey(dir))) void load(dir);
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [watchFolders, load]);

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
            /*
             * Dragging a row onto a terminal types its path there. Pointer
             * events, not HTML5 drag: Tauri owns the webview's drag pipeline on
             * Windows and `dragstart` never fires. The click that expands a
             * folder is the same gesture, so it is handed to the same helper —
             * whichever it turns out to be is decided on release.
             */
            onPointerDown={(event) =>
              beginPathDrag(event, {
                path: childPath,
                label: entry.name,
                onTap: () => {
                  if (entry.isDir) toggle(childPath);
                },
              })
            }
            /*
             * Double-click opens a file, and only a file.
             *
             * A folder used to open in Explorer on double-click, on top of the
             * single click that expands it — so the gesture that browses the
             * tree and the gesture that throws a window onto the screen were the
             * same gesture, told apart by how fast it was done. Two quick clicks
             * down the tree opened Explorer nobody asked for. Opening a folder is
             * now on the right-click menu, where it has to be meant. A file has
             * no expand to collide with, so it keeps the fast way in.
             */
            onDoubleClick={() => {
              if (!entry.isDir) void openPath(childPath).catch(() => {});
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
                ? "클릭: 펼치기 · 우클릭: 탐색기에서 열기 · 끌어서 터미널에 놓으면 경로 입력"
                : `${entry.name} · 더블클릭: 열기 · 끌어서 터미널에 놓으면 경로 입력`
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
          <button
            type="button"
            title={watchFolders ? "새로 읽기 (바뀌면 저절로 갱신됩니다)" : "새로 읽기"}
            onClick={() => {
              for (const dir of visible) void load(dir);
            }}
          >
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
