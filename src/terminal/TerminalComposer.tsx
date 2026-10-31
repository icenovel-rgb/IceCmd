import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMac, isWindows } from "../platform";
import { composerInputForTerminal } from "./dictationText";
import { writeSession } from "./ipc";
import { getEntry } from "./termRegistry";

interface Props {
  paneId: string;
  targetLabel: string;
}

/** Drafts live with their pane and never follow the globally focused terminal. */
export default function TerminalComposer({ paneId, targetLabel }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const dictationOpenedRef = useRef(false);
  const aliveRef = useRef(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");

  const fitEditor = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const paneHeight = rootRef.current?.closest(".pane-frame")?.clientHeight ?? 400;
    const limit = Math.max(30, Math.min(120, paneHeight * 0.3));
    area.style.height = "0px";
    area.style.height = `${Math.max(30, Math.min(limit, area.scrollHeight))}px`;
  }, []);

  useLayoutEffect(fitEditor, [text, fitEditor]);
  useEffect(() => {
    const frame = rootRef.current?.closest(".pane-frame");
    const observer = new ResizeObserver(fitEditor);
    if (frame) observer.observe(frame);
    return () => {
      aliveRef.current = false;
      observer.disconnect();
    };
  }, [fitEditor]);

  const startDictation = async () => {
    if (sendingRef.current) return;
    areaRef.current?.focus();
    setError("");
    if (!isWindows) {
      setHint(`${isMac ? "macOS" : "시스템"} 받아쓰기 단축키를 입력창에서 눌러 주세요.`);
      return;
    }
    try {
      await invoke("start_dictation");
      if (!aliveRef.current) return;
      dictationOpenedRef.current = true;
      setHint("Windows 음성 입력 · 한국어는 입력 언어를 한국어로 맞춰 주세요.");
    } catch (reason) {
      if (aliveRef.current) setError(String(reason));
    }
  };

  const send = async () => {
    if (sendingRef.current || composingRef.current || !areaRef.current?.value.trim()) return;
    sendingRef.current = true;
    setBusy(true);
    setError("");
    areaRef.current.focus();
    try {
      if (isWindows && dictationOpenedRef.current) {
        await invoke("stop_dictation");
        // Final transcription events still belong to this editor.
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        dictationOpenedRef.current = false;
      }
      if (!aliveRef.current) return;
      const entry = getEntry(paneId);
      if (!entry || entry.disposed || entry.exited) throw new Error("이 터미널은 종료되었습니다. 입력 내용은 보관했습니다.");
      const value = areaRef.current?.value ?? text;
      const bracketedPaste = entry.term.modes.bracketedPasteMode && entry.term.options.ignoreBracketedPasteMode !== true;
      const payload = composerInputForTerminal(value, bracketedPaste);
      if (!payload) return;
      // One write keeps paste and Enter ordered, including across split panes.
      entry.term.scrollToBottom();
      await writeSession(paneId, payload);
      if (!aliveRef.current) return;
      setText((current) => current === value ? "" : current);
      setHint("");
      // Do not pull focus back if the user moved to another pane during IPC.
      if (rootRef.current?.contains(document.activeElement)) areaRef.current?.focus();
    } catch (reason) {
      if (aliveRef.current) setError(String(reason));
    } finally {
      sendingRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="pane-composer" data-terminal-composer>
      <div className="composer-card">
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          aria-label={`${targetLabel} 입력`}
          placeholder={`${targetLabel}에 보낼 내용을 입력하세요`}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-controls">
          <button
            type="button"
            className="composer-mic"
            aria-label="마이크 입력"
            title={isWindows ? "Windows 음성 입력 (Win+H) · 인터넷과 마이크 권한이 필요합니다" : "시스템 받아쓰기"}
            disabled={busy}
            onClick={() => void startDictation()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
            </svg>
          </button>
          <span className="composer-target">{targetLabel}</span>
          <span className="composer-shortcut">Enter 전송 · Shift+Enter 줄바꿈</span>
          <button
            type="button"
            className="composer-send"
            aria-label={`${targetLabel}에 전송`}
            title="전송 (Enter)"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          </button>
        </div>
      </div>
      {(error || hint || (targetLabel === "cmd" && text.includes("\n"))) && (
        <p className={error ? "composer-error" : "composer-hint"} role={error ? "alert" : "status"}>
          {error || hint || "cmd에서는 줄바꿈을 공백으로 보내 한 줄로 실행합니다."}
        </p>
      )}
    </div>
  );
}
