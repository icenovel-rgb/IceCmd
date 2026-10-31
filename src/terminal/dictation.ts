import { isMac, isWindows } from "../platform";
import { startDictation } from "./ipc";
import { getEntry } from "./termRegistry";

/**
 * Opens voice typing on one pane's terminal.
 *
 * The voice panel types into whatever holds focus, so the terminal is focused
 * first and the words land in the CLI's own prompt, where they can be edited
 * before Enter. Resolves to a line to show the user, or null when nothing needs
 * saying (on Windows the panel itself says it is listening).
 */
export async function dictateInto(paneId: string): Promise<string | null> {
  const term = getEntry(paneId)?.term;
  if (!term) return "이 터미널은 종료되었습니다.";
  term.focus();
  if (!isWindows) {
    return `${isMac ? "macOS" : "시스템"} 받아쓰기 단축키를 눌러 주세요. 말한 내용이 이 터미널에 들어갑니다.`;
  }
  try {
    await startDictation();
    return null;
  } catch (reason) {
    return String(reason);
  }
}
