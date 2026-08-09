import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MenuEntry {
  label: string;
  onSelect: () => void;
  /** Destructive items get their own colour so muscle memory cannot hit them. */
  danger?: boolean;
}

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

/**
 * The one context menu in the app.
 *
 * It exists as a shared component because two of the details below are
 * load-bearing and each was a real bug. A second hand-rolled menu would
 * reproduce them:
 *
 * 1. The dismiss listener ignores presses that *start inside* the menu.
 *    Dismissing on every `pointerdown` unmounts the buttons before the release,
 *    and `click` only fires when press and release land on the same element — so
 *    every item in the sidebar menu was dead from 0.1.0 through 0.3.0.
 * 2. It renders on `<body>`. The app chrome carries a CSS `zoom`, and a fixed
 *    element inside a zoomed ancestor has its coordinates scaled too, which puts
 *    the menu somewhere other than under the pointer.
 */
export default function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    // Deliberately not `{once: true}`: an ignored press would consume the
    // listener and leave the menu with no way to close.
    window.addEventListener("pointerdown", dismiss);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Nudged back inside the window once its real size is known. The folder tree
  // lives against the right edge, so its menus open past it by default.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
  }, [x, y, entries.length]);

  return createPortal(
    <div ref={ref} className="context-menu" style={{ left: x, top: y }}>
      {entries.map((entry) => (
        <button
          key={entry.label}
          type="button"
          className={entry.danger ? "context-danger" : undefined}
          onClick={() => {
            entry.onSelect();
            onClose();
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
