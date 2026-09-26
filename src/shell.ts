/**
 * 페인이 실제로 띄우는 셸의 이름.
 *
 * 윈도우는 언제나 `cmd` 지만 맥에서는 로그인 셸(`$SHELL`)이라 zsh 일 수도 bash 일
 * 수도 있다. 이름표와 메뉴가 이 이름을 적으므로 **물어봐서** 쓴다 — 화면에 "cmd"
 * 라고 박아 두면 맥에서는 있지도 않은 프로그램의 이름을 적게 된다.
 *
 * 값은 첫 그림을 그리기 전에 한 번 받아 두고 그 뒤로는 바뀌지 않는다. 그래서
 * 스토어에 넣지 않는다 — 다시 그릴 이유가 없는 값이다.
 */
import { isWindows } from "./platform";
import { shellNameOf } from "./terminal/ipc";

// 물어보기 전에도 화면은 그려질 수 있다. 그때 적어도 거짓말은 아닌 값.
let name = isWindows ? "cmd" : "셸";

export const shellName = (): string => name;

export async function loadShellName(): Promise<void> {
  try {
    name = await shellNameOf();
  } catch {
    // 못 물어봤으면 기본값 그대로 간다. 이름표 하나 때문에 앱을 멈출 이유는 없다.
  }
}
