//! Session registry. Owns every live PTY; knows nothing about projects or panes.

mod flow;
mod session;
mod spawn;

pub use session::{spawn as spawn_session, Session, SessionHandle, SpawnConfig};

use parking_lot::Mutex;
use std::collections::HashMap;

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, id: String, session: Session) {
        if let Some(mut previous) = self.sessions.lock().insert(id, session) {
            previous.terminate();
        }
    }

    /// Returns cheap clones so callers can do PTY I/O without holding the map lock.
    pub fn handle(&self, id: &str) -> Option<SessionHandle> {
        self.sessions.lock().get(id).map(Session::handle)
    }

    pub fn is_alive(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .get(id)
            .map(Session::is_alive)
            .unwrap_or(false)
    }

    pub fn remove(&self, id: &str) {
        let removed = self.sessions.lock().remove(id);
        // Dropped outside the lock: terminate can block briefly.
        if let Some(mut session) = removed {
            session.terminate();
        }
    }

    /// Kills everything. Called once on application exit.
    pub fn shutdown(&self) {
        let drained: Vec<Session> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for mut session in drained {
            session.terminate();
        }
    }
}
