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
    </div>
  );
}
