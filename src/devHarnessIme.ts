/**
 * Harness checks for how IME text reaches the PTY. Dev-only: loaded with the
 * harness, never part of a normal build.
 *
 * Every case counts what the terminal *sends* and expects exactly one copy. Zero
 * is a swallowed keystroke; two is the doubled syllable fixed in 0.5.0. The check
 * this replaces asserted "nothing was sent" for an IME keystroke that arrives
 * without a keypress — which is the swallowing itself — and it passed.
 */
import { writeSession } from "./terminal/ipc";
import type { TermEntry } from "./terminal/termRegistry";

type Check = (name: string, ok: boolean, detail?: string) => void;

const SYLLABLE = "가";
/** Every IME keystroke arrives under this keyCode, whatever key was pressed. */
const IME_KEY_CODE = 229;
/** Longer than any setTimeout(0) xterm.js or the guard leave behind. */
const SETTLE_MS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkImeDelivery(entry: TermEntry, check: Check): Promise<void> {
  const area = entry.term.textarea;
  check("the terminal exposes the textarea the IME writes into", Boolean(area));
  if (!area) return;

  // The legacy key fields are what xterm.js reads, and a constructed event will
  // not take them, so they are laid over the instance.
  const fire = (event: Event, legacy: Record<string, number> = {}) => {
    for (const [field, value] of Object.entries(legacy)) {
      Object.defineProperty(event, field, { get: () => value });
    }
    area.dispatchEvent(event);
  };
  const key = (type: string, legacy: Record<string, number> = {}) =>
    fire(new KeyboardEvent(type, { bubbles: true, cancelable: true }), legacy);
  const imeKeyDown = () => key("keydown", { keyCode: IME_KEY_CODE });
  const keyUp = () => key("keyup");
  const keypress = (text: string) => {
    const code = text.charCodeAt(0);
    key("keypress", { charCode: code, keyCode: code, which: code });
  };
  // An input event from real typing is `composed`, and xterm.js waves through
  // any that is not, so the real kind is the one imitated here.
  const input = (inputType: string, data: string) => {
    area.value += data;
    fire(new InputEvent("input", { bubbles: true, cancelable: true, composed: true, inputType, data }));
  };
  const composition = (type: string, data: string) =>
    fire(new CompositionEvent(type, { bubbles: true, data }));

  const restore = area.value;
  let landed = 0;
  const sentDuring = async (act: () => void): Promise<string> => {
    let sent = "";
    const tap = entry.term.onData((data) => {
      sent += data;
    });
    area.value = "";
    act();
    await sleep(SETTLE_MS);
    keyUp();
    tap.dispose();
    landed += sent.length;
    return sent;
  };
  const report = (name: string, sent: string, expected = SYLLABLE) =>
    check(name, sent === expected, `sent=${JSON.stringify(sent)}`);

  /*
   * The race fixed in 0.5.0: xterm.js answers an IME keydown by diffing the
   * textarea a tick later, and that diff fires a second copy when it loses to
   * the IME's own input event. It must never be queued.
   */
  const diffed = await sentDuring(() => {
    imeKeyDown();
    area.value = SYLLABLE;
  });
  check("an IME keystroke queues no textarea-diff send", diffed === "", `sent=${JSON.stringify(diffed)}`);

  // Measured on WebView2: keydown 229, keypress, then input — the keypress sends.
  report(
    "a syllable the IME also delivers as a keypress goes out once",
    await sentDuring(() => {
      imeKeyDown();
      keypress(SYLLABLE);
      input("insertText", SYLLABLE);
    }),
  );

  // The swallowed case: the text comes as input alone while the key is down.
  report(
    "a syllable the IME commits with no keypress still goes out, once",
    await sentDuring(() => {
      imeKeyDown();
      input("insertText", SYLLABLE);
    }),
  );

  // Once the key is up xterm.js sends the input itself; the guard must not echo it.
  report(
    "text that lands after the key is released goes out once",
    await sentDuring(() => {
      imeKeyDown();
      keyUp();
      input("insertText", SYLLABLE);
    }),
  );

  // The everyday Hangul path, which xterm.js sends when the composition ends.
  report(
    "a composed syllable goes out once",
    await sentDuring(() => {
      imeKeyDown();
      composition("compositionstart", "");
      composition("compositionupdate", SYLLABLE);
      input("insertCompositionText", SYLLABLE);
      composition("compositionend", SYLLABLE);
    }),
  );

  /*
   * Text that lands while xterm's send for a finished composition is still
   * queued: that send reads the whole textarea, so it carries the "." as well.
   * Delivering it here too would put a stray "." ahead of the syllable.
   */
  report(
    "text right after a composition rides with it, once",
    await sentDuring(() => {
      imeKeyDown();
      composition("compositionstart", "");
      composition("compositionupdate", SYLLABLE);
      input("insertCompositionText", SYLLABLE);
      composition("compositionend", SYLLABLE);
      imeKeyDown();
      input("insertText", ".");
    }),
    `${SYLLABLE}.`,
  );

  // Inside a composition the composition's own send carries the text.
  report(
    "plain text inside a composition goes out once",
    await sentDuring(() => {
      imeKeyDown();
      composition("compositionstart", "");
      input("insertText", SYLLABLE);
      composition("compositionend", SYLLABLE);
    }),
  );

  // Two commits under one held key: both are this guard's to deliver.
  report(
    "two commits under one key both go out",
    await sentDuring(() => {
      imeKeyDown();
      input("insertText", SYLLABLE);
      input("insertText", "나");
    }),
    `${SYLLABLE}나`,
  );

  area.value = restore;
  // Every copy that went out was typed onto the shell's command line.
  if (landed > 0) await writeSession(entry.paneId, "\x7f".repeat(landed));
}
