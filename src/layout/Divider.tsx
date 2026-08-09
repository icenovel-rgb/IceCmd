import { useRef } from "react";
import type { DividerRect } from "./geometry";

interface Props {
  rect: DividerRect;
  /** The stage the percentages are relative to. */
  stageRef: React.RefObject<HTMLDivElement | null>;
  onRatio: (ratio: number) => void;
  /** Double-click swaps the split between left/right and top/bottom. */
  onFlip: () => void;
}

/**
 * Pointer events only — no HTML5 drag. Tauri's native file drop intercepts HTML5
 * drag events for OS files, so anything built on them stops working.
 */
export default function Divider({ rect, stageRef, onRatio, onFlip }: Props) {
  const dragging = useRef(false);

  const measure = (event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;

    const horizontal = rect.dir === "row";
    const positionPct = horizontal
      ? ((event.clientX - stage.left) / stage.width) * 100
      : ((event.clientY - stage.top) / stage.height) * 100;
    const origin = horizontal ? rect.bounds.left : rect.bounds.top;
    const extent = horizontal ? rect.bounds.width : rect.bounds.height;
    if (extent <= 0) return;

    const ratio = (positionPct - origin) / extent;
    if (Number.isFinite(ratio)) onRatio(ratio);
  };

  // A 4px strip straddling the boundary; the 2px overlap onto each pane is
  // invisible in practice and keeps the pane rectangles exact.
  const style: React.CSSProperties =
    rect.dir === "row"
      ? {
          left: `calc(${rect.left}% - 2px)`,
          top: `${rect.top}%`,
          width: "4px",
          height: `${rect.span}%`,
        }
      : {
          left: `${rect.left}%`,
          top: `calc(${rect.top}% - 2px)`,
          width: `${rect.span}%`,
          height: "4px",
        };

  return (
    <div
      className={`divider divider-${rect.dir}`}
      style={style}
      title="드래그: 크기 조정 · 더블클릭: 좌우↔상하 전환"
      onDoubleClick={onFlip}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current) measure(event);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    />
  );
}
