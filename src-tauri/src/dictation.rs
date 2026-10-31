//! Windows voice typing writes into the review textarea, never a PTY.

#[tauri::command]
pub fn start_dictation() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::start()
    }
    #[cfg(not(windows))]
    {
        Err("입력창에서 시스템 받아쓰기 단축키를 눌러 주세요.".into())
    }
}

#[tauri::command]
pub fn stop_dictation() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::stop()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VK_CONTROL, VK_ESCAPE, VK_H, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        },
        WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };

    fn is_foreground() -> bool {
        let mut pid = 0;
        // SAFETY: Windows supplies the HWND, and pid is a valid out pointer.
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut pid) };
        pid == std::process::id()
    }

    fn key(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    ..Default::default()
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        // SAFETY: INPUTs are initialized and live for the entire call.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent == inputs.len() as u32 {
            return Ok(());
        }
        // A partial chord must not leave our synthetic Windows key held down.
        let releases: Vec<_> = inputs[..sent as usize]
            .iter()
            .rev()
            .filter_map(|input| {
                // SAFETY: every INPUT in this module is INPUT_KEYBOARD.
                let keyboard = unsafe { input.Anonymous.ki };
                (keyboard.dwFlags == 0).then(|| key(keyboard.wVk, true))
            })
            .collect();
        if !releases.is_empty() {
            unsafe {
                SendInput(
                    releases.len() as u32,
                    releases.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                );
            }
        }
        Err("Windows 음성 입력을 제어하지 못했습니다. 입력창에서 Win+H를 눌러 주세요.".into())
    }

    pub fn start() -> Result<(), String> {
        if !is_foreground() {
            return Err("IceCmd 창을 선택한 뒤 음성 입력을 다시 눌러 주세요.".into());
        }
        // Never turn a user's Ctrl/Alt/Shift chord into another system shortcut.
        if [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            .iter()
            .any(|vk| unsafe { GetAsyncKeyState(*vk as i32) } < 0)
        {
            return Err("단축키에서 손을 뗀 뒤 음성 입력을 다시 눌러 주세요.".into());
        }
        send(&[
            key(VK_LWIN, false),
            key(VK_H, false),
            key(VK_H, true),
            key(VK_LWIN, true),
        ])
    }

    pub fn stop() -> Result<(), String> {
        // A late close must never inject a key into a different foreground app.
        if !is_foreground() {
            return Ok(());
        }
        send(&[key(VK_ESCAPE, false), key(VK_ESCAPE, true)])
    }
}
