/**
 * Full-width text that nobody meant to send to a terminal.
 *
 * The Windows Hangul IME in full-width (전자) mode, and Windows voice typing,
 * produce U+3000 for a space and U+FF01–FF5E for ASCII: "ｗｉｎｄｏｗｓ", "？".
 * D2Coding draws U+3000 as a centred dot, so every space looked like "·", and
 * cmd does not read "ｅｃｈｏ" as a command at all.
 */

const BRACKETED_PASTE_START = "\x1b[200~";
/** U+FF01 '！' minus U+0021 '!': the whole block is ASCII shifted by this much. */
const FULL_WIDTH_OFFSET = 0xfee0;

/** One UTF-16 unit for one, so caret and character counts stay valid. */
export function toHalfWidth(text: string): string {
  return text.replace(/[　！-～]/g, (ch) =>
    ch === "　" ? " " : String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET),
  );
}

/**
 * What a keystroke, an IME commit or dictated text becomes on its way to the PTY.
 * A paste is the user's own text — a full-width folder name has to arrive as it
 * is — so it passes unchanged, whether xterm bracketed it or not.
 */
export function typedForPty(data: string, pasting: boolean): string {
  if (pasting || data.startsWith(BRACKETED_PASTE_START)) return data;
  return toHalfWidth(data);
}
