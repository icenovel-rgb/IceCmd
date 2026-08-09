//! Backpressure between the PTY reader and the webview.
//!
//! The webview acknowledges bytes only after xterm.js has finished parsing them.
//! When it falls too far behind, the reader thread parks instead of letting the
//! IPC queue grow without bound.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Bytes the webview may be behind before the reader stops pulling from the PTY.
const HIGH_WATER: usize = 1024 * 1024;

/// Safety valve: never park longer than this without re-checking `closed`.
const PARK_SLICE: Duration = Duration::from_millis(250);

pub struct Flow {
    unacked: Mutex<usize>,
    room: Condvar,
    closed: AtomicBool,
}

impl Flow {
    pub fn new() -> Self {
        Self {
            unacked: Mutex::new(0),
            room: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Called after handing `n` bytes to the webview.
    pub fn sent(&self, n: usize) {
        let mut pending = self.unacked.lock().unwrap();
        *pending = pending.saturating_add(n);
    }

    /// Called when the webview reports `n` bytes parsed.
    pub fn ack(&self, n: usize) {
        {
            let mut pending = self.unacked.lock().unwrap();
            *pending = pending.saturating_sub(n);
        }
        self.room.notify_all();
    }

    /// Blocks while the webview is more than [`HIGH_WATER`] bytes behind.
    pub fn wait_for_room(&self) {
        let mut pending = self.unacked.lock().unwrap();
        while *pending > HIGH_WATER && !self.closed.load(Ordering::Relaxed) {
            let (next, _) = self.room.wait_timeout(pending, PARK_SLICE).unwrap();
            pending = next;
        }
    }

    /// Releases any parked reader; called once the session is finished.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.room.notify_all();
    }
}
