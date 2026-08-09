/**
 * Turns a split tree into flat rectangles.
 *
 * The panes must not be nested in the DOM the way they are nested in the tree:
 * splitting or closing a pane changes the shape of that nesting, and React then
 * unmounts and remounts the surviving panes — which would kill and restart their
 * shells. Rendering every pane as an absolutely positioned sibling keeps each
 * one's identity fixed, so a layout change only rewrites styles.
 *
 * All values are percentages of the stage.
 */
import type { PaneNode, SplitDir } from "../types";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneRect extends Rect {
  paneId: string;
}

export interface DividerRect {
  /** Path to the split node this divider resizes; "" is the root. */
  path: string;
  dir: SplitDir;
  /** Position of the boundary line itself. */
  left: number;
  top: number;
  /** Extent along the boundary. */
  span: number;
  /** Rectangle the split occupies, needed to convert a pointer position to a ratio. */
  bounds: Rect;
}

const STAGE: Rect = { left: 0, top: 0, width: 100, height: 100 };

export function computeLayout(root: PaneNode): {
  panes: PaneRect[];
  dividers: DividerRect[];
} {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];

  const descend = (path: string, branch: "a" | "b") =>
    path === "" ? branch : `${path}.${branch}`;

  const walk = (node: PaneNode, path: string, rect: Rect): void => {
    if (node.type === "leaf") {
      panes.push({ paneId: node.paneId, ...rect });
      return;
    }
    if (node.dir === "row") {
      const firstWidth = rect.width * node.ratio;
      walk(node.a, descend(path, "a"), { ...rect, width: firstWidth });
      walk(node.b, descend(path, "b"), {
        ...rect,
        left: rect.left + firstWidth,
        width: rect.width - firstWidth,
      });
      dividers.push({
        path,
        dir: "row",
        left: rect.left + firstWidth,
        top: rect.top,
        span: rect.height,
        bounds: rect,
      });
    } else {
      const firstHeight = rect.height * node.ratio;
      walk(node.a, descend(path, "a"), { ...rect, height: firstHeight });
      walk(node.b, descend(path, "b"), {
        ...rect,
        top: rect.top + firstHeight,
        height: rect.height - firstHeight,
      });
      dividers.push({
        path,
        dir: "col",
        left: rect.left,
        top: rect.top + firstHeight,
        span: rect.width,
        bounds: rect,
      });
    }
  };

  walk(root, "", STAGE);
  // Stable DOM order, so React never reorders pane elements either.
  panes.sort((a, b) => (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
  return { panes, dividers };
}
