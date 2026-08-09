import { useRef } from "react";

interface Props {
  /** "left" edge belongs to the right panel; "right" edge belongs to the sidebar. */
  side: "left" | "right";
  /** Turns a pointer position into the new width of the panel being resized. */
  widthFrom: (clientX: number) => number;
  onWidth: (width: number) => void;
  onReset: () => void;
}

/**
 * Vertical drag strip for the side panels. Pointer events only, matching the pane
 * dividers — Tauri's native file drop makes HTML5 drag unusable here.
 */
export default function ResizeHandle({ side, widthFrom, onWidth, onReset }: Props) {
  const dragging = useRef(false);

  return (
    <div
      className={`panel-resize panel-resize-${side}`}
      title="드래그: 너비 조정 · 더블클릭: 기본값"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current) onWidth(widthFrom(event.clientX));
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
