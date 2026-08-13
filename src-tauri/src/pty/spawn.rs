//! Builds the child process for a session. All OS-specific shell knowledge lives here.

use portable_pty::CommandBuilder;

pub fn build(kind: &str, cwd: &str, force_color: bool) -> CommandBuilder {
    let mut cmd = shell(kind);
    // Set the working directory through the API rather than a `cd` command so
    // paths containing spaces (e.g. "D:\Naver MYBOX\...") need no quoting.
    cmd.cwd(cwd);
    // A pane opened *as* a CLI exists to run that one CLI on screen, so it is
    // always told outright; a plain shell is only told when the user asks.
    colour(&mut cmd, force_color || matches!(kind, "claude" | "codex"));
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

/// `cmd /K "<script>"` strips the outer quotes when the script contains a shell
/// metacharacter, so the `>` and `&` below reach cmd.exe as written.
/// Launching the CLI through cmd (rather than directly) lets PATH resolve the
/// npm `.cmd` shim and leaves a usable shell behind when the CLI exits.
#[cfg(windows)]
fn shell(kind: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("cmd.exe");
    match kind {
        "claude" => cmd.args(["/K", "chcp 65001>nul & claude"]),
        "codex" => cmd.args(["/K", "chcp 65001>nul & codex"]),
        _ => cmd.args(["/K", "chcp 65001>nul"]),
    }
    cmd
}

#[cfg(not(windows))]
fn shell(kind: &str) -> CommandBuilder {
    let login_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(login_shell);
    match kind {
        "claude" => cmd.args(["-i", "-l", "-c", "claude; exec \"$SHELL\" -i -l"]),
        "codex" => cmd.args(["-i", "-l", "-c", "codex; exec \"$SHELL\" -i -l"]),
        _ => cmd.args(["-i", "-l"]),
    }
    cmd
}
