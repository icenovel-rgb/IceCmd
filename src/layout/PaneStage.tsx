import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaneNode } from "../types";
import type { DropEdge } from "./tree";
import { useWorkspace } from "../store/workspace";
import { computeLayout, type PaneRect } from "./geometry";
import Divider from "./Divider";
import PaneFrame from "./PaneFrame";

interface Props {
  projectId: string;
  layout: PaneNode;
  active: boolean;
}

interface DragState {
  sourceId: string;
  targetId: string | null;
  edge: DropEdge | null;
}

/** Which edge of the pane under the pointer is nearest, in the stage's own units. */
function hitTest(
  rects: PaneRect[],
  xPct: number,
  yPct: number,
): { paneId: string; edge: DropEdge } | null {
  const hit = rects.find(
    (rect) =>
      xPct >= rect.left &&
      xPct <= rect.left + rect.width &&
      yPct >= rect.top &&
      yPct <= rect.top + rect.height,
  );
  if (!hit || hit.width <= 0 || hit.height <= 0) return null;

  const fromLeft = (xPct - hit.left) / hit.width;
  const fromTop = (yPct - hit.top) / hit.height;
  const distances: { edge: DropEdge; distance: number }[] = [
    { edge: "left", distance: fromLeft },
    { edge: "right", distance: 1 - fromLeft },
    { edge: "top", distance: fromTop },
    { edge: "bottom", distance: 1 - fromTop },
  ];
  // Nearest edge always wins: no dead centre to fight with.
  distances.sort((a, b) => a.distance - b.distance);
  return { paneId: hit.paneId, edge: distances[0].edge };
}

/** Where the drop preview is drawn: half of the target, against the chosen edge. */
function previewStyle(rect: PaneRect, edge: DropEdge): React.CSSProperties {
  const half = { width: rect.width / 2, height: rect.height / 2 };
  if (edge === "left") {
    return { left: `${rect.left}%`, top: `${rect.top}%`, width: `${half.width}%`, height: `${rect.height}%` };
  }
  if (edge === "right") {
    return {
      left: `${rect.left + half.width}%`,
      top: `${rect.top}%`,
      width: `${half.width}%`,
      height: `${rect.height}%`,
    };
  }
  if (edge === "top") {
    return { left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${half.height}%` };
  }
  return {
    left: `${rect.left}%`,
    top: `${rect.top + half.height}%`,
    width: `${rect.width}%`,
    height: `${half.height}%`,
  };
}

export default function PaneStage({ projectId, layout, active }: Props) {
  const panes = useWorkspace((s) => s.panes);
  const adjustRatio = useWorkspace((s) => s.adjustRatio);
  const flipSplitAt = useWorkspace((s) => s.flipSplitAt);
  const movePaneTo = useWorkspace((s) => s.movePaneTo);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const geometry = useMemo(() => computeLayout(layout), [layout]);
  // Read inside window listeners without re-subscribing on every layout change.
  const rectsRef = useRef(geometry.panes);
  rectsRef.current = geometry.panes;

  const beginDrag = useCallback((paneId: string) => {
    setDrag({ sourceId: paneId, targetId: null, edge: null });
  }, []);

  useEffect(() => {
    if (!drag) return;

    const locate = (event: PointerEvent) => {
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage || stage.width <= 0 || stage.height <= 0) return null;
      return hitTest(
        rectsRef.current,
        ((event.clientX - stage.left) / stage.width) * 100,
        ((event.clientY - stage.top) / stage.height) * 100,
      );
    };

    const onMove = (event: PointerEvent) => {
      const found = locate(event);
      setDrag((current) => {
        if (!current) return current;
        const targetId = found && found.paneId !== current.sourceId ? found.paneId : null;
        const edge = targetId ? found!.edge : null;
        if (current.targetId === targetId && current.edge === edge) return current;
        return { ...current, targetId, edge };
      });
    };

    const onUp = (event: PointerEvent) => {
      const found = locate(event);
      setDrag((current) => {
        if (current && found && found.paneId !== current.sourceId) {
          movePaneTo(projectId, current.sourceId, found.paneId, found.edge);
        }
        return null;
      });
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag, movePaneTo, projectId]);

  const previewRect =
    drag?.targetId && drag.edge
      ? geometry.panes.find((rect) => rect.paneId === drag.targetId)
      : undefined;

  return (
    <div ref={stageRef} className={`pane-stage${drag ? " pane-stage-dragging" : ""}`}>
      {geometry.panes.map((rect) => {
        const meta = panes[rect.paneId];
        if (!meta) return null;
        return (
          <div
            key={rect.paneId}
            className={`pane-slot${drag?.sourceId === rect.paneId ? " pane-slot-source" : ""}`}
            // Lets a check address one particular pane on screen.
            data-pane={rect.paneId}
            style={{
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
            }}
          >
            <PaneFrame meta={meta} active={active} onDragStart={beginDrag} />
          </div>
        );
      })}

      {geometry.dividers.map((rect) => (
        <Divider
          key={`${rect.dir}:${rect.path}`}
          rect={rect}
          stageRef={stageRef}
          onRatio={(ratio) => adjustRatio(projectId, rect.path, ratio)}
          onFlip={() => flipSplitAt(projectId, rect.path)}
        />
      ))}

      {previewRect && drag?.edge && (
        <div className="drop-preview" style={previewStyle(previewRect, drag.edge)} />
      )}
    </div>
  );
}
