import { useWorkspace } from "../store/workspace";

interface Props {
  projectId: string;
}

/**
 * Each click adds a pane: the roomiest existing pane is halved along its longer
 * edge and the CLI starts there, in the project's folder.
 */
export default function CliButtons({ projectId }: Props) {
  const openCli = useWorkspace((s) => s.openCli);

  return (
    <div className="cli-buttons">
      <button type="button" className="cli-claude" onClick={() => openCli(projectId, "claude")}>
        claude
      </button>
      <button type="button" className="cli-codex" title="전체 접근으로 실행 (샌드박스 제한·승인 요청 해제)" onClick={() => openCli(projectId, "codex")}>
        codex
      </button>
      <button type="button" className="cli-shell" onClick={() => openCli(projectId, "shell")}>
        cmd
      </button>
    </div>
  );
}
