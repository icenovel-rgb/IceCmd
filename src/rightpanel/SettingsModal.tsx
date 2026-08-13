import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useWorkspace, type RightClickAction } from "../store/workspace";
import ScaleControl from "./ScaleControl";

interface Props {
  onClose: () => void;
}

const RIGHT_CLICK_CHOICES: { value: RightClickAction; label: string; note: string }[] = [
  { value: "menu", label: "메뉴 표시", note: "복사·붙여넣기·모두 선택·화면 지우기" },
  { value: "paste", label: "바로 붙여넣기", note: "콘솔의 빠른 편집처럼 누르는 즉시" },
];

/**
 * Everything that is a setting rather than a control.
 *
 * The two size sliders live here too: they are adjusted once and then left
 * alone, and having them in the panel footer pushed the folder tree into a
 * strip. Ctrl +/− still changes the terminal size without opening anything.
 */
export default function SettingsModal({ onClose }: Props) {
  const prefs = useWorkspace((s) => s.prefs);
  const setPrefs = useWorkspace((s) => s.setPrefs);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // On <body>, like the other overlays: the panels carry a CSS `zoom`, and a
  // fixed element inside a zoomed ancestor has its coordinates scaled too.
  return createPortal(
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="settings-dialog" onPointerDown={(event) => event.stopPropagation()}>
        <h2>설정</h2>

        <section className="settings-section">
          <h3>화면</h3>
          <ScaleControl />
        </section>

        <section className="settings-section">
          <h3>터미널 우클릭</h3>
          <div className="pref-choice">
            {RIGHT_CLICK_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={prefs.rightClick === choice.value ? "pref-on" : undefined}
                aria-pressed={prefs.rightClick === choice.value}
                title={choice.note}
                onClick={() => setPrefs({ rightClick: choice.value })}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <p className="pref-note">
            {RIGHT_CLICK_CHOICES.find((choice) => choice.value === prefs.rightClick)?.note}
            {" · "}
            Ctrl+Shift+C / V는 어느 쪽이든 그대로입니다.
          </p>
        </section>

        <section className="settings-section">
          <h3>폴더 목록</h3>
          <label className="pref-toggle">
            <input
              type="checkbox"
              checked={prefs.watchFolders}
              onChange={(event) => setPrefs({ watchFolders: event.target.checked })}
            />
            <span>폴더가 바뀌면 저절로 다시 읽기</span>
          </label>
          <p className="pref-note">
            펼쳐 둔 폴더만, 한 단계씩 지켜봅니다. OS가 알려주는 방식이라 가만히 있을 때는
            아무 일도 하지 않습니다.
          </p>
        </section>

        <section className="settings-section">
          <h3>터미널 색</h3>
          <label className="pref-toggle">
            <input
              type="checkbox"
              checked={prefs.forceColor}
              onChange={(event) => setPrefs({ forceColor: event.target.checked })}
            />
            <span>셸에서도 색을 강제로 켜기</span>
          </label>
          <p className="pref-note">
            claude·codex 창은 언제나 켜져 있습니다. 이 스위치는 셸에서 직접 CLI를 띄웠을 때
            글자가 흑백으로만 나오는 PC를 위한 것입니다. 켜면 그 셸에서 파일로 넘긴 출력에도
            색 코드가 섞이므로, 필요한 기계에서만 켜세요. 새로 여는 창부터 적용됩니다.
          </p>
        </section>

        <section className="settings-section">
          <h3>사용량 표시</h3>
          <label className="pref-toggle">
            <input
              type="checkbox"
              checked={prefs.liveUsage}
              onChange={(event) => setPrefs({ liveUsage: event.target.checked })}
            />
            <span>claude 사용량을 직접 확인하기</span>
          </label>
          <p className="pref-note">
            claude는 <code>/usage</code>를 열어볼 때만 자기 기록을 갱신합니다. 켜 두면 그 기록이
            낡았을 때만 IceCmd가 대신 확인합니다 — 창이 보일 때만, 90초에 한 번, 2KB. 토큰은
            claude가 저장해 둔 것을 읽어 api.anthropic.com 한 곳에만 보내고 어디에도 남기지
            않습니다. 끄면 예전처럼 claude가 남긴 기록만 읽습니다.
          </p>
        </section>

        <button type="button" className="settings-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>,
    document.body,
  );
}
