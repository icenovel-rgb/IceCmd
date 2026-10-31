/**
 * Window-level shortcuts. Registered in the capture phase because xterm.js
 * otherwise forwards the keystroke straight to the PTY, and because WebView2 has
 * its own Ctrl+/Ctrl-/Ctrl+wheel page zoom that must not fire.
 *
 * 수정자는 OS 마다 다르다. 윈도우는 Ctrl, 맥은 ⌘ 다 — 맥에서 Ctrl 은 셸의 것이라
 * (Ctrl+C 는 인터럽트, Ctrl+A·Ctrl+E 는 줄 편집) 앱이 가져가면 안 된다.
 *
 * 복사·붙여넣기만 규칙이 하나 더 갈린다. 윈도우에서 Shift 를 끼는 이유는 Ctrl+C
 * 를 셸에 남겨 두기 위해서인데, 맥에는 그 충돌이 없으므로 **⌘C·⌘V 그대로** 받는다.
 * 맥의 기본 메뉴(편집 > 복사·붙여넣기)가 같은 키를 물고 있지만, 그 항목은 웹뷰가
 * 복사할 것이 없을 때 스스로 회색이 되고 **회색인 메뉴 항목은 단축키를 삼키지
 * 않는다** — 그래서 터미널 선택은 여기까지 내려온다. 붙여넣기는 어느 쪽이 받든
 * 결과가 같다(메뉴가 받으면 xterm 의 paste 처리기가 PTY 로 보낸다).
 *
 * 페인 조작(D·E·W)은 양쪽 다 Shift 를 요구한다. 맥에서 ⌘W 는 **창을 닫는** 메뉴
 * 단축키라 페인 닫기에 쓸 수 없다.
 */
import { useEffect } from "react";
import { DEFAULT_UI, useWorkspace } from "./store/workspace";
import { copySelection, pasteInto, selectionOf } from "./terminal/clipboard";
import { hasMod, hasOtherMod, isMac } from "./platform";

/** 수정자+= 와 수정자++ 둘 다 "크게"다. 자판 배열이 달라도 하나는 맞는다. */
const ZOOM_IN_KEYS = new Set(["+", "=", "Add"]);
const ZOOM_OUT_KEYS = new Set(["-", "_", "Subtract"]);

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!hasMod(event) || event.altKey || hasOtherMod(event)) return;
      const { activeProjectId, focusedPane, splitPaneWith, closePane, nudgeFontSize, setFontSize } =
        useWorkspace.getState();
      const paneId = activeProjectId ? focusedPane[activeProjectId] : undefined;

      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // Zoom works with or without Shift, and needs no focused pane.
      if (ZOOM_IN_KEYS.has(event.key)) {
        consume();
        nudgeFontSize(1);
        return;
      }
      if (ZOOM_OUT_KEYS.has(event.key)) {
        consume();
        nudgeFontSize(-1);
        return;
      }
      if (event.key === "0") {
        consume();
        setFontSize(DEFAULT_UI.fontSize);
        return;
      }

      if (!paneId) return;
      const key = event.key.toLowerCase();

      // 복사·붙여넣기. 페인의 우클릭 메뉴와 구현을 나눠 쓴다.
      if (isMac ? !event.shiftKey : event.shiftKey) {
        if (key === "c") {
          // 선택이 없으면 그 키는 셸의 것이다(윈도우의 Ctrl+C).
          if (selectionOf(paneId)) {
            consume();
            void copySelection(paneId);
          }
          return;
        }
        if (key === "v") {
          consume();
          void pasteInto(paneId);
          return;
        }
      }

      if (!event.shiftKey) return;

      switch (key) {
        case "d":
          consume();
          splitPaneWith(paneId, "row", "shell");
          break;
        case "e":
          consume();
          splitPaneWith(paneId, "col", "shell");
          break;
        case "w":
          consume();
          closePane(paneId);
          break;
        default:
          break;
      }
    };

    // 여기만 맥에서도 Ctrl 이다. 트랙패드 핀치는 ⌘ 가 아니라 **ctrlKey 가 붙은
    // 휠 이벤트**로 오고(브라우저 공통), 맥에 ⌘+휠 확대는 없다.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      useWorkspace.getState().nudgeFontSize(event.deltaY < 0 ? 1 : -1);
    };

    window.addEventListener("keydown", onKeyDown, true);
    // Not passive: the browser's own zoom has to be cancelled.
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    };
  }, []);
}
