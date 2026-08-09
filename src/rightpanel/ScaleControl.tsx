import {
  DEFAULT_UI,
  UI_LIMITS,
  UI_SCALE_STEP,
  useWorkspace,
} from "../store/workspace";

interface RowProps {
  label: string;
  /** Text shown in the middle; clicking it restores the default. */
  readout: string;
  minusTitle: string;
  plusTitle: string;
  onMinus: () => void;
  onPlus: () => void;
  onReset: () => void;
  slider: { min: number; max: number; step: number; value: number; onChange: (n: number) => void };
}

function ScaleRow({
  label,
  readout,
  minusTitle,
  plusTitle,
  onMinus,
  onPlus,
  onReset,
  slider,
}: RowProps) {
  return (
    <div className="scale-group">
      <div className="scale-row">
        <span className="scale-label">{label}</span>
        <button type="button" title={minusTitle} onClick={onMinus}>
          −
        </button>
        <button type="button" className="scale-value" title="기본값으로" onClick={onReset}>
          {readout}
        </button>
        <button type="button" title={plusTitle} onClick={onPlus}>
          ＋
        </button>
      </div>
      <input
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.value}
        onChange={(event) => slider.onChange(Number(event.target.value))}
      />
    </div>
  );
}

/**
 * Two independent sizes, because they solve different problems: the terminal text
 * size decides how much output fits, the UI scale decides how readable the chrome is.
 */
export default function ScaleControl() {
  const fontSize = useWorkspace((s) => s.ui.fontSize);
  const uiScale = useWorkspace((s) => s.ui.uiScale);
  const setFontSize = useWorkspace((s) => s.setFontSize);
  const nudgeFontSize = useWorkspace((s) => s.nudgeFontSize);
  const setUiScale = useWorkspace((s) => s.setUiScale);
  const nudgeUiScale = useWorkspace((s) => s.nudgeUiScale);

  const mySizes = useWorkspace((s) => s.mySizes);
  const saveMySizes = useWorkspace((s) => s.saveMySizes);
  const applyMySizes = useWorkspace((s) => s.applyMySizes);
  const clearMySizes = useWorkspace((s) => s.clearMySizes);

  const atMySizes =
    mySizes !== null && mySizes.fontSize === fontSize && mySizes.uiScale === uiScale;

  return (
    <div className="scale-control">
      <ScaleRow
        label="화면 배율"
        readout={`${Math.round(uiScale * 100)}%`}
        minusTitle="작게"
        plusTitle="크게"
        onMinus={() => nudgeUiScale(-UI_SCALE_STEP)}
        onPlus={() => nudgeUiScale(UI_SCALE_STEP)}
        onReset={() => setUiScale(DEFAULT_UI.uiScale)}
        slider={{
          min: UI_LIMITS.uiScale.min,
          max: UI_LIMITS.uiScale.max,
          step: UI_SCALE_STEP,
          value: uiScale,
          onChange: setUiScale,
        }}
      />
      <ScaleRow
        label="터미널 글자"
        readout={`${fontSize}px`}
        minusTitle="작게 (Ctrl−)"
        plusTitle="크게 (Ctrl+)"
        onMinus={() => nudgeFontSize(-1)}
        onPlus={() => nudgeFontSize(1)}
        onReset={() => setFontSize(DEFAULT_UI.fontSize)}
        slider={{
          min: UI_LIMITS.fontSize.min,
          max: UI_LIMITS.fontSize.max,
          step: 1,
          value: fontSize,
          onChange: setFontSize,
        }}
      />

      {/* 두 값을 한 쌍으로 기억한다. 배율만 맞고 글자만 어긋난 상태는 쓸모가 없다. */}
      <div className="mysize-row">
        <button
          type="button"
          className="mysize-save"
          title={
            mySizes
              ? `현재 값으로 덮어쓰기 (지금 저장된 값: ${Math.round(mySizes.uiScale * 100)}% · ${mySizes.fontSize}px)`
              : "지금 값을 내 설정으로 기억"
          }
          onClick={saveMySizes}
        >
          {mySizes ? "내 설정 덮어쓰기" : "내 설정으로 저장"}
        </button>
        <button
          type="button"
          className="mysize-apply"
          disabled={!mySizes || atMySizes}
          title={
            mySizes
              ? `내 설정으로 되돌리기 — ${Math.round(mySizes.uiScale * 100)}% · ${mySizes.fontSize}px`
              : "저장된 설정이 없습니다"
          }
          onClick={applyMySizes}
        >
          {atMySizes ? "내 설정 적용됨" : "내 설정 적용"}
        </button>
        {mySizes && (
          <button
            type="button"
            className="mysize-clear"
            title="저장된 내 설정 지우기"
            onClick={clearMySizes}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
