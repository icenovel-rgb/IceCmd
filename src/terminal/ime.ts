/**
 * Stops the Windows Hangul IME from delivering a syllable twice.
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
 * doubling looked random.
 *
 * `keypress` is the reliable half of that pair, so the fix is to keep it and
 * stop the racing half from ever being queued. xterm consults the custom key
 * handler before it reaches the composition helper, and for keyCode 229 that
 * helper always ends the keydown anyway, so returning false here changes
 * nothing else — including for IMEs that do fire composition events, where the
 * fallback is never reached in the first place.
 */
import type { Terminal } from "@xterm/xterm";

/** Every IME keystroke arrives under this keyCode, whatever key was pressed. */
const IME_KEY_CODE = 229;

export function guardImeInput(term: Terminal): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || event.keyCode !== IME_KEY_CODE) return true;

    // Ending the keydown here also skips the scroll xterm would have done, and
    // typing is exactly when the user wants to be looking at the prompt.
    const buffer = term.buffer.active;
    if (buffer.viewportY !== buffer.baseY) term.scrollToBottom();

    return false;
  });
}
