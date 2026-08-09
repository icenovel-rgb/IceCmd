import type { PaneStatus, Project } from "../types";
import StatusDot from "./StatusDot";

interface Props {
  project: Project;
  status: PaneStatus;
  active: boolean;
  paneCount: number;
  onSelect: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}

export default function ProjectItem({
  project,
  status,
  active,
  paneCount,
  onSelect,
  onContextMenu,
}: Props) {
  return (
    <button
      type="button"
      className={`project-item${active ? " project-active" : ""}`}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu({ x: event.clientX, y: event.clientY });
      }}
      title={project.path}
    >
      <StatusDot status={status} />
      <span className="project-name">{project.name}</span>
      {paneCount > 1 && <span className="project-panes">{paneCount}</span>}
    </button>
  );
}
