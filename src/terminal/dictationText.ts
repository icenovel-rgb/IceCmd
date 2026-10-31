/**
 * cmd executes embedded line breaks even without a final Enter. A reviewed
 * transcript is inserted as one line, with no terminal control characters.
 */
export function dictationTextForTerminal(text: string): string {
  return text
    .replace(/\r\n|[\r\n\t\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

/** Send one reviewed message in one IPC write, with Enter after the paste. */
export function composerInputForTerminal(
  text: string,
  bracketedPaste: boolean,
  submit = true,
): string {
  const clean = text
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  if (!clean.trim()) return "";
  // Matches xterm's paste encoding. CLI editors receive a single pasted block;
  // cmd gets one line so embedded line breaks cannot run separate commands.
  const payload = bracketedPaste
    ? `\x1b[200~${clean.replace(/\n/g, "\r")}\x1b[201~`
    : dictationTextForTerminal(clean);
  return payload + (submit ? "\r" : "");
}
