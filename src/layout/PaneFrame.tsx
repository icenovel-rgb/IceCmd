import { useEffect } from "react";
import TerminalPane from "../terminal/TerminalPane";
import { getEntry } from "../terminal/termRegistry";
import { useWorkspace, type PaneMeta } from "../store/workspace";

const KIND_LABEL: Record<PaneMeta["kind"], string> = {
  shell: "cmd",
  claude: "claude",
  codex: "codex",
};

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
        <span className="pane-kind">{KIND_LABEL[meta.kind]}</span>
        {/* The glyph shows which way the new divider will run. */}
        <button
          type="button"
          title="좌우로 분할 (Ctrl+Shift+D)"
          onClick={() => splitPaneWith(meta.paneId, "row", "shell")}
        >
          │
        </button>
        <button
          type="button"
          title="위아래로 분할 (Ctrl+Shift+E)"
          onClick={() => splitPaneWith(meta.paneId, "col", "shell")}
        >
          ─
        </button>
        <button
          type="button"
          className="pane-close"
          title="페인 닫기 (Ctrl+Shift+W)"
          onClick={() => closePane(meta.paneId)}
        >
          ✕
        </button>
      </div>
      <TerminalPane
        paneId={meta.paneId}
        cwd={meta.cwd}
        kind={meta.kind}
        initialFontSize={fontSize}
      />
    </div>
  );
}
