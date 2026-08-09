import { createPortal } from "react-dom";
import qrImage from "../assets/support-qr.png";
import { openExternal } from "../terminal/ipc";

/** Same destination and brand colours as the other ICE apps. */
const SUPPORT_URL = "https://buymeacoffee.com/icenovel";

interface Props {
  onClose: () => void;
}

export default function SupportModal({ onClose }: Props) {
  // Rendered on <body> so the UI-scale zoom on the panels cannot shift a fixed
  // overlay, and so it is never clipped by a panel's overflow.
  return createPortal(
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="support-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2>IceCmd</h2>
        <p className="support-sub">가벼운 터미널 프로젝트 매니저</p>

        <div className="support-qr">
          <img src={qrImage} alt="Buy Me a Coffee 후원 QR 코드" width={200} height={200} />
        </div>

        <p className="support-copy">도움이 되셨다면 커피 한 잔으로 응원해 주세요 ☕</p>

        <button
          type="button"
          className="coffee-button"
          onClick={() => {
            void openExternal(SUPPORT_URL).catch(() => {});
          }}
        >
          ☕ Buy Me a Coffee
        </button>

        <p className="support-url">{SUPPORT_URL}</p>
        <button type="button" className="support-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>,
    document.body,
  );
}
