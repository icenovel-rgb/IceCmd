import type { PointerEvent as ReactPointerEvent } from "react";
import type { PaneStatus, Project } from "../types";
import StatusDot from "./StatusDot";

interface Props {
  project: Project;
  status: PaneStatus;
  active: boolean;
  paneCount: number;
  /** This row is the one being dragged. */
  dragging: boolean;
  /** Which side of this row the dragged project would land on, if any. */
  insert: "before" | "after" | null;
  onSelect: () => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}

export default function ProjectItem({
  project,
  status,
  active,
  paneCount,
  dragging,
  insert,
  onSelect,
  onPointerDown,
  onContextMenu,
}: Props) {
  return (
    <button
      type="button"
      className={
        `project-item${active ? " project-active" : ""}` +
        `${dragging ? " reorder-source" : ""}${insert ? ` reorder-${insert}` : ""}`
      }
      // Kept alongside the pointer handling so the keyboard can still choose a
      // project; the sidebar ignores the click that follows a real drag.
      onClick={onSelect}
      onPointerDown={onPointerDown}
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
