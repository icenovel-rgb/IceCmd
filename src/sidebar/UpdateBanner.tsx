import { useEffect, useState } from "react";
import {
  RELEASES_PAGE,
  checkForUpdate,
  currentVersion,
  type UpdateInfo,
} from "../update";
import { openExternal } from "../terminal/ipc";

/** Long enough that the check never competes with the first terminal opening. */
const START_DELAY_MS = 4000;

export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void checkForUpdate().then((info) => {
        if (live) setUpdate(info);
      });
    }, START_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);

  if (!update || dismissed) {
    return <div className="version-line">v{currentVersion}</div>;
  }

  return (
    <div className="update-banner">
      <div className="update-head">
        <span className="update-badge">새 버전</span>
        <span className="update-version">{update.version}</span>
        <button
          type="button"
          className="update-dismiss"
          title="이번 실행에서만 숨기기"
          onClick={() => setDismissed(true)}
        >
          ✕
        </button>
      </div>
      {update.notes && <p className="update-notes">{update.notes}</p>}
      <button
        type="button"
        className="update-get"
        onClick={() => {
          // If the direct asset link is refused for any reason, fall back to the
          // releases page rather than leaving the click doing nothing visible.
          void openExternal(update.downloadUrl).catch(() => {
            void openExternal(RELEASES_PAGE).catch(() => {});
          });
        }}
      >
        받기 (v{currentVersion} → {update.version})
      </button>
    </div>
  );
}
