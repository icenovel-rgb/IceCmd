//! Whether a pane asked to run as administrator actually can.
//!
//! Windows will not raise a process that is already attached to someone else's
//! console. Elevating goes through UAC, and what UAC starts normally gets a
//! window of its own — useless to a pane. The one exception is the `sudo` that
//! ships with Windows 11 (24H2 and later) in its *inline* mode: the elevated
//! process is attached back to the caller's console, which here is the pane's
//! pseudoconsole. Its other two modes either open a separate window or refuse
//! keyboard input, so only inline counts.
//!
//! sudo is off by default. The user turns it on in 설정 → 시스템 → 개발자용,
//! which writes the mode to the registry; a policy key can cap it lower.

/// Only these kinds ask to be elevated. A split or "여기서 cmd 열기" stays an
/// ordinary shell: a UAC prompt on every split would make splitting useless.
pub fn wants_elevation(kind: &str) -> bool {
    matches!(kind, "adminCmd" | "adminPs")
}

/// Read on every request rather than once: the user may turn sudo on while the
/// app is running, and a stale answer would label an ordinary shell 관리자.
#[cfg(windows)]
pub fn sudo_inline() -> bool {
    // sudo's own numbering: 0 off, 1 new window, 2 input disabled, 3 inline.
    const INLINE: u32 = 3;
    let mode = read_dword(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo", "Enabled");
    let cap = read_dword(r"SOFTWARE\Policies\Microsoft\Windows\Sudo", "Enabled");
    // A setting left behind with the program gone would make the spawn fail and
    // leave an empty pane; an ordinary shell with the notice is better.
    mode == Some(INLINE)
        && cap.is_none_or(|cap| cap >= INLINE)
        && std::path::Path::new(&system_program("sudo.exe")).is_file()
}

/// A program in System32, by full path.
///
/// Everything an administrator pane starts is named this way. A bare name is
/// looked up by whoever starts it, and that search can look in the current
/// folder — the project folder, which the agents in the other panes write to
/// without asking — before PATH. The folder comes from the system rather than
/// from `%SystemRoot%`, which is only an inherited variable.
#[cfg(windows)]
pub fn system_program(relative: &str) -> String {
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0u16; 260];
    // SAFETY: the length passed is the buffer's own; the call writes at most that.
    let written = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    let dir = if written > 0 && written < buffer.len() {
        String::from_utf16_lossy(&buffer[..written])
    } else {
        r"C:\Windows\System32".to_string()
    };
    format!(r"{dir}\{relative}")
}

/// macOS has no such step. `sudo` asks for the password inside the terminal,
/// so a pane that needs root just types it; no pane starts elevated.
#[cfg(not(windows))]
pub fn sudo_inline() -> bool {
    false
}

#[cfg(windows)]
fn read_dword(subkey: &str, value: &str) -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};

    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (subkey, value) = (wide(subkey), wide(value));
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated and outlive the call, and the
    // buffer is exactly the one DWORD that `size` says it is.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    // A missing key is the normal "sudo was never turned on" case.
    (status == 0).then_some(data)
}
