//! One PTY session: spawn, stream output to the webview, resize, kill.
//!
//! Two threads per session:
//!   reader  — blocks on the PTY, forwards chunks, waits on the child, reports exit
//!   batcher — coalesces chunks into few large IPC messages, then emits `session-exit`
//!
//! Batching matters because every channel message costs a `webview.eval`; chunks
//! under 1 KB are additionally inlined as a JS number array by Tauri.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use super::flow::Flow;
use super::spawn;

/// ConPTY hands over whatever the console has repainted; a large buffer keeps
/// bursts to a handful of reads.
const READ_BUF: usize = 32 * 1024;
/// Flush as soon as a batch reaches this size.
const BATCH_MAX: usize = 48 * 1024;
/// Longest a byte waits in the batcher before being flushed.
const BATCH_WINDOW: Duration = Duration::from_millis(4);

type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type PtyMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

enum PtyMsg {
    Data(Vec<u8>),
    Exit(Option<u32>),
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    session_id: String,
    exit_code: Option<u32>,
}

pub struct Session {
    writer: PtyWriter,
    master: PtyMaster,
    flow: Arc<Flow>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    alive: Arc<AtomicBool>,
}

/// Cheap clone of the pieces a command needs, so PTY I/O never happens while the
/// session map is locked.
pub struct SessionHandle {
    writer: PtyWriter,
    master: PtyMaster,
    flow: Arc<Flow>,
}

impl Session {
    pub fn handle(&self) -> SessionHandle {
        SessionHandle {
            writer: self.writer.clone(),
            master: self.master.clone(),
            flow: self.flow.clone(),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Terminates the child and releases the pseudoconsole, which on Windows also
    /// tears down grandchildren attached to the same console.
    pub fn terminate(&mut self) {
        let _ = self.killer.kill();
        self.flow.close();
    }
}

pub struct SpawnConfig {
    pub session_id: String,
    pub cwd: String,
    pub kind: String,
    pub cols: u16,
    pub rows: u16,
    /// Force colour on for a plain shell as well. CLI panes force it regardless.
    pub force_color: bool,
}

pub fn spawn(
    app: AppHandle,
    cfg: SpawnConfig,
    channel: Channel<InvokeResponseBody>,
) -> Result<Session, String> {
    let size = PtySize {
        rows: cfg.rows.max(2),
        cols: cfg.cols.max(8),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let command = spawn::build(&cfg.kind, &cfg.cwd, cfg.force_color);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // The slave handle must go away or the PTY never reports EOF.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer: PtyWriter = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("take writer failed: {e}"))?,
    ));
    let master: PtyMaster = Arc::new(Mutex::new(pair.master));

    let flow = Arc::new(Flow::new());
    let alive = Arc::new(AtomicBool::new(true));
    let (tx, rx) = mpsc::channel::<PtyMsg>();

    let read_flow = flow.clone();
    std::thread::Builder::new()
        .name(format!("pty-read-{}", cfg.session_id))
        .stack_size(128 * 1024)
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                read_flow.wait_for_room();
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(PtyMsg::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let code = child.wait().ok().map(|status| status.exit_code());
            let _ = tx.send(PtyMsg::Exit(code));
        })
        .map_err(|e| format!("reader thread failed: {e}"))?;

    let batch_flow = flow.clone();
    let batch_alive = alive.clone();
    let session_id = cfg.session_id.clone();
    std::thread::Builder::new()
        .name(format!("pty-batch-{}", cfg.session_id))
        .stack_size(256 * 1024)
        .spawn(move || {
            let exit_code = pump(&rx, &channel, &batch_flow);
            batch_alive.store(false, Ordering::Relaxed);
            batch_flow.close();
            let _ = app.emit(
                "session-exit",
                ExitPayload {
                    session_id,
                    exit_code,
                },
            );
        })
        .map_err(|e| format!("batcher thread failed: {e}"))?;

    Ok(Session {
        writer,
        master,
        flow,
        killer,
        alive,
    })
}

/// Accumulates chunks until the batch is full or the window expires, then flushes.
/// Returns the child's exit code once the stream ends.
fn pump(
    rx: &mpsc::Receiver<PtyMsg>,
    channel: &Channel<InvokeResponseBody>,
    flow: &Flow,
) -> Option<u32> {
    let mut batch: Vec<u8> = Vec::with_capacity(BATCH_MAX);
    let mut deadline = Instant::now();
    let mut exit_code = None;

    loop {
        // Blocking indefinitely is only safe while nothing is buffered.
        let received = if batch.is_empty() {
            rx.recv().map_err(|_| ())
        } else {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(msg) => Ok(msg),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !flush(channel, &mut batch, flow) {
                        break;
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => Err(()),
            }
        };

        match received {
            Ok(PtyMsg::Data(chunk)) => {
                if batch.is_empty() {
                    deadline = Instant::now() + BATCH_WINDOW;
                }
                batch.extend_from_slice(&chunk);
                if batch.len() >= BATCH_MAX && !flush(channel, &mut batch, flow) {
                    break;
                }
            }
            Ok(PtyMsg::Exit(code)) => {
                exit_code = code;
                break;
            }
            Err(()) => break,
        }
    }

    flush(channel, &mut batch, flow);
    exit_code
}

/// Hands the batch to the webview. Returns false once the channel is gone.
fn flush(channel: &Channel<InvokeResponseBody>, batch: &mut Vec<u8>, flow: &Flow) -> bool {
    if batch.is_empty() {
        return true;
    }
    let bytes = std::mem::replace(batch, Vec::with_capacity(BATCH_MAX));
    let len = bytes.len();
    flow.sent(len);
    if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
        // Nobody will ever ack these bytes; releasing them keeps the reader alive.
        flow.ack(len);
        return false;
    }
    true
}

impl SessionHandle {
    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|_| "writer poisoned")?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("pty write failed: {e}"))
    }

    /// Reports bytes xterm.js has finished parsing, releasing reader backpressure.
    pub fn ack(&self, bytes: usize) {
        self.flow.ack(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|_| "master poisoned")?;
        master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(8),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))
    }
}
