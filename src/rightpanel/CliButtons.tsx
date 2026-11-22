import { useWorkspace } from "../store/workspace";
import { isWindows } from "../platform";
import { shellName } from "../shell";
import type { SessionKind } from "../types";

interface Props {
  projectId: string;
}

interface CliButton {
  kind: SessionKind;
  label: string;
  className: string;
  title?: string;
}

const ADMIN_TITLE = "관리자 권한으로 실행 — UAC 확인 창이 뜹니다 (윈도우 sudo 인라인 모드 필요)";

/** CLI 셋. codex·agy 는 권한 확인을 끄고 띄우고, claude 는 그대로 띄운다(`src-tauri/src/pty/spawn.rs`). */
const CLI_ROW: CliButton[] = [
  { kind: "claude", label: "claude", className: "cli-claude" },
  {
    kind: "codex",
    label: "codex",
    className: "cli-codex",
    title: "전체 접근으로 실행 (샌드박스 제한·승인 요청 해제)",
  },
  {
    kind: "agy",
    label: "agy",
    className: "cli-agy",
    title: "모든 권한 요청을 자동 승인하고 실행 (--dangerously-skip-permissions)",
  },
];

/**
 * 셸 줄. 윈도우는 관리자 cmd·PowerShell 둘이다. 맥에는 둘 다 없고 관리자 창이라는
 * 개념도 없어서 로그인 셸 하나만 둔다 — root 가 필요하면 그 칸에서 sudo 를 친다.
 */
const shellRow = (): CliButton[] =>
  isWindows
    ? [
        { kind: "adminCmd", label: "cmd", className: "cli-admin-cmd", title: ADMIN_TITLE },
        { kind: "adminPs", label: "PowerShell", className: "cli-admin-ps", title: ADMIN_TITLE },
      ]
    : [{ kind: "shell", label: shellName(), className: "cli-shell" }];

/**
 * Each click adds a pane: the roomiest existing pane is halved along its longer
 * edge and the CLI starts there, in the project's folder.
 */
export default function CliButtons({ projectId }: Props) {
  const openCli = useWorkspace((s) => s.openCli);

  const row = (buttons: CliButton[], className: string) => (
    <div className={`cli-row ${className}`}>
      {buttons.map((button) => (
        <button
          key={button.kind}
          type="button"
          className={button.className}
          title={button.title}
          onClick={() => openCli(projectId, button.kind)}
        >
          {button.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="cli-buttons">
      {row(CLI_ROW, "cli-row-agents")}
      {row(shellRow(), "cli-row-shells")}
    </div>
  );
}
