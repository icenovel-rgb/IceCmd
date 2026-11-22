//! Builds the child process for a session. All OS-specific shell knowledge lives here.

use portable_pty::CommandBuilder;

#[cfg(windows)]
use super::elevation::{system_program, wants_elevation};

/// `elevate` is only ever true for an administrator pane on a machine whose
/// sudo is in inline mode (`elevation.rs`); everywhere else it is ignored.
pub fn build(kind: &str, cwd: &str, force_color: bool, elevate: bool) -> CommandBuilder {
    let mut cmd = shell(kind, cwd, elevate);
    // Set the working directory through the API rather than a `cd` command so
    // paths containing spaces (e.g. "D:\Naver MYBOX\...") need no quoting.
    cmd.cwd(cwd);
    // A pane opened *as* a CLI exists to run that one CLI on screen, so it is
    // always told outright; a plain shell is only told when the user asks.
    colour(&mut cmd, force_color || matches!(kind, "claude" | "codex" | "agy"));
    cmd
}

/// What the child is told about colour.
///
/// `TERM` and `COLORTERM` describe the terminal, which is the polite way to ask
/// and is enough on most machines. It is not enough on all of them. Every common
/// CLI decides for itself, and two things outrank what we just said: whether it
/// believes its own stdout is a terminal, and an inherited `NO_COLOR`, which
/// wins over everything. When either goes wrong the output arrives with no SGR
/// codes at all — not wrong colours, *no* colours. That is what "on that PC
/// everything comes out black and white" is.
///
/// So a CLI pane is told outright rather than asked. `FORCE_COLOR` is the first
/// thing Node's `supports-color` reads, before the TTY test (claude and codex
/// are both Node CLIs), and `CLICOLOR_FORCE` is the same idea for the BSD/Go
/// family. Plain shells are left alone by default: forcing colour there also
/// colours output on its way into a file, and `dir > list.txt` should not come
/// back full of escape codes. 설정 turns it on for shells too, for the machine
/// where the CLI is started by hand from a shell pane.
fn colour(cmd: &mut CommandBuilder, force: bool) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Inherited from the machine, not set by us, and it beats both lines above.
    cmd.env_remove("NO_COLOR");
    if force {
        cmd.env("FORCE_COLOR", "3");
        cmd.env("CLICOLOR_FORCE", "1");
    }
}

/// The command line each CLI pane runs. codex and agy are told to stop asking
/// before they act; claude starts with its own permission prompts as it is.
const CLAUDE: &str = "claude";
const CODEX: &str = "codex --sandbox danger-full-access --ask-for-approval never";
const AGY: &str = "agy --dangerously-skip-permissions";

/// The first thing a PowerShell pane runs: UTF-8 both ways, its counterpart of
/// the `chcp 65001` every cmd pane starts with, so a native program's UTF-8
/// output is decoded as UTF-8 rather than in the machine's ANSI code page.
#[cfg(windows)]
const PS_UTF8: &str =
    "[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)";

/// What an administrator pane that could not be elevated says first.
///
/// The shell says it, not the app: ConPTY repaints from its own buffer on every
/// resize, so a line written straight onto the screen would be wiped. No `"` in
/// it — the argument is quoted for CreateProcess, whose `\"` cmd does not read —
/// and none of the characters cmd treats as special.
#[cfg(windows)]
const NOT_ELEVATED: &str = "[관리자 권한이 아닙니다 - 설정 → 시스템 → 개발자용 → \
     「sudo 사용」을 켜고 구성을 「인라인」으로 두면 관리자로 열립니다]";

/// `cmd /K "<script>"` strips the outer quotes when the script contains a shell
/// metacharacter, so the `>` and `&` below reach cmd.exe as written.
/// Launching the CLI through cmd (rather than directly) lets PATH resolve the
/// npm `.cmd` shim and leaves a usable shell behind when the CLI exits.
#[cfg(windows)]
fn shell(kind: &str, cwd: &str, elevate: bool) -> CommandBuilder {
    let cmd_running = |line: &str| vec!["cmd.exe".into(), "/K".into(), format!("chcp 65001>nul & {line}")];
    let unelevated = wants_elevation(kind) && !elevate;
    let argv: Vec<String> = match kind {
        "claude" => cmd_running(CLAUDE),
        "codex" => cmd_running(CODEX),
        "agy" => cmd_running(AGY),
        "adminCmd" => admin_cmd(unelevated),
        "adminPs" => admin_ps(unelevated),
        _ => ["cmd.exe", "/K", "chcp 65001>nul"].map(String::from).to_vec(),
    };
    let argv = if elevate { through_sudo(argv, cwd) } else { argv };
    CommandBuilder::from_argv(argv.into_iter().map(Into::into).collect())
}

#[cfg(windows)]
fn admin_cmd(unelevated: bool) -> Vec<String> {
    let script = if unelevated {
        format!("chcp 65001>nul & echo \x1b[33m{NOT_ELEVATED}\x1b[0m")
    } else {
        "chcp 65001>nul".into()
    };
    vec![system_program("cmd.exe"), "/K".into(), script]
}

#[cfg(windows)]
fn admin_ps(unelevated: bool) -> Vec<String> {
    let script = if unelevated {
        format!("{PS_UTF8}; Write-Host -ForegroundColor Yellow '{NOT_ELEVATED}'")
    } else {
        PS_UTF8.into()
    };
    [
        system_program(r"WindowsPowerShell\v1.0\powershell.exe"),
        "-NoLogo".into(),
        "-NoExit".into(),
        "-Command".into(),
        script,
    ]
    .to_vec()
}

/// Runs `argv` as administrator inside this same pane.
///
/// sudo is named by its full path. Other tools install a `sudo` of their own
/// (gsudo, scoop's shim) that may come first on PATH and would not know
/// `--inline`. `--inline` itself makes sudo fail rather than quietly fall back
/// to a separate window if the setting changed since it was read. `--chdir` is
/// passed even though the pane's working directory is set too: in its other
/// modes sudo starts the command in System32.
///
/// Declining the UAC prompt makes sudo exit with an error, which ends the pane's
/// session — on purpose: an ordinary shell left behind would look elevated.
/// The elevated shell does not inherit our environment (sudo copies it only on
/// request), so `TERM` and the colour switches below do not reach it.
#[cfg(windows)]
fn through_sudo(argv: Vec<String>, cwd: &str) -> Vec<String> {
    [system_program("sudo.exe"), "--inline".into(), "--chdir".into(), cwd.into()]
        .into_iter()
        .chain(argv)
        .collect()
}

/// There is no administrator pane on macOS (`elevation.rs`); a pane that needs
/// root types `sudo`, which asks for the password in the terminal itself.
#[cfg(not(windows))]
fn shell(kind: &str, _cwd: &str, _elevate: bool) -> CommandBuilder {
    let login_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(login_shell);
    let then_shell = |cli: &str| format!("{cli}; exec \"$SHELL\" -i -l");
    let script = match kind {
        "claude" => Some(then_shell(CLAUDE)),
        "codex" => Some(then_shell(CODEX)),
        "agy" => Some(then_shell(AGY)),
        _ => None,
    };
    match script {
        Some(script) => cmd.args(["-i", "-l", "-c", script.as_str()]),
        None => cmd.args(["-i", "-l"]),
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(kind: &str, elevate: bool) -> Vec<String> {
        build(kind, r"D:\Naver MYBOX\프로젝트", false, elevate)
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn agy_starts_with_permission_prompts_off() {
        let line = argv("agy", false).join(" ");
        assert!(line.contains("agy --dangerously-skip-permissions"), "{line}");
    }

    #[test]
    fn an_ordinary_shell_never_goes_through_sudo() {
        // Without the caller's go-ahead nothing goes through sudo, not even an
        // administrator kind — that is the sudo-is-off fallback.
        assert!(!argv("shell", false).iter().any(|arg| arg.ends_with("sudo.exe")));
        assert!(!argv("adminCmd", false).iter().any(|arg| arg.ends_with("sudo.exe")));
    }

    #[cfg(windows)]
    fn ends_with(arg: &str, tail: &str) -> bool {
        arg.to_ascii_lowercase().ends_with(&tail.to_ascii_lowercase())
    }

    #[cfg(windows)]
    #[test]
    fn an_elevated_pane_runs_inline_sudo_from_system32_in_the_project_folder() {
        let cmd = argv("adminCmd", true);
        assert!(ends_with(&cmd[0], r"\system32\sudo.exe"), "{cmd:?}");
        assert_eq!(cmd[1..4], ["--inline", "--chdir", r"D:\Naver MYBOX\프로젝트"]);
        // By full path: a bare name can be found in the project folder first.
        assert!(ends_with(&cmd[4], r"\system32\cmd.exe"), "{cmd:?}");
        assert_eq!(cmd[5..], ["/K", "chcp 65001>nul"]);

        let ps = argv("adminPs", true);
        assert!(ends_with(&ps[4], r"\system32\WindowsPowerShell\v1.0\powershell.exe"), "{ps:?}");
        assert_eq!(ps[5..7], ["-NoLogo", "-NoExit"]);
    }

    #[cfg(windows)]
    #[test]
    fn only_a_pane_left_unelevated_says_so() {
        let said = |kind: &str, elevate: bool| argv(kind, elevate).join(" ").contains(NOT_ELEVATED);
        assert!(said("adminCmd", false) && said("adminPs", false));
        assert!(!said("adminCmd", true) && !said("adminPs", true));
        assert!(!said("shell", false));
        // cmd would read a `"` in the notice as the end of its script.
        assert!(!NOT_ELEVATED.contains('"') && !NOT_ELEVATED.contains('\''));
        assert!(!NOT_ELEVATED.chars().any(|c| "&|<>^()%!".contains(c)), "{NOT_ELEVATED}");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_without_sudo_is_the_same_powershell() {
        let ps = argv("adminPs", false);
        assert!(ends_with(&ps[0], r"\powershell.exe"), "{ps:?}");
        assert_eq!(ps[1..3], ["-NoLogo", "-NoExit"]);
    }

    #[test]
    fn only_the_two_administrator_kinds_ask_for_elevation() {
        use crate::pty::wants_elevation;
        assert!(wants_elevation("adminCmd") && wants_elevation("adminPs"));
        for kind in ["shell", "claude", "codex", "agy"] {
            assert!(!wants_elevation(kind), "{kind}");
        }
    }
}
