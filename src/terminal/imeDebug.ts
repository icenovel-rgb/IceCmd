/**
 * Diagnostics for the "Hangul arrives twice" report.
 *
 * Loaded only when VITE_ICECMD_IME_DEBUG is set, so a normal build never pays
 * for it. Everything is logged through `log_line`, which prints to the
 * `tauri dev` console — the UI cannot be read while an IME is being driven by
 * hand, and the console can.
 *
 * What the log has to settle: whether one keystroke produces one `onData` or
 * two. If two, the duplication is on our side of the PTY; if one, the shell or
 * the renderer is repeating it.
 */
import type { Terminal } from "@xterm/xterm";
import { logLine } from "./ipc";

const DOM_EVENTS = [
  "keydown",
  "keypress",
  "keyup",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
  "input",
] as const;

/** Trailing digits are enough to tell panes apart in a log line. */
const shortId = (paneId: string) => paneId.slice(-4);

export function watchIme(paneId: string, term: Terminal): () => void {
  const area = term.textarea;
  if (!area) return () => {};

  const tag = shortId(paneId);
  const started = performance.now();
  const at = () => (performance.now() - started).toFixed(0).padStart(5);

  const say = (what: string) => void logLine(`ime ${tag} +${at()}ms ${what}`);

  const describe = (event: Event): string => {
    if (event instanceof KeyboardEvent) {
      return `${event.type} key=${JSON.stringify(event.key)} code=${event.keyCode}`;
    }
    if (event instanceof CompositionEvent) {
      return `${event.type} data=${JSON.stringify(event.data)}`;
    }
    if (event instanceof InputEvent) {
      return `${event.type} type=${event.inputType} data=${JSON.stringify(event.data)} composed=${event.composed}`;
    }
    return event.type;
  };

  // Registered on the textarea itself, where xterm.js also listens. Listeners on
  // the same target run in registration order and xterm only ever calls
  // stopPropagation, so these still fire after its own handling.
  const listeners = DOM_EVENTS.map((name) => {
    const handler = (event: Event) => {
      say(`${describe(event)} · textarea=${JSON.stringify(area.value)}`);
    };
    area.addEventListener(name, handler);
    return () => area.removeEventListener(name, handler);
  });

  /**
   * Which xterm.js function asked for the send. The bundle is one long line per
   * chunk, so the useful part is the line:column pair — it maps back to the
   * original source through xterm.mjs.map.
   */
  const origin = (): string => {
    const frames = (new Error().stack ?? "").split("\n").slice(1);
    const named = frames.filter(
      (frame) =>
        !frame.includes("imeDebug") &&
        // The event emitter sits between every caller and this listener.
        !/_deliver|_deliverQueue|\.fire |onData|triggerDataEvent/.test(frame),
    );
    return named
      .slice(0, 3)
      .map((frame) => frame.trim().replace(/^at /, "").replace(/ \(http.*?deps\//, " @"))
      .join(" | ");
  };

  // The line that matters: one per keystroke means the input path is fine.
  const onData = term.onData((data) => say(`>>> onData ${JSON.stringify(data)} @ ${origin()}`));

  say("watching");

  return () => {
    for (const off of listeners) off();
    onData.dispose();
  };
}
