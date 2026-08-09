import type { PaneStatus } from "../types";

/**
 * Purely presentational. The status itself is derived from PTY traffic xterm.js
 * already parses, so showing it costs no monitoring work.
 *
 * The bell is an inline SVG rather than 🔔: emoji fall back to whatever font on the
 * machine happens to carry the codepoint, and a monochrome placeholder would make a
 * functional indicator unreadable.
 */
export default function StatusDot({ status }: { status: PaneStatus }) {
  if (status === "attention") {
    return (
      <span className="status status-attention" title="입력을 기다리고 있습니다">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 1.5a3.6 3.6 0 0 0-3.6 3.6v2.2L3 10.2h10L11.6 7.3V5.1A3.6 3.6 0 0 0 8 1.5Z"
          />
          <path fill="currentColor" d="M6.4 11.4h3.2a1.6 1.6 0 0 1-3.2 0Z" />
        </svg>
      </span>
    );
  }
  if (status === "busy") {
    return <span className="status status-busy" title="작업 중" />;
  }
  return <span className="status status-idle" />;
}
