/**
 * Copies what a mouse drag selects the moment the button comes up.
 *
 * Ctrl+C in a pane belongs to the program running there, and in codex it quits,
 * so "select, then Ctrl+C" was a way to lose the session. claude already copies
 * its own selection as soon as a drag ends; this gives every other pane the same.
 * The copy shortcut and the context menu still copy as they always did.
 *
 * What decides it is whether xterm's own selection took the press — not whether
 * the selection *changed*. xterm stays quiet when a new selection equals the one
 * it last reported, even if that one has since been cleared, so dragging the
 * same text a second time would have copied nothing.
 */
import type { Terminal } from "@xterm/xterm";
import { copyText } from "./clipboard";
import { isMac } from "../platform";

/**
 * Mirrors xterm's own rule. A program that asked for mouse reporting — claude
 * does — gets the press instead, and copies its own selection; an older xterm
 * selection still on screen must not overwrite that copy. Holding the force
 * modifier hands the press back to xterm.
 */
function xtermSelects(term: Terminal, event: MouseEvent): boolean {
  if (term.modes.mouseTrackingMode === "none") return true;
  return isMac
    ? event.altKey && Boolean(term.options.macOptionClickForcesSelection)
    : event.shiftKey;
}

export function copyOnSelect(term: Terminal, host: HTMLElement): () => void {
  let selecting = false;

  // Capture phase: xterm stops the event when it forces a selection past a TUI.
  const onDown = (event: MouseEvent) => {
    if (event.button === 0) selecting = xtermSelects(term, event);
  };

  // On the window: a drag may end anywhere, and xterm follows it on the document,
  // whose listeners have finished by the time the event bubbles up to here.
  const onUp = (event: MouseEvent) => {
    if (!selecting || event.button !== 0) return;
    selecting = false;
    if (term.hasSelection()) void copyText(term.getSelection());
  };

  host.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp);

  return () => {
    host.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp);
  };
}
