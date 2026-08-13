//! How much of each CLI's plan is spent, read from what the CLIs already wrote.
//!
//! Nothing here talks to a network and nothing scans a whole history: both tools
//! cache their own limit status on disk, so the work is one small read each.
//!
//!   claude  `~/.claude.json` → `cachedUsageUtilization`, refreshed by the CLI
//!   codex   newest `~/.codex/sessions/**/rollout-*.jsonl` → last `rate_limits`
//!
//! Both are therefore as old as the last time that CLI ran, which is why every
//! reading carries the timestamp it was taken at — a stale number presented as
//! current would be worse than none.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Enough of a rollout file to hold the last token report without reading a
/// session that may run to tens of megabytes.
const ROLLOUT_TAIL: u64 = 1024 * 1024;
/// Sessions are filed by day; a resumed one can land in an older folder.
const ROLLOUT_DAYS: usize = 4;

/// The endpoint claude's own `/usage` reads, and the header that lets an OAuth
/// token address it.
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Floor between two live readings, and the age at which the file's own reading
/// stops being good enough. One request is about two kilobytes, so this is
/// roughly a megabyte a day with the window open all day — but only while it is
/// actually open (see `UsageBar`).
const LIVE_INTERVAL_MS: i64 = 90_000;
/// A reading that cannot be taken must not be re-attempted on every poll.
const LIVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Percent of the allowance already spent.
    pub percent: f64,
    /// When the window rolls over, as epoch milliseconds.
    pub resets_at_ms: Option<i64>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    /// The short rolling window: five hours for claude, five for codex too when
    /// its plan has one.
    pub session: Option<Window>,
    pub weekly: Option<Window>,
    pub plan: Option<String>,
    /// When the CLI last wrote this, as epoch milliseconds.
    pub measured_at_ms: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUsage {
    pub claude: Option<ToolUsage>,
    pub codex: Option<ToolUsage>,
}

/// Last answer, with whatever identifies the file it came from.
///
/// Neither file changes unless its CLI runs, and a status line polls far more
/// often than that. Without this, idling with the app open would re-parse a
/// 250 KB config and re-read a megabyte of session log every poll, forever.
struct Memo<K> {
    key: K,
    value: Option<ToolUsage>,
}

/// Keyed on the config file's modified time.
static CLAUDE_MEMO: Mutex<Option<Memo<i64>>> = Mutex::new(None);
/// The last live reading and when it was attempted — a failure is remembered
/// too, so being offline costs one request per interval rather than one per poll.
static LIVE_MEMO: Mutex<Option<Live>> = Mutex::new(None);
/// Keyed on the newest rollout and its modified time — a new session means a
/// new path, more turns in the same session means a new time.
static CODEX_MEMO: Mutex<Option<Memo<(PathBuf, i64)>>> = Mutex::new(None);

/// Returns the memo's value when `key` still describes it, otherwise computes a
/// fresh one and remembers it.
fn memoized<K: PartialEq>(
    memo: &Mutex<Option<Memo<K>>>,
    key: K,
    compute: impl FnOnce() -> Option<ToolUsage>,
) -> Option<ToolUsage> {
    // Dropped before computing: the read is slow and holding the lock across it
    // would make two panes asking at once wait on each other for no reason.
    if let Some(held) = memo.lock().as_ref() {
        if held.key == key {
            return held.value.clone();
        }
    }

    let value = compute();
    *memo.lock() = Some(Memo {
        key,
        value: value.clone(),
    });
    value
}

struct Live {
    attempted_at_ms: i64,
    value: Option<ToolUsage>,
}

/// Reads both tools. A tool that is not installed, not logged in, or has simply
/// never written a reading comes back as `None` rather than as an error: one
/// missing CLI must not hide the other.
///
/// `live` allows the claude reading to be taken from the source rather than from
/// the CLI's cache; see `claude_usage`.
///
/// Off the async workers entirely: this is blocking file work, one read is a
/// megabyte of session log, and with `live` it can reach the network. The main
/// thread is where `create_session` is answered — a terminal must never wait on
/// a status line.
#[tauri::command]
pub async fn cli_usage(app: AppHandle, live: bool) -> CliUsage {
    let home = app.path().home_dir().ok();
    tauri::async_runtime::spawn_blocking(move || CliUsage {
        claude: home.as_deref().and_then(|home| claude_usage(home, live)),
        codex: home.as_deref().and_then(codex_usage),
    })
    .await
    .unwrap_or(CliUsage {
        claude: None,
        codex: None,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

/// RFC 3339, which is what both tools write. Parsed by hand rather than by
/// pulling in a date crate for one field: only the instant is wanted, and the
/// frontend does the formatting.
fn rfc3339_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    // Days from the civil epoch (Howard Hinnant's algorithm), which is exact for
    // every date these files can hold and needs no lookup tables.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146097 + day_of_era - 719468;

    let offset_seconds = match text.get(19..) {
        // A zone offset can only follow the seconds, and `Z` means none.
        Some(rest) if rest.contains('+') || rest.matches('-').count() > 0 => {
            let sign_at = rest.find(['+', '-'])?;
            let sign = if rest.as_bytes()[sign_at] == b'-' { -1 } else { 1 };
            let zone = rest.get(sign_at + 1..)?;
            let hours: i64 = zone.get(0..2)?.parse().ok()?;
            let minutes: i64 = zone.get(3..5).and_then(|m| m.parse().ok()).unwrap_or(0);
            sign * (hours * 3600 + minutes * 60)
        }
        _ => 0,
    };

    Some(((days * 86400 + hour * 3600 + minute * 60 + second) - offset_seconds) * 1000)
}

fn window_from(value: &Value) -> Option<Window> {
    let percent = value.get("utilization")?.as_f64()?;
    Some(Window {
        percent,
        resets_at_ms: value
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(rfc3339_ms),
    })
}

/// claude writes `cachedUsageUtilization` when it has a reason to — at startup,
/// and when the user opens `/usage`. In between it does not, so a long session
/// can spend a third of its window while the file still says what it said hours
/// ago. The bar was honest about that ("2시간 전") and honestly useless.
///
/// With `live`, the reading is instead taken from the endpoint the CLI itself
/// reads, using the token the CLI already stored. Everything about it is a
/// fallback: no token, an expired one (refreshing is the CLI's business, not
/// ours), no network, an answer that does not parse — each of those quietly
/// leaves the file's reading in place, which is exactly what 0.6.1 showed.
fn claude_usage(home: &Path, live: bool) -> Option<ToolUsage> {
    let path = home.join(".claude.json");
    let cached = modified_ms(&path).and_then(|key| memoized(&CLAUDE_MEMO, key, || read_claude(&path)));
    if !live {
        return cached;
    }

    // When the CLI has just refreshed its own cache, that is the same number for
    // free — the request would only confirm it.
    let fresh_enough = cached
        .as_ref()
        .and_then(|usage| usage.measured_at_ms)
        .is_some_and(|at| now_ms() - at < LIVE_INTERVAL_MS);
    if fresh_enough {
        return cached;
    }

    live_claude(home).or(cached)
}

/// One request per `LIVE_INTERVAL_MS` at most, whatever the caller does.
fn live_claude(home: &Path) -> Option<ToolUsage> {
    if let Some(held) = LIVE_MEMO.lock().as_ref() {
        if now_ms() - held.attempted_at_ms < LIVE_INTERVAL_MS {
            return held.value.clone();
        }
    }

    let value = claude_token(home).and_then(|token| fetch_claude(&token));
    *LIVE_MEMO.lock() = Some(Live {
        attempted_at_ms: now_ms(),
        value: value.clone(),
    });
    value
}

/// The access token claude stored, if it is still valid.
///
/// Windows and Linux keep it in a file. macOS keeps it in the Keychain, so this
/// finds nothing there and the file reading stands — which is the same answer
/// 0.6.1 gave, not a worse one.
fn claude_token(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(home.join(".claude").join(".credentials.json")).ok()?;
    let oauth = serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("claudeAiOauth")?
        .clone();
    if oauth.get("expiresAt").and_then(Value::as_i64)? <= now_ms() {
        return None;
    }
    Some(oauth.get("accessToken")?.as_str()?.to_owned())
}

/// The token goes to api.anthropic.com and nowhere else, and nothing about the
/// answer is written to disk.
fn fetch_claude(token: &str) -> Option<ToolUsage> {
    let body = ureq::get(CLAUDE_USAGE_URL)
        .timeout(LIVE_TIMEOUT)
        .set("authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", OAUTH_BETA)
        .set("user-agent", concat!("IceCmd/", env!("CARGO_PKG_VERSION")))
        .call()
        .ok()?
        .into_string()
        .ok()?;

    // The endpoint answers with the same object the CLI files under
    // `utilization`, so the two readings are the same shape by construction.
    let value: Value = serde_json::from_str(&body).ok()?;
    let usage = ToolUsage {
        session: value.get("five_hour").and_then(window_from),
        weekly: value.get("seven_day").and_then(window_from),
        plan: None,
        measured_at_ms: Some(now_ms()),
    };
    // An answer with neither window in it is not a reading; falling back to the
    // file beats showing an empty row.
    (usage.session.is_some() || usage.weekly.is_some()).then_some(usage)
}

fn read_claude(path: &Path) -> Option<ToolUsage> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cached: Value = serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("cachedUsageUtilization")?
        .clone();
    let utilization = cached.get("utilization")?;

    Some(ToolUsage {
        session: utilization.get("five_hour").and_then(window_from),
        weekly: utilization.get("seven_day").and_then(window_from),
        plan: None,
        measured_at_ms: cached
            .get("fetchedAtMs")
            .and_then(Value::as_i64)
            .or_else(|| modified_ms(path)),
    })
}

/// Newest rollout files first, across the last few day folders.
fn recent_rollouts(home: &Path) -> Vec<PathBuf> {
    let sessions = home.join(".codex").join("sessions");

    // year / month / day, each numeric, so the newest is the highest name.
    let newest_children = |dir: &Path, keep: usize| -> Vec<PathBuf> {
        let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.path())
            .collect();
        names.sort();
        names.reverse();
        names.truncate(keep);
        names
    };

    let mut days: Vec<PathBuf> = Vec::new();
    for year in newest_children(&sessions, 2) {
        for month in newest_children(&year, 2) {
            days.extend(newest_children(&month, ROLLOUT_DAYS));
        }
        if days.len() >= ROLLOUT_DAYS {
            break;
        }
    }
    days.truncate(ROLLOUT_DAYS);

    let mut files: Vec<(i64, PathBuf)> = days
        .iter()
        .flat_map(|day| std::fs::read_dir(day).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| modified_ms(&path).map(|at| (at, path)))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|(_, path)| path).collect()
}

/// The last complete line mentioning `rate_limits`, read from the file's tail.
fn last_rate_limits(path: &Path) -> Option<Value> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let from = size.saturating_sub(ROLLOUT_TAIL);
    file.seek(SeekFrom::Start(from)).ok()?;

    let mut tail = String::new();
    // Sessions hold user text, so the tail can start mid-character; lossy
    // decoding keeps one split boundary from discarding the whole read.
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    tail.push_str(&String::from_utf8_lossy(&bytes));

    let mut lines: Vec<&str> = tail.lines().collect();
    // Seeking into the middle of the file leaves a partial first line.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    lines.iter().rev().find_map(|line| {
        if !line.contains("\"rate_limits\"") {
            return None;
        }
        let record: Value = serde_json::from_str(line).ok()?;
        record
            .pointer("/payload/rate_limits")
            .or_else(|| record.get("rate_limits"))
            .filter(|limits| !limits.is_null())
            .cloned()
    })
}

/// Codex reports whichever windows its plan has, tagged by length rather than
/// by name, so the caller cannot assume "primary" means the short one.
fn codex_window(value: Option<&Value>) -> Option<(bool, Window)> {
    let value = value?;
    let percent = value.get("used_percent")?.as_f64()?;
    let minutes = value.get("window_minutes").and_then(Value::as_i64);
    let resets_at_ms = value
        .get("resets_at")
        .and_then(Value::as_i64)
        .map(|seconds| seconds * 1000);
    // A day is the natural split: anything longer is the weekly allowance.
    let weekly = minutes.is_none_or(|m| m > 60 * 24);
    Some((
        weekly,
        Window {
            percent,
            resets_at_ms,
        },
    ))
}

fn codex_usage(home: &Path) -> Option<ToolUsage> {
    // The walk itself is a handful of directory listings; only the tail read
    // behind it is worth avoiding.
    let rollouts = recent_rollouts(home);
    let newest = rollouts.first()?;
    let key = (newest.clone(), modified_ms(newest)?);
    memoized(&CODEX_MEMO, key, || read_codex(&rollouts))
}

fn read_codex(rollouts: &[PathBuf]) -> Option<ToolUsage> {
    let (path, limits) = rollouts
        .iter()
        .find_map(|path| last_rate_limits(path).map(|limits| (path, limits)))?;

    let mut usage = ToolUsage {
        session: None,
        weekly: None,
        plan: limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        measured_at_ms: modified_ms(path),
    };

    for slot in ["primary", "secondary"] {
        if let Some((weekly, window)) = codex_window(limits.get(slot)) {
            if weekly {
                usage.weekly = Some(window);
            } else {
                usage.session = Some(window);
            }
        }
    }

    Some(usage)
}
