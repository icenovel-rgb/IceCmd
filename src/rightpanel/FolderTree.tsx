import { useCallback, useEffect, useState } from "react";
import type { FsEntry } from "../types";
import { openInFileManager, readDir } from "../terminal/ipc";

interface Props {
  rootPath: string;
}

/** Children are fetched on expand and cached; nothing is watched, so idle cost is zero. */
export default function FolderTree({ rootPath }: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());

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
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => entry.isDir && toggle(childPath)}
            // A folder row opens in Explorer on double-click; single click still
            // expands, so the two gestures do not fight.
            onDoubleClick={() => {
              if (entry.isDir) void openInFileManager(childPath).catch(() => {});
            }}
            title={entry.isDir ? "클릭: 펼치기 · 더블클릭: 탐색기에서 열기" : entry.name}
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
            ⊞
          </button>
          <button type="button" title="새로 읽기" onClick={() => void load(rootPath)}>
            ⟳
          </button>
        </span>
      </div>
      <div className="tree-body">{renderLevel(rootPath, 0)}</div>
    </div>
  );
}
