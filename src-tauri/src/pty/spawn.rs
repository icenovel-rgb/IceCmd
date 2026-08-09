//! Builds the child process for a session. All OS-specific shell knowledge lives here.

use portable_pty::CommandBuilder;

pub fn build(kind: &str, cwd: &str) -> CommandBuilder {
    let mut cmd = shell(kind);
    // Set the working directory through the API rather than a `cd` command so
    // paths containing spaces (e.g. "D:\Naver MYBOX\...") need no quoting.
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
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
