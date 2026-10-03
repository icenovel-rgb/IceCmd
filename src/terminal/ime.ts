/**
 * Makes Windows Hangul IME text reach the shell exactly once.
 *
 * Measured on WebView2 (see `imeDebug.ts`, which produced the trace below). This
 * IME sometimes commits a syllable without ever firing composition events:
 *
 *   +14049  keydown keyCode=229      xterm queues its textarea-diff fallback
 *   +14050  keypress                 xterm sends "안"                     ①
 *   +14051  input insertText "안"    textarea goes from "" to "안"
 *   +14056  the queued fallback runs diff is "안", so it sends it again    ②
 *
 * The fallback exists so that non-composition characters typed while an IME is
 * active still reach the shell, and it decides what to send by diffing the
 * textarea on a `setTimeout(0)`. That timer races the IME's own `input` event:
 * fire first and the diff is empty, fire second and the syllable is sent twice.
 * The same trace shows both outcomes one keystroke apart — which is why the
 * doubling looked random. So the fallback is never queued: xterm consults the
 * custom key handler before its composition helper, and for keyCode 229 that
 * helper ends the keydown anyway, so returning false changes nothing else.
 *
 * Doing only that (0.5.0 – 0.6.5) left a hole. The fallback was also the one
 * route for text that arrives as an `input` event with no keypress in front of
 * it: xterm's own input handler ignores a composed event while a key is down,
 * so such text went nowhere — a keystroke silently swallowed. That case is
 * delivered here instead, and only when neither a keypress nor xterm will.
 */
import type { Terminal } from "@xterm/xterm";

/** Every IME keystroke arrives under this keyCode, whatever key was pressed. */
const IME_KEY_CODE = 229;

/** Call after `term.open()`: the textarea the IME writes into is created there. */
export function guardImeInput(term: Terminal): void {
  const area = term.textarea;
  if (!area) throw new Error("guardImeInput needs a terminal that has been opened");

  // Mirrors xterm's own flag of the same meaning, which is set and cleared just
  // before this handler is consulted on every keydown and keyup.
  let keyHeld = false;
  // An IME keydown whose text has not yet gone out through a keypress.
  let imeKeyOpen = false;
  let inComposition = false;
  // Compositions that have ended but whose text xterm has not sent yet.
  let compositionsSending = 0;

  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keyup") keyHeld = false;
    // xterm sends a keypress itself; an input event behind it is the same text.
    if (event.type === "keypress") imeKeyOpen = false;
    if (event.type !== "keydown") return true;

    keyHeld = true;
    imeKeyOpen = event.keyCode === IME_KEY_CODE;
    if (!imeKeyOpen) return true;

    // Ending the keydown here also skips the scroll xterm would have done, and
    // typing is exactly when the user wants to be looking at the prompt.
    const buffer = term.buffer.active;
    if (buffer.viewportY !== buffer.baseY) term.scrollToBottom();
    return false;
  });

  area.addEventListener("compositionstart", () => {
    inComposition = true;
  });
  area.addEventListener("compositionend", () => {
    inComposition = false;
    // xterm sends a finished composition from a setTimeout(0) queued by its own
    // listener, which was added in open() and so ran before this one. Text that
    // lands until that timer fires is picked up by that same send. (Input that
    // lands *between* the two timers would be missed by both; that takes a new
    // IME keystroke inside one turn of the timer queue, and was never seen.)
    compositionsSending += 1;
    window.setTimeout(() => {
      compositionsSending -= 1;
    }, 0);
  });
  area.addEventListener("input", (event) => {
    if (!(event instanceof InputEvent) || event.inputType !== "insertText" || !event.data) return;
    if (!imeKeyOpen || inComposition || compositionsSending > 0) return;
    // xterm delivers the event itself once no key is down, or when it is not composed.
    if (!keyHeld || !event.composed) return;
    // Left open: an IME that commits twice under one key sends both, and nothing
    // else can deliver either while the key is down.
    term.input(event.data);
  });
}
