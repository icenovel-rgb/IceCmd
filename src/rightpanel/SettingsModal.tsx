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

        <button type="button" className="settings-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>,
    document.body,
  );
}
