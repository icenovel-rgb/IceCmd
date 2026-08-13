/**
 * Plan usage for claude and codex, along the bottom of the window.
 *
 * codex writes its allowance into every session log it keeps, so its number is
 * as fresh as its last turn for free. claude only refreshes its cache when it
 * has a reason to, so with 실시간 갱신 on, that reading is taken from the source
 * instead once the cached one goes stale (see `usage.rs`).
 *
 * Either way each reading still shows how old it is rather than pretending to be
 * live — a number that silently stops moving is worse than one that says so.
 */
import { useEffect, useState } from "react";
import type { CliUsage, ToolUsage, UsageWindow } from "../types";
import { cliUsage } from "../terminal/ipc";
import { useWorkspace } from "../store/workspace";

/** Slow enough to be free, often enough to follow a session as it burns down. */
const POLL_MS = 30_000;
/** Above this the bar stops being informational and starts being a warning. */
const WARN_PERCENT = 75;
const DANGER_PERCENT = 90;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

/** "3분 전" reads better than a timestamp for something that should be recent. */
function ago(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

const level = (percent: number) =>
  percent >= DANGER_PERCENT ? "danger" : percent >= WARN_PERCENT ? "warn" : "ok";

function Meter({ label, window }: { label: string; window: UsageWindow }) {
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <span
      className={`usage-meter usage-${level(percent)}`}
      title={window.resetsAtMs ? `${clock(window.resetsAtMs)}에 초기화` : undefined}
    >
      <span className="usage-label">{label}</span>
      <span className="usage-track">
        <span className="usage-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="usage-percent">{Math.round(percent)}%</span>
    </span>
  );
}

function Tool({ name, usage }: { name: string; usage: ToolUsage | null }) {
  if (!usage || (!usage.session && !usage.weekly)) {
    return (
      <span className="usage-tool usage-tool-empty" title="이 CLI가 아직 사용량을 남기지 않았습니다">
        <span className="usage-name">{name}</span>
        <span className="usage-none">—</span>
      </span>
    );
  }

  return (
    <span className="usage-tool">
      <span className="usage-name">{name}</span>
      {usage.session && <Meter label="5시간" window={usage.session} />}
      {usage.weekly && <Meter label="주간" window={usage.weekly} />}
      {usage.measuredAtMs && <span className="usage-age">{ago(usage.measuredAtMs)}</span>}
    </span>
  );
}

export default function UsageBar() {
  const [usage, setUsage] = useState<CliUsage | null>(null);
  const liveUsage = useWorkspace((s) => s.prefs.liveUsage);

  useEffect(() => {
    let stopped = false;
    const read = () => {
      // Nothing on screen can be stale while the window is hidden, and a live
      // reading costs a request. Coming back re-reads immediately, below.
      if (document.hidden) return;
      void cliUsage(liveUsage)
        .then((next) => {
          if (!stopped) setUsage(next);
        })
        // A missing CLI is not an error worth showing; the row just stays empty.
        .catch(() => {});
    };

    read();
    const timer = window.setInterval(read, POLL_MS);
    // Coming back to the window is exactly when a stale number is most visible.
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [liveUsage]);

  return (
    <div className="usage-bar">
      <Tool name="claude" usage={usage?.claude ?? null} />
      <Tool name="codex" usage={usage?.codex ?? null} />
    </div>
  );
}
