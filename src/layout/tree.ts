/**
 * Pure split-tree operations, tmux style. A pane is a leaf; splitting replaces a
 * leaf with a split node holding the old leaf and a new one.
 */
import type { PaneNode, SplitDir } from "../types";

export const leaf = (paneId: string): PaneNode => ({ type: "leaf", paneId });

/** Replaces `targetId` with a split; the new pane takes the second slot. */
export function splitPane(
  node: PaneNode,
  targetId: string,
  dir: SplitDir,
  newPaneId: string,
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId !== targetId) return node;
    return { type: "split", dir, ratio: 0.5, a: node, b: leaf(newPaneId) };
  }
  const a = splitPane(node.a, targetId, dir, newPaneId);
  const b = a === node.a ? splitPane(node.b, targetId, dir, newPaneId) : node.b;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** Removes a pane; its sibling takes over the space. Returns null if nothing is left. */
export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") return node.paneId === paneId ? null : node;
  const a = removePane(node.a, paneId);
  if (a === null) return node.b;
  const b = removePane(node.b, paneId);
  if (b === null) return node.a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** Inserts a new leaf next to `targetId`, on the given side. */
function insertBeside(
  node: PaneNode,
  targetId: string,
  dir: SplitDir,
  newPaneId: string,
  newFirst: boolean,
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId !== targetId) return node;
    const fresh = leaf(newPaneId);
    return newFirst
      ? { type: "split", dir, ratio: 0.5, a: fresh, b: node }
      : { type: "split", dir, ratio: 0.5, a: node, b: fresh };
  }
  const a = insertBeside(node.a, targetId, dir, newPaneId, newFirst);
  if (a !== node.a) return { ...node, a };
  const b = insertBeside(node.b, targetId, dir, newPaneId, newFirst);
  if (b !== node.b) return { ...node, b };
  return node;
}

export type DropEdge = "left" | "right" | "top" | "bottom";

/**
 * Drops `sourceId` against the given edge of `targetId`. This is how a left/right
 * split becomes a top/bottom one: drag either pane onto the other's top or bottom.
 */
export function movePane(
  root: PaneNode,
  sourceId: string,
  targetId: string,
  edge: DropEdge,
): PaneNode {
  if (sourceId === targetId) return root;
  const without = removePane(root, sourceId);
  // Removing the source must not have taken the target with it.
  if (!without || !hasPane(without, targetId)) return root;
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "col";
  const sourceFirst = edge === "left" || edge === "top";
  return insertBeside(without, targetId, dir, sourceId, sourceFirst);
}

/** Turns a left/right split into a top/bottom one, or back. */
export function flipSplit(node: PaneNode, path: string): PaneNode {
  if (node.type === "leaf") return node;
  if (path === "") return { ...node, dir: node.dir === "row" ? "col" : "row" };
  const [head, ...rest] = path.split(".");
  const restPath = rest.join(".");
  if (head === "a") {
    const a = flipSplit(node.a, restPath);
    return a === node.a ? node : { ...node, a };
  }
  const b = flipSplit(node.b, restPath);
  return b === node.b ? node : { ...node, b };
}

export function paneIds(node: PaneNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.paneId];
  return [...paneIds(node.a), ...paneIds(node.b)];
}

export function hasPane(node: PaneNode | null, paneId: string): boolean {
  return paneIds(node).includes(paneId);
}

/** Adjusts one split's ratio, addressed by the path taken to reach it. */
export function setRatio(node: PaneNode, path: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node;
  if (path === "") return { ...node, ratio: clamp(ratio) };
  const [head, ...rest] = path.split(".");
  const restPath = rest.join(".");
  if (head === "a") {
    const a = setRatio(node.a, restPath, ratio);
    return a === node.a ? node : { ...node, a };
  }
  const b = setRatio(node.b, restPath, ratio);
  return b === node.b ? node : { ...node, b };
}

const clamp = (ratio: number) => Math.min(0.85, Math.max(0.15, ratio));

/**
 * Picks the pane a new CLI should displace: the one occupying the most area.
 * Ratios are relative, so area is the product of the ratios along its path.
 */
export function largestPane(
  node: PaneNode | null,
): { paneId: string; dir: SplitDir } | null {
  if (!node) return null;
  let best: { paneId: string; weight: number; width: number; height: number } | null = null;

  const walk = (current: PaneNode, width: number, height: number) => {
    if (current.type === "leaf") {
      const weight = width * height;
      if (!best || weight > best.weight) {
        best = { paneId: current.paneId, weight, width, height };
      }
      return;
    }
    if (current.dir === "row") {
      walk(current.a, width * current.ratio, height);
      walk(current.b, width * (1 - current.ratio), height);
    } else {
      walk(current.a, width, height * current.ratio);
      walk(current.b, width, height * (1 - current.ratio));
    }
  };
  walk(node, 1, 1);

  if (!best) return null;
  const winner = best as { paneId: string; width: number; height: number };
  // Split across the longer edge so both halves stay usable.
  return { paneId: winner.paneId, dir: winner.width >= winner.height ? "row" : "col" };
}
