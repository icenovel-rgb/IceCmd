import { useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";
import { openExternal } from "../terminal/ipc";
import CliButtons from "./CliButtons";
import FolderTree from "./FolderTree";
import SettingsModal from "./SettingsModal";
import SupportModal from "./SupportModal";

const SITE_URL = "https://icenovel.com";

export default function RightPanel() {
  const activeProjectId = useWorkspace((s) => s.activeProjectId);
  const project = useWorkspace((s) =>
    s.projects.find((candidate) => candidate.id === s.activeProjectId),
  );
  const [supporting, setSupporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!supporting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSupporting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [supporting]);

  return (
    <aside className="right-panel">
      {activeProjectId && project ? (
        <>
          <CliButtons projectId={activeProjectId} />
          {/* Remounting on project change drops the cached listings, which is what we
              want — they are re-read from disk. Which rows are open lives in the
              store and survives this, so the tree comes back as it was left. */}
          <FolderTree key={project.path} projectId={activeProjectId} rootPath={project.path} />
        </>
      ) : (
        <p className="right-panel-empty">프로젝트를 추가하세요</p>
      )}

      <div className="panel-footer">
        {/* The sliders moved into 설정: they are set once, and the tree needs the room. */}
        <button type="button" className="settings-open" onClick={() => setSettingsOpen(true)}>
          ⚙ 설정
        </button>
        <button
          type="button"
          className="site-link"
          onClick={() => {
            void openExternal(SITE_URL).catch(() => {});
          }}
        >
          icenovel.com 방문하기
        </button>
        <button type="button" className="support-open" onClick={() => setSupporting(true)}>
          ☕ 후원하기
        </button>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {supporting && <SupportModal onClose={() => setSupporting(false)} />}
    </aside>
  );
}
