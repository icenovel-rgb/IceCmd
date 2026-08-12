//! Folder watching for the tree on the right.
//!
//! Only the folders whose rows are actually on screen are watched, one level
//! each, so the cost is a handful of `ReadDirectoryChangesW` registrations —
//! not a recursive walk of a project that contains `node_modules` or `target`.
//! An idle app still does no filesystem work: the OS pushes, nothing polls.
//!
//! Bursts are collapsed. A single `npm install` fires thousands of events, and
//! re-reading the folder once when the burst ends is the whole point.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, State};

/// How long the events have to stop before the folders are reported as changed.
const QUIET_MS: u64 = 250;
/// Ceiling on one burst, so a long-running writer still gets reported meanwhile.
const MAX_BURST: Duration = Duration::from_millis(1500);

pub struct DirWatch {
    inner: Mutex<Option<Inner>>,
}

struct Inner {
    watcher: RecommendedWatcher,
    /// Exactly what is registered, so a change of set is a diff, not a rebuild.
    watched: HashSet<PathBuf>,
}

impl DirWatch {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// Collects a burst and emits the folders it touched, deduplicated.
fn debounce_loop(app: AppHandle, rx: Receiver<PathBuf>) {
    while let Ok(first) = rx.recv() {
        let mut changed: HashSet<PathBuf> = HashSet::new();
        changed.insert(first);
        let started = Instant::now();

        loop {
            match rx.recv_timeout(Duration::from_millis(QUIET_MS)) {
                Ok(path) => {
                    changed.insert(path);
                    if started.elapsed() >= MAX_BURST {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                // The watcher was dropped: this thread has nothing left to do.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        let paths: Vec<String> = changed
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        // A closed window is the normal way this ends.
        if app.emit("fs-changed", paths).is_err() {
            return;
        }
    }
}

fn start(app: AppHandle) -> Result<Inner, String> {
    let (tx, rx) = channel::<PathBuf>();

    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else { return };
        for path in event.paths {
            // The event names the entry that changed; the tree redraws folders,
            // so what it needs to hear about is the folder that entry sits in.
            if let Some(parent) = path.parent() {
                // A send that fails means the receiver is gone, and the whole
                // watcher is on its way out with it.
                let _ = tx.send(parent.to_path_buf());
            }
        }
    })
    .map_err(|e| format!("could not start watching: {e}"))?;

    std::thread::spawn(move || debounce_loop(app, rx));
    Ok(Inner {
        watcher,
        watched: HashSet::new(),
    })
}

/// Watches exactly `paths` and nothing else. An empty list stops watching.
///
/// Async on purpose: it stats every path, and a synchronous command runs on the
/// same main thread that spawns sessions — that is how a status bar once delayed
/// a shell prompt.
#[tauri::command]
pub async fn watch_dirs(
    app: AppHandle,
    state: State<'_, DirWatch>,
    paths: Vec<String>,
) -> Result<(), String> {
    let wanted: HashSet<PathBuf> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect();

    let mut guard = state.inner.lock();
    if guard.is_none() {
        // Nothing to watch and nothing watching: do not start a thread to say so.
        if wanted.is_empty() {
            return Ok(());
        }
        *guard = Some(start(app)?);
    }
    let inner = guard.as_mut().expect("just created");

    let gone: Vec<PathBuf> = inner.watched.difference(&wanted).cloned().collect();
    for path in gone {
        let _ = inner.watcher.unwatch(&path);
        inner.watched.remove(&path);
    }

    let added: Vec<PathBuf> = wanted.difference(&inner.watched).cloned().collect();
    for path in added {
        // A folder can be gone between the tree reading it and this call; that is
        // not an error, it just cannot be watched.
        if inner
            .watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .is_ok()
        {
            inner.watched.insert(path);
        }
    }

    Ok(())
}
