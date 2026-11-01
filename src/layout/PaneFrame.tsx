import { useEffect, useRef, useState } from "react";
import TerminalPane from "../terminal/TerminalPane";
import { dictateInto } from "../terminal/dictation";
import { getEntry } from "../terminal/termRegistry";
import { useWorkspace, type PaneMeta } from "../store/workspace";
import { isMac, isWindows, modLabel } from "../platform";
import { shellName } from "../shell";

/**
 * 이름표는 그 페인이 실제로 띄운 프로그램의 이름이다. 셸만 기계마다 다르다 —
 * 윈도우는 cmd, 맥은 로그인 셸(zsh·bash).
 */
const kindLabel = (kind: PaneMeta["kind"]): string =>
  kind === "shell" ? shellName() : kind;

/** How long a voice-typing message stays on the pane. */
const NOTICE_MS = 6000;

interface Props {
  meta: PaneMeta;
  /** Only the visible project's panes should take focus. */
  active: boolean;
  onDragStart: (paneId: string) => void;
}

export default function PaneFrame({ meta, active, onDragStart }: Props) {
  const splitPaneWith = useWorkspace((s) => s.splitPaneWith);
  const closePane = useWorkspace((s) => s.closePane);
  const setFocusedPane = useWorkspace((s) => s.setFocusedPane);
  const focused = useWorkspace((s) => s.focusedPane[meta.projectId] === meta.paneId);
  const fontSize = useWorkspace((s) => s.ui.fontSize);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const dictate = async () => {
    const message = await dictateInto(meta.paneId);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(message ?? "");
    if (message) noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
  };

  // A BEL is how Claude Code says it wants attention. xterm.js already parses
  // every byte for display, so hooking its event costs nothing extra.
  useEffect(() => {
    const entry = getEntry(meta.paneId);
    if (!entry) return;
    const bell = entry.term.onBell(() => {
      entry.attention = true;
    });
    return () => bell.dispose();
  }, [meta.paneId]);

  useEffect(() => {
    if (!active || !focused) return;
    getEntry(meta.paneId)?.term.focus();
  }, [active, focused, meta.paneId]);

  return (
    <div
      className={`pane-frame${focused ? " pane-focused" : ""}`}
      onPointerDown={() => setFocusedPane(meta.projectId, meta.paneId)}
    >
      <div className="pane-toolbar">
        <button
          type="button"
          className="pane-grip"
          title="끌어서 다른 페인 가장자리에 놓으면 배치가 바뀝니다"
          onPointerDown={(event) => {
            // Claim the gesture before the terminal or the focus handler sees it.
            event.preventDefault();
            event.stopPropagation();
            onDragStart(meta.paneId);
          }}
        >
          ⠿
        </button>
        <span className="pane-kind">{kindLabel(meta.kind)}</span>
        <button
          type="button"
          className="pane-mic"
          aria-label="음성 입력"
          title={
            isWindows
              ? "음성 입력 (Win+H) · 말한 내용이 이 터미널 입력란에 들어갑니다"
              : isMac
                ? "받아쓰기 · 말한 내용이 이 터미널 입력란에 들어갑니다"
                : "시스템 받아쓰기로 이 터미널에 입력"
          }
          // Keep focus in the terminal: the voice panel types into whatever holds it.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void dictate()}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
        </button>
        {/* The glyph shows which way the new divider will run. */}
        <button
          type="button"
          title={`좌우로 분할 (${modLabel}+Shift+D)`}
          onClick={() => splitPaneWith(meta.paneId, "row", "shell")}
        >
          │
        </button>
        <button
          type="button"
          title={`위아래로 분할 (${modLabel}+Shift+E)`}
          onClick={() => splitPaneWith(meta.paneId, "col", "shell")}
        >
          ─
        </button>
        <button
          type="button"
          className="pane-close"
          title={`페인 닫기 (${modLabel}+Shift+W)`}
          onClick={() => closePane(meta.paneId)}
        >
          ✕
        </button>
      </div>
      {notice && (
        <p className="pane-notice" role="status" onPointerDown={() => setNotice("")}>
          {notice}
        </p>
      )}
      <TerminalPane
        paneId={meta.paneId}
        cwd={meta.cwd}
        kind={meta.kind}
        initialFontSize={fontSize}
      />
    </div>
  );
}
