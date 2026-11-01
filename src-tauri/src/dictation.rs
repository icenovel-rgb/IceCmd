//! System voice typing, opened on the focused terminal.
//!
//! The frontend focuses the pane's terminal first, so the panel types into the
//! CLI's own prompt like a keyboard would. Windows gets Win+H pressed for it;
//! macOS gets the same `startDictation:` the Edit menu's "Start Dictation…"
//! item sends, which runs the built-in dictation on the built-in microphone.
//! Nothing is sent to close either: the only key that does is Esc, and Esc in
//! a claude pane interrupts the agent.

#[tauri::command]
pub fn start_dictation(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows::start()
    }
    #[cfg(target_os = "macos")]
    {
        macos::start(&app)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("터미널을 누른 뒤 시스템 받아쓰기 단축키를 눌러 주세요.".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    /// AppKit's own dictation entry point. It is what the auto-inserted Edit >
    /// "Start Dictation…" menu item fires: nil-targeted, so it walks the
    /// responder chain from the focused view (the terminal's textarea inside
    /// the webview) up to NSApp, which implements it and opens dictation on
    /// that text input. Needs no microphone entitlement of our own — the
    /// recording and transcription happen in the system's dictation process.
    fn send(mtm: MainThreadMarker) -> Result<(), String> {
        let app = NSApplication::sharedApplication(mtm);
        // Dictation types into whatever is key. If that is another app, the
        // words would land there, so refuse instead of guessing.
        if !app.isActive() {
            return Err("IceCmd 창을 선택한 뒤 음성 입력을 다시 눌러 주세요.".into());
        }
        // SAFETY: a nil target and sender are what the menu item itself passes.
        let handled = unsafe { app.sendAction_to_from(sel!(startDictation:), None, None) };
        if handled {
            Ok(())
        } else {
            Err("macOS 받아쓰기를 열지 못했습니다. 터미널에서 받아쓰기 단축키를 눌러 주세요.".into())
        }
    }

    pub fn start(handle: &tauri::AppHandle) -> Result<(), String> {
        // AppKit must be driven from the main thread. A sync command normally
        // already runs there; if not, hop over and wait for the answer.
        if let Some(mtm) = MainThreadMarker::new() {
            return send(mtm);
        }
        let (tx, rx) = std::sync::mpsc::channel();
        handle
            .run_on_main_thread(move || {
                let mtm = MainThreadMarker::new().expect("run_on_main_thread runs on the main thread");
                let _ = tx.send(send(mtm));
            })
            .map_err(|error| error.to_string())?;
        rx.recv().map_err(|error| error.to_string())?
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, VK_CONTROL, VK_H, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
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
        Err("Windows 음성 입력을 제어하지 못했습니다. 터미널에서 Win+H를 눌러 주세요.".into())
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
}
