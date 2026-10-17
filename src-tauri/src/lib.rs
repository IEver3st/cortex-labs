use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak,
    },
    time::{Duration, Instant, SystemTime},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

mod child_job;
mod els_scope;
mod fivem_kvs;
mod lens_write;
mod livery_write;
mod model_resource_scope;
mod pdn;
mod photo_assets;
mod vehicle_snapshots;

const BRIDGE_EXE_NAME: &str = if cfg!(target_os = "windows") {
    "CodeWalkerBridge.exe"
} else {
    "CodeWalkerBridge"
};
/// Ops that never touch the GTA archives: user `.ytd` exports and user `.ycd` clips.
const BRIDGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Ops that may trigger the one-time GTA archive scan, or a full model parse.
const BRIDGE_HEAVY_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const BRIDGE_STDERR_TAIL_LINES: usize = 40;
/// Exact rejection text of a cancelled request, so callers can tell a
/// cancellation from a failure.
const BRIDGE_CANCELLED: &str = "Bridge request cancelled.";
const BRIDGE_CLOSING: &str = "Cortex Studio is closing; the CodeWalker bridge was stopped.";

/// Parse revision in the `yft-cache` key. v18: an entry is complete only when
/// `model.clmesh`, `manifest.json` and `meta.json` (written last) exist, and is
/// reused only while every file the bridge read for it is unchanged. v19: a
/// texture dictionary the resource streams is no longer also read from the game
/// files (manifest v12), so v18 entries that list the game copy are not reused.
const PARSE_YFT_CACHE_REVISION: &[u8] = b"parse_yft_v19";
/// Bridge warnings kept per parse; the rest are summarised in one line.
const MAX_PARSE_WARNINGS: usize = 100;

const YFT_CACHE_TRIGGER_BYTES: u64 = 1536 * 1024 * 1024; // 1.5 GB
const YFT_CACHE_TARGET_BYTES: u64 = 1024 * 1024 * 1024; // 1 GB
const YTD_CACHE_TRIGGER_BYTES: u64 = 500 * 1024 * 1024; // 500 MB
const YTD_CACHE_TARGET_BYTES: u64 = 350 * 1024 * 1024; // 350 MB
const CACHE_LAST_USED_FILE: &str = "last-used";
/// Entries and shared objects used this recently are never evicted.
const CACHE_RECENT_USE: Duration = Duration::from_secs(600);

const DEFAULT_UPDATER_ENDPOINT: &str =
    "https://github.com/IEver3st/cortex-labs/releases/latest/download/latest.json";

/// Serializes cache mutations (parse output, eviction) across threads.
static CACHE_LOCK: Mutex<()> = Mutex::new(());
static CACHE_MAINTENANCE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Locks a mutex whose data stays valid after a panic elsewhere.
fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Models the CodeWalker bridge parses: fragments, drawables and drawable dictionaries.
fn is_bridge_model(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("yft")
                || ext.eq_ignore_ascii_case("ydr")
                || ext.eq_ignore_ascii_case("ydd")
        })
        .unwrap_or(false)
}

fn has_extension(path: &str, wanted: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(wanted))
        .unwrap_or(false)
}

fn is_supported_open_model(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("yft")
                || ext.eq_ignore_ascii_case("ydd")
                || ext.eq_ignore_ascii_case("ydr")
                || ext.eq_ignore_ascii_case("dff")
                || ext.eq_ignore_ascii_case("clmesh")
        })
        .unwrap_or(false)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn normalize_open_file_arg(raw: &str) -> Option<String> {
    let mut candidate = raw.trim().trim_matches('"').to_string();
    if candidate.is_empty() {
        return None;
    }

    if let Some(rest) = candidate.strip_prefix("file://") {
        let mut normalized = percent_decode(rest);
        if cfg!(windows) {
            if normalized.starts_with('/') && normalized.chars().nth(2) == Some(':') {
                normalized = normalized.chars().skip(1).collect();
            }
            normalized = normalized.replace('/', "\\");
        }
        candidate = normalized;
    }

    Some(candidate)
}

fn extract_open_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter_map(|arg| normalize_open_file_arg(arg))
        .find(|arg| {
            is_supported_open_model(arg) && Path::new(arg).exists() && Path::new(arg).is_file()
        })
}

fn queue_open_file(app: &tauri::AppHandle, file_path: String) {
    if !is_supported_open_model(&file_path) {
        return;
    }

    {
        let state = app.state::<PendingOpenFileState>();
        let mut pending = state
            .path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *pending = Some(file_path.clone());
    }

    let _ = app.emit("file-open", file_path);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// One keyed watcher per workflow slot. Keys: `texture`, `window`, `multi`.
/// All slots emit `texture:update` with the same payload.
#[derive(Default)]
struct WatchState {
    watchers: Mutex<HashMap<&'static str, (RecommendedWatcher, Vec<PathBuf>)>>,
}

/// EUP Studio watchers keyed by the tab-supplied id, so several EUP tabs can
/// watch their own sources. Folders are watched recursively (stream/ subfolders).
#[derive(Default)]
struct EupWatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(serde::Serialize, Clone)]
struct EupWatchPayload {
    id: String,
    paths: Vec<String>,
}

const EUP_WATCH_MAX_PATHS: usize = 256;

#[derive(Default)]
struct PendingOpenFileState {
    path: Mutex<Option<String>>,
}

#[derive(serde::Serialize, Clone)]
struct WatchPayload {
    path: String,
    kind: String,
}

#[derive(serde::Deserialize)]
struct UpdaterFeedPlatform {
    url: Option<String>,
}

#[derive(serde::Deserialize)]
struct UpdaterFeed {
    version: Option<String>,
    pub_date: Option<String>,
    platforms: Option<HashMap<String, UpdaterFeedPlatform>>,
}

fn configured_updater_endpoint(app: &tauri::AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .and_then(|endpoints| endpoints.first())
        .and_then(|endpoint| endpoint.as_str())
        .map(|endpoint| endpoint.trim().to_string())
        .filter(|endpoint| !endpoint.is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATER_ENDPOINT.to_string())
}

/// The `endpoint` argument is accepted for JS compatibility and ignored; the
/// feed URL always comes from `tauri.conf.json`.
#[tauri::command]
async fn inspect_updater_release(
    endpoint: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let _ = endpoint;
    let endpoint = configured_updater_endpoint(&app);

    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(format!(
                "{}/{}",
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|e| format!("Failed to build updater client: {e}"))?;

        let feed = client
            .get(&endpoint)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|e| format!("Failed to fetch updater feed: {e}"))?
            .json::<UpdaterFeed>()
            .map_err(|e| format!("Failed to parse updater feed: {e}"))?;

        let version = feed.version.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

        let pub_date = feed.pub_date.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

        let url = feed.platforms.and_then(|platforms| {
            platforms.into_values().find_map(|platform| {
                platform.url.and_then(|value| {
                    let trimmed = value.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                })
            })
        });

        Ok(serde_json::json!({
            "version": version,
            "pubDate": pub_date,
            "url": url,
        }))
    })
    .await
    .map_err(|e| format!("Failed to join updater inspection task: {e}"))?
}

/// A path the watcher could not register, with the reason.
#[derive(serde::Serialize, Clone, Debug)]
struct WatchFailure {
    path: String,
    error: String,
}

/// Replaces the slot's watcher. Watches every path it can and returns the ones
/// it could not; fails only when nothing at all could be watched.
fn replace_watch(
    app: &tauri::AppHandle,
    state: &WatchState,
    key: &'static str,
    paths: Vec<PathBuf>,
) -> Result<Vec<WatchFailure>, String> {
    let mut guard = state
        .watchers
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;

    if let Some((mut existing, prev_paths)) = guard.remove(key) {
        for prev_path in prev_paths {
            let _ = existing.unwatch(&prev_path);
        }
    }

    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let app_handle = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let payload = WatchPayload {
                    path: event
                        .paths
                        .first()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    kind: format!("{:?}", event.kind),
                };
                let _ = app_handle.emit("texture:update", payload);
            }
        })
        .map_err(|e| e.to_string())?;

    let mut watched = Vec::with_capacity(paths.len());
    let mut failures = Vec::new();
    for path_buf in paths {
        match watcher.watch(&path_buf, RecursiveMode::NonRecursive) {
            Ok(()) => watched.push(path_buf),
            Err(error) => failures.push(WatchFailure {
                path: path_buf.to_string_lossy().into_owned(),
                error: error.to_string(),
            }),
        }
    }
    if watched.is_empty() {
        return Err(failures
            .iter()
            .map(|failure| format!("Could not watch {}: {}", failure.path, failure.error))
            .collect::<Vec<_>>()
            .join("; "));
    }

    guard.insert(key, (watcher, watched));
    Ok(failures)
}

fn clear_watch(state: &WatchState, key: &'static str) -> Result<(), String> {
    let mut guard = state
        .watchers
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;

    if let Some((mut watcher, prev_paths)) = guard.remove(key) {
        for prev_path in prev_paths {
            let _ = watcher.unwatch(&prev_path);
        }
    }

    Ok(())
}

#[tauri::command]
fn start_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<WatchState>,
) -> Result<(), String> {
    replace_watch(&app, &state, "texture", vec![PathBuf::from(path)]).map(|_| ())
}

#[tauri::command]
fn stop_watch(state: State<WatchState>) -> Result<(), String> {
    clear_watch(&state, "texture")
}

#[tauri::command]
fn start_window_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<WatchState>,
) -> Result<(), String> {
    replace_watch(&app, &state, "window", vec![PathBuf::from(path)]).map(|_| ())
}

#[tauri::command]
fn stop_window_watch(state: State<WatchState>) -> Result<(), String> {
    clear_watch(&state, "window")
}

/// Watches every Multi livery it can. Resolves `{ unwatched: [{ path, error }] }`
/// so the UI can name the files that will not live-reload; rejects only when
/// none of them could be watched.
#[tauri::command]
fn start_multi_watch(
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<WatchState>,
) -> Result<serde_json::Value, String> {
    let mut unique: Vec<PathBuf> = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !unique.contains(&path) {
            unique.push(path);
        }
    }

    let unwatched = replace_watch(&app, &state, "multi", unique)?;
    Ok(serde_json::json!({ "unwatched": unwatched }))
}

#[tauri::command]
fn stop_multi_watch(state: State<WatchState>) -> Result<(), String> {
    clear_watch(&state, "multi")
}

fn validate_eup_watch_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("EUP watch id must be 1-64 characters of [A-Za-z0-9_-].".to_string());
    }
    Ok(trimmed.to_string())
}

/// Watches the folders and files an EUP tab selected. Read-only: events only
/// tell the renderer which paths to re-read.
#[tauri::command]
fn start_eup_watch(
    id: String,
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<EupWatchState>,
) -> Result<(), String> {
    let id = validate_eup_watch_id(&id)?;
    let mut unique: Vec<PathBuf> = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    if unique.len() > EUP_WATCH_MAX_PATHS {
        return Err(format!(
            "Too many EUP sources to watch ({}; limit {EUP_WATCH_MAX_PATHS}).",
            unique.len()
        ));
    }

    let mut guard = state
        .watchers
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;
    // Dropping the previous watcher stops it.
    guard.remove(&id);
    if unique.is_empty() {
        return Ok(());
    }

    let app_handle = app.clone();
    let event_id = id.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            let _ = app_handle.emit(
                "eup:update",
                EupWatchPayload {
                    id: event_id.clone(),
                    paths,
                },
            );
        })
        .map_err(|e| e.to_string())?;

    let mut failures = Vec::new();
    for path in &unique {
        let mode = if path.is_dir() {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        if let Err(error) = watcher.watch(path, mode) {
            failures.push(format!("{}: {error}", path.display()));
        }
    }
    if failures.len() == unique.len() {
        return Err(format!(
            "Could not watch EUP sources: {}",
            failures.join("; ")
        ));
    }
    guard.insert(id, watcher);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Some EUP sources are not watched: {}",
            failures.join("; ")
        ))
    }
}

#[tauri::command]
fn stop_eup_watch(id: String, state: State<EupWatchState>) -> Result<(), String> {
    let id = validate_eup_watch_id(&id)?;
    state
        .watchers
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?
        .remove(&id);
    Ok(())
}

fn bundled_bridge_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|resource_dir| {
        resource_dir
            .join("bin")
            .join("codewalker-bridge")
            .join(BRIDGE_EXE_NAME)
    })
}

/// Bundled resource path first; source-tree build outputs only in debug builds.
fn codewalker_bridge_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(bundled) = bundled_bridge_path(app) {
        candidates.push(bundled);
    }

    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let tools_bridge_root = manifest_dir
            .join("..")
            .join("tools")
            .join("codewalker-bridge");
        candidates.push(
            manifest_dir
                .join("bin")
                .join("codewalker-bridge")
                .join(BRIDGE_EXE_NAME),
        );
        for (configuration, framework) in [
            ("Release", "net10.0"),
            ("Debug", "net10.0"),
            ("Release", "net8.0"),
            ("Debug", "net8.0"),
        ] {
            let framework_dir = tools_bridge_root
                .join("bin")
                .join(configuration)
                .join(framework);
            candidates.push(framework_dir.join(BRIDGE_EXE_NAME));
            candidates.push(framework_dir.join("publish").join(BRIDGE_EXE_NAME));
        }
    }

    candidates
}

fn try_find_codewalker_bridge(app: &tauri::AppHandle) -> Option<PathBuf> {
    codewalker_bridge_candidates(app)
        .into_iter()
        .find(|path| path.exists())
}

#[cfg(debug_assertions)]
fn build_codewalker_bridge() -> Result<(), String> {
    let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tools")
        .join("codewalker-bridge");
    let project_file = project_dir.join("CodeWalkerBridge.csproj");

    if !project_file.exists() {
        return Err(format!(
            "Missing CodeWalker bridge executable, and source project was not found at `{}`.",
            project_file.display()
        ));
    }

    let output = Command::new("dotnet")
        .current_dir(&project_dir)
        .arg("build")
        .arg(&project_file)
        .arg("-c")
        .arg("Release")
        .arg("--nologo")
        .output()
        .map_err(|e| format!("Failed to start `dotnet build` for CodeWalker bridge: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Failed to build CodeWalker bridge with `dotnet build -c Release`.\nSTDERR:\n{}\nSTDOUT:\n{}",
        stderr.trim(),
        stdout.trim()
    ))
}

fn ensure_codewalker_bridge(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(bridge) = try_find_codewalker_bridge(app) {
        return Ok(bridge);
    }

    #[cfg(debug_assertions)]
    {
        build_codewalker_bridge()?;
        try_find_codewalker_bridge(app).ok_or_else(|| {
            let expected = codewalker_bridge_candidates(app)
                .into_iter()
                .map(|path| format!("- {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "CodeWalker bridge was built, but executable was still not found. Checked:\n{}",
                expected
            )
        })
    }

    #[cfg(not(debug_assertions))]
    {
        let expected = bundled_bridge_path(app)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| format!("<resources>/bin/codewalker-bridge/{BRIDGE_EXE_NAME}"));
        Err(format!(
            "CodeWalker bridge is missing from this installation. Expected it at `{expected}`. \
Reinstall Cortex Studio, or rebuild with `node tools/publish-bridge.mjs` before `tauri build`."
        ))
    }
}

/// Why a bridge call failed. Only `Transport` justifies retrying a parse in a
/// cold one-shot process; the other kinds would fail the same way again.
#[derive(Debug)]
enum BridgeError {
    /// The bridge executable is missing or would not start, or the app is closing.
    Unavailable(String),
    /// The process crashed, timed out or broke the protocol; it was recycled.
    Transport(String),
    /// The bridge ran the op and reported an error for this input.
    Reported(String),
    /// The caller cancelled the request with `cancel_bridge_request`.
    Cancelled,
}

impl From<BridgeError> for String {
    fn from(error: BridgeError) -> Self {
        match error {
            BridgeError::Unavailable(message)
            | BridgeError::Transport(message)
            | BridgeError::Reported(message) => message,
            BridgeError::Cancelled => BRIDGE_CANCELLED.to_string(),
        }
    }
}

/// Kills a child without waiting for it. The owner reaps it.
fn kill_child(child: &Mutex<Child>) {
    let _ = lock_ignoring_poison(child).kill();
}

/// A long-lived `CodeWalkerBridge.exe --serve` child. The bridge keeps the GTA
/// RPF index in memory, so one process per app session avoids a rescan per parse.
struct BridgeProcess {
    /// Shared with `BridgeControl` so exit and cancel can kill the process
    /// without waiting for the request lock.
    child: Arc<Mutex<Child>>,
    stdin: BufWriter<ChildStdin>,
    responses: mpsc::Receiver<std::io::Result<String>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    next_id: u64,
}

#[derive(Default)]
struct BridgeState {
    /// The serve process. Held for a whole request: the bridge answers one at a time.
    process: Mutex<Option<BridgeProcess>>,
    /// Kill handles and request ownership. Never held across a request, so exit
    /// and cancel always reach the children immediately.
    control: Mutex<BridgeControl>,
    /// Set on exit; no request starts or respawns the bridge afterwards.
    closing: AtomicBool,
}

#[derive(Default)]
struct BridgeControl {
    serve_child: Option<Arc<Mutex<Child>>>,
    /// Token of the request the serve process is working on.
    serve_token: Option<String>,
    one_shots: Vec<OneShotHandle>,
    next_one_shot: u64,
    /// Registered request tokens and whether each was cancelled.
    tickets: HashMap<String, bool>,
}

/// A running one-shot fallback parse.
struct OneShotHandle {
    id: u64,
    token: Option<String>,
    child: Arc<Mutex<Child>>,
}

impl BridgeProcess {
    fn spawn(app: &tauri::AppHandle) -> Result<Self, String> {
        let exe = ensure_codewalker_bridge(app)?;
        let mut command = Command::new(&exe);
        command
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start CodeWalker bridge `{}`: {e}", exe.display()))?;
        child_job::adopt(&child);

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "CodeWalker bridge stdin was not captured.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CodeWalker bridge stdout was not captured.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "CodeWalker bridge stderr was not captured.".to_string())?;

        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut guard = lock_ignoring_poison(&tail);
                if guard.len() >= BRIDGE_STDERR_TAIL_LINES {
                    guard.pop_front();
                }
                guard.push_back(line);
            }
        });

        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin: BufWriter::new(stdin),
            responses,
            stderr_tail,
            next_id: 0,
        })
    }

    fn is_alive(&self) -> bool {
        matches!(lock_ignoring_poison(&self.child).try_wait(), Ok(None))
    }

    fn stderr_excerpt(&self) -> String {
        lock_ignoring_poison(&self.stderr_tail)
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn shutdown(self) {
        let mut child = lock_ignoring_poison(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Outer `Err` is a transport failure (the process must be recycled);
    /// inner `Err` is an op-level error reported by the bridge.
    fn request(
        &mut self,
        op: &str,
        params: &serde_json::Value,
        timeout: Duration,
    ) -> Result<Result<serde_json::Value, String>, String> {
        self.next_id += 1;
        let id = self.next_id;

        let mut request = serde_json::Map::new();
        request.insert("id".to_string(), serde_json::Value::from(id));
        request.insert("op".to_string(), serde_json::Value::from(op));
        if let Some(object) = params.as_object() {
            for (key, value) in object {
                request.insert(key.clone(), value.clone());
            }
        }
        let line = serde_json::Value::Object(request).to_string();

        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Failed to send `{op}` to CodeWalker bridge: {e}"))?;

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "CodeWalker bridge `{op}` timed out after {}s.",
                    timeout.as_secs()
                ));
            }

            let text = match self.responses.recv_timeout(remaining) {
                Ok(Ok(text)) => text,
                Ok(Err(e)) => {
                    return Err(format!("Failed to read CodeWalker bridge output: {e}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "CodeWalker bridge `{op}` timed out after {}s.",
                        timeout.as_secs()
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "CodeWalker bridge exited during `{op}`.\n{}",
                        self.stderr_excerpt()
                    ));
                }
            };

            let response = match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value) => value,
                Err(e) => {
                    return Err(format!(
                        "CodeWalker bridge wrote a non-JSON line: {e}\n{}",
                        text.chars().take(200).collect::<String>()
                    ));
                }
            };

            if response.get("id").and_then(|v| v.as_u64()) != Some(id) {
                // Response to an earlier timed-out request; skip it.
                continue;
            }

            if response.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                return Ok(Ok(response
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null)));
            }

            let message = response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown bridge error")
                .to_string();
            return Ok(Err(message));
        }
    }
}

/// Request tokens are caller-generated ids such as `crypto.randomUUID()`.
fn validate_request_token(token: &str) -> Result<String, String> {
    let trimmed = token.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Request token must be 1-64 characters of [A-Za-z0-9_-].".to_string());
    }
    Ok(trimmed.to_string())
}

/// A caller's claim on a request token, registered for the whole command so a
/// cancel that arrives while the request waits its turn still stops it.
struct BridgeTicket {
    app: tauri::AppHandle,
    token: Option<String>,
}

impl BridgeTicket {
    fn register(app: &tauri::AppHandle, token: Option<String>) -> Result<Self, String> {
        let token = token.as_deref().map(validate_request_token).transpose()?;
        if let Some(token) = &token {
            let state = app.state::<BridgeState>();
            let mut control = lock_ignoring_poison(&state.control);
            if control.tickets.contains_key(token) {
                return Err("This request token is already in use.".to_string());
            }
            control.tickets.insert(token.clone(), false);
        }
        Ok(Self {
            app: app.clone(),
            token,
        })
    }

    fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    fn cancelled(&self) -> bool {
        let Some(token) = &self.token else {
            return false;
        };
        let state = self.app.state::<BridgeState>();
        let control = lock_ignoring_poison(&state.control);
        control.tickets.get(token).copied().unwrap_or(false)
    }
}

impl Drop for BridgeTicket {
    fn drop(&mut self) {
        if let (Some(token), Some(state)) = (&self.token, self.app.try_state::<BridgeState>()) {
            lock_ignoring_poison(&state.control).tickets.remove(token);
        }
    }
}

/// Drops a serve process and forgets its kill handle.
fn retire_serve_process(state: &BridgeState, process: BridgeProcess) {
    {
        let mut control = lock_ignoring_poison(&state.control);
        if control
            .serve_child
            .as_ref()
            .is_some_and(|child| Arc::ptr_eq(child, &process.child))
        {
            control.serve_child = None;
        }
    }
    process.shutdown();
}

/// Sends one request to the serve-mode bridge, spawning it on first use and
/// recycling it after any transport failure so the next call starts clean.
fn bridge_call(
    app: &tauri::AppHandle,
    op: &str,
    params: serde_json::Value,
    timeout: Duration,
    ticket: Option<&BridgeTicket>,
) -> Result<serde_json::Value, BridgeError> {
    let state = app.state::<BridgeState>();
    let cancelled = || ticket.is_some_and(BridgeTicket::cancelled);
    let closing = || state.closing.load(Ordering::Acquire);
    if cancelled() {
        return Err(BridgeError::Cancelled);
    }

    let mut guard = lock_ignoring_poison(&state.process);
    if cancelled() {
        return Err(BridgeError::Cancelled);
    }
    if closing() {
        return Err(BridgeError::Unavailable(BRIDGE_CLOSING.to_string()));
    }

    if guard.as_ref().is_some_and(|process| !process.is_alive()) {
        if let Some(dead) = guard.take() {
            retire_serve_process(&state, dead);
        }
    }

    if guard.is_none() {
        let process = BridgeProcess::spawn(app).map_err(BridgeError::Unavailable)?;
        lock_ignoring_poison(&state.control).serve_child = Some(Arc::clone(&process.child));
        if closing() {
            // Exit raced the spawn and could not see this child.
            retire_serve_process(&state, process);
            return Err(BridgeError::Unavailable(BRIDGE_CLOSING.to_string()));
        }
        *guard = Some(process);
    }

    let Some(process) = guard.as_mut() else {
        return Err(BridgeError::Unavailable(
            "CodeWalker bridge is unavailable.".to_string(),
        ));
    };

    {
        // Checked and claimed under the control lock, so a cancel either sees
        // this request running (and kills it) or is seen here.
        let mut control = lock_ignoring_poison(&state.control);
        let token = ticket.and_then(BridgeTicket::token);
        if token.is_some_and(|token| control.tickets.get(token).copied().unwrap_or(false)) {
            return Err(BridgeError::Cancelled);
        }
        control.serve_token = token.map(str::to_string);
    }
    let outcome = process.request(op, &params, timeout);
    lock_ignoring_poison(&state.control).serve_token = None;

    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(BridgeError::Reported(message)),
        Err(transport_error) => {
            let excerpt = process.stderr_excerpt();
            if let Some(broken) = guard.take() {
                retire_serve_process(&state, broken);
            }
            if cancelled() {
                return Err(BridgeError::Cancelled);
            }
            if closing() {
                return Err(BridgeError::Unavailable(BRIDGE_CLOSING.to_string()));
            }
            Err(BridgeError::Transport(if excerpt.is_empty() {
                transport_error
            } else {
                format!("{transport_error}\nBridge stderr:\n{excerpt}")
            }))
        }
    }
}

/// `bridge_call` for commands that only need the message.
fn bridge_request(
    app: &tauri::AppHandle,
    op: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    bridge_call(app, op, params, timeout, None).map_err(String::from)
}

/// Cancels the caller's own bridge request. Resolves `"running"` when the
/// bridge was working on it (the process is killed and respawns on the next
/// request), `"queued"` when it had not started (it rejects when its turn
/// comes), or `"none"` when the token is unknown or already finished.
#[tauri::command]
fn cancel_bridge_request(token: String, app: tauri::AppHandle) -> Result<&'static str, String> {
    let token = validate_request_token(&token)?;
    let state = app.state::<BridgeState>();
    let mut control = lock_ignoring_poison(&state.control);
    let Some(cancelled) = control.tickets.get_mut(&token) else {
        return Ok("none");
    };
    *cancelled = true;
    if control.serve_token.as_deref() == Some(token.as_str()) {
        if let Some(child) = &control.serve_child {
            kill_child(child);
        }
        return Ok("running");
    }
    let mut running = false;
    for one_shot in &control.one_shots {
        if one_shot.token.as_deref() == Some(token.as_str()) {
            kill_child(&one_shot.child);
            running = true;
        }
    }
    Ok(if running { "running" } else { "queued" })
}

/// Stops every bridge process at once. Never waits for the request lock: a
/// parse in flight sees its pipe break and returns, instead of holding exit.
fn shutdown_bridge(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<BridgeState>() else {
        return;
    };
    state.closing.store(true, Ordering::Release);
    {
        let control = lock_ignoring_poison(&state.control);
        if let Some(child) = &control.serve_child {
            kill_child(child);
        }
        for one_shot in &control.one_shots {
            kill_child(&one_shot.child);
        }
    }
    let idle = match state.process.try_lock() {
        Ok(mut guard) => guard.take(),
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().take(),
        Err(TryLockError::WouldBlock) => None,
    };
    if let Some(process) = idle {
        retire_serve_process(&state, process);
    }
}

fn app_cache_root(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {e}"))?
        .join("cortex-labs")
        .join(name))
}

fn file_identity(path: &str) -> Result<(u64, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to stat input: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((mtime, meta.len()))
}

fn cache_key(revision: &[u8], path: &str, mtime: u64, size: u64) -> String {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(revision);
    hasher.write(path.as_bytes());
    hasher.write_u64(mtime);
    hasher.write_u64(size);
    format!("{:016x}", hasher.finish())
}

/// Opens a directory handle that permits updating its timestamps.
fn open_dir_for_touch(dir: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(dir)
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::File::open(dir)
    }
}

/// Marks a cache entry as recently used for LRU eviction. Directory mtime is
/// preferred; a `last-used` marker file is the fallback when it cannot be set.
fn touch_cache_entry(dir: &Path) {
    let now = SystemTime::now();
    let touched = open_dir_for_touch(dir)
        .and_then(|file| file.set_modified(now))
        .is_ok();
    if !touched {
        let _ = std::fs::write(dir.join(CACHE_LAST_USED_FILE), b"");
    }
}

fn cache_entry_last_used(dir: &Path) -> SystemTime {
    let dir_time = std::fs::metadata(dir)
        .and_then(|meta| meta.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let marker_time = std::fs::metadata(dir.join(CACHE_LAST_USED_FILE))
        .and_then(|meta| meta.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    dir_time.max(marker_time)
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn list_cache_entries(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_dir()
                        && path
                            .file_name()
                            .is_some_and(|name| !name.to_string_lossy().starts_with('.'))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Original input path of a complete entry, from its `meta.json`. An entry
/// still being written has no `meta.json`, so dedup never touches it.
fn completed_entry_input_path(dir: &Path) -> Option<String> {
    read_json_file(&dir.join("meta.json"))?
        .get("inputPath")
        .and_then(|v| v.as_str())
        .filter(|input| !input.trim().is_empty())
        .map(str::to_string)
}

fn normalize_input_key(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn remove_cache_entry(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        eprintln!("[cache] failed to remove {}: {e}", dir.display());
    }
}

fn is_recent(time: SystemTime) -> bool {
    SystemTime::now()
        .duration_since(time)
        .is_ok_and(|age| age < CACHE_RECENT_USE)
        || time > SystemTime::now()
}

/// Keeps only the newest complete entry per input path. Scans without the
/// cache lock; each deletion takes it and skips an entry used since the scan.
fn evict_duplicate_inputs(root: &Path) {
    let mut groups: HashMap<String, Vec<(PathBuf, SystemTime)>> = HashMap::new();
    for dir in list_cache_entries(root) {
        let Some(input) = completed_entry_input_path(&dir) else {
            continue;
        };
        let last_used = cache_entry_last_used(&dir);
        groups
            .entry(normalize_input_key(&input))
            .or_default()
            .push((dir, last_used));
    }

    for (_, mut group) in groups {
        if group.len() < 2 {
            continue;
        }
        group.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        for (dir, scanned) in group.into_iter().skip(1) {
            let _guard = lock_ignoring_poison(&CACHE_LOCK);
            if cache_entry_last_used(&dir) > scanned {
                continue;
            }
            remove_cache_entry(&dir);
        }
    }
}

/// One cache entry as seen by the eviction scan.
struct CacheEntryScan {
    dir: PathBuf,
    last_used: SystemTime,
    size: u64,
    shared_refs: HashSet<String>,
}

/// Shared DDS objects by file name: size and whether the grace period passed.
fn scan_shared_textures(root: &Path) -> HashMap<String, (u64, bool)> {
    let Ok(entries) = std::fs::read_dir(root.join(".shared-textures")) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let old = !meta.modified().map(is_recent).unwrap_or(true);
            Some((
                entry.file_name().to_string_lossy().into_owned(),
                (meta.len(), old),
            ))
        })
        .collect()
}

/// When the cache exceeds `trigger`, removes least recently used entries until
/// under `target`. Shared DDS objects count toward the budget: an entry's
/// removal also frees the objects only it referenced. Sizes and manifests are
/// read once without the cache lock; each deletion takes the lock and skips an
/// entry used in the last ten minutes. Freed shared objects are deleted by the
/// `prune_shared_textures` pass that follows.
fn evict_lru(root: &Path, trigger: u64, target: u64) {
    let mut total = dir_size_bytes(root);
    if total <= trigger {
        return;
    }

    let shared = scan_shared_textures(root);
    let mut entries: Vec<CacheEntryScan> = list_cache_entries(root)
        .into_iter()
        .map(|dir| {
            let mut shared_refs = HashSet::new();
            if !shared.is_empty() {
                if let Some(manifest) = read_json_file(&dir.join("manifest.json")) {
                    collect_shared_texture_refs(&manifest, &mut shared_refs);
                }
            }
            CacheEntryScan {
                last_used: cache_entry_last_used(&dir),
                size: dir_size_bytes(&dir),
                dir,
                shared_refs,
            }
        })
        .collect();

    let mut references: HashMap<String, usize> = HashMap::new();
    for entry in &entries {
        for name in &entry.shared_refs {
            *references.entry(name.clone()).or_default() += 1;
        }
    }
    for (name, (size, old)) in &shared {
        if *old && !references.contains_key(name) {
            total = total.saturating_sub(*size);
        }
    }

    entries.sort_by_key(|entry| entry.last_used);
    for entry in entries {
        if total <= target {
            break;
        }
        {
            let _guard = lock_ignoring_poison(&CACHE_LOCK);
            if is_recent(cache_entry_last_used(&entry.dir)) {
                continue;
            }
            remove_cache_entry(&entry.dir);
        }
        total = total.saturating_sub(entry.size);
        for name in &entry.shared_refs {
            let Some(count) = references.get_mut(name) else {
                continue;
            };
            *count = count.saturating_sub(1);
            if *count == 0 {
                if let Some((size, true)) = shared.get(name) {
                    total = total.saturating_sub(*size);
                }
            }
        }
    }
}

/// Removes other complete cache entries produced from the same input (older
/// revisions or stale mtimes), keeping `keep_key`. Caller holds `CACHE_LOCK`.
fn evict_other_entries_for_input(root: &Path, keep_key: &str, input_path: &str) {
    let wanted = normalize_input_key(input_path);
    for dir in list_cache_entries(root) {
        if dir.file_name().and_then(|n| n.to_str()) == Some(keep_key) {
            continue;
        }
        if completed_entry_input_path(&dir)
            .map(|input| normalize_input_key(&input) == wanted)
            .unwrap_or(false)
        {
            remove_cache_entry(&dir);
        }
    }
}

fn collect_shared_texture_refs(value: &serde_json::Value, refs: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(path) if path.contains(".shared-textures/") => {
            if let Some(name) = path.rsplit('/').next() {
                refs.insert(name.to_string());
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_shared_texture_refs(value, refs);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_shared_texture_refs(value, refs);
            }
        }
        _ => {}
    }
}

/// Deletes shared DDS objects no manifest references. References are read
/// once without the cache lock: a parse that reuses an object refreshes its
/// mtime before writing its manifest, so the age check made under the lock
/// keeps anything an in-flight parse may still reference.
fn prune_shared_textures(root: &Path) {
    let shared = root.join(".shared-textures");
    if !shared.is_dir() {
        return;
    }
    let mut refs = HashSet::new();
    for dir in list_cache_entries(root) {
        if let Some(manifest) = read_json_file(&dir.join("manifest.json")) {
            collect_shared_texture_refs(&manifest, &mut refs);
        }
    }
    let Ok(entries) = std::fs::read_dir(&shared) else {
        return;
    };
    for entry in entries.flatten() {
        if refs.contains(entry.file_name().to_string_lossy().as_ref()) {
            continue;
        }
        let path = entry.path();
        let _guard = lock_ignoring_poison(&CACHE_LOCK);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.modified().map(is_recent).unwrap_or(true) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            eprintln!(
                "[cache] cannot remove shared texture {}: {error}",
                path.display()
            );
        }
    }
}

/// Background cache maintenance at startup and after new exports. `ped-cache`,
/// `prop-cache`, `vehicle-cache` and `plate-cache` are never evicted.
fn run_cache_maintenance(app: &tauri::AppHandle) {
    let (Ok(yft_root), Ok(ytd_root)) = (
        app_cache_root(app, "yft-cache"),
        app_cache_root(app, "ytd-cache"),
    ) else {
        return;
    };

    if CACHE_MAINTENANCE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }

    std::thread::spawn(move || {
        if yft_root.is_dir() {
            evict_duplicate_inputs(&yft_root);
            evict_lru(&yft_root, YFT_CACHE_TRIGGER_BYTES, YFT_CACHE_TARGET_BYTES);
            prune_shared_textures(&yft_root);
        }
        if ytd_root.is_dir() {
            evict_lru(&ytd_root, YTD_CACHE_TRIGGER_BYTES, YTD_CACHE_TARGET_BYTES);
        }
        CACHE_MAINTENANCE_RUNNING.store(false, Ordering::Release);
    });
}

fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// Cold `CodeWalkerBridge.exe --input --output` run, used only when the serve
/// process failed at the transport level. Same timeout as a serve parse; the
/// child is killed on timeout, cancel and exit.
fn run_bridge_one_shot(
    app: &tauri::AppHandle,
    input: &str,
    out_mesh: &Path,
    ticket: &BridgeTicket,
) -> Result<serde_json::Value, BridgeError> {
    let bridge = ensure_codewalker_bridge(app).map_err(BridgeError::Unavailable)?;
    let mut command = Command::new(&bridge);
    command
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(out_mesh)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| BridgeError::Unavailable(format!("Failed to run CodeWalker bridge: {e}")))?;
    child_job::adopt(&child);

    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let child = Arc::new(Mutex::new(child));
    let state = app.state::<BridgeState>();
    let id = {
        let mut control = lock_ignoring_poison(&state.control);
        control.next_one_shot += 1;
        let id = control.next_one_shot;
        control.one_shots.push(OneShotHandle {
            id,
            token: ticket.token().map(str::to_string),
            child: Arc::clone(&child),
        });
        id
    };
    // A cancel or exit before registration could not see this child.
    if ticket.cancelled() || state.closing.load(Ordering::Acquire) {
        kill_child(&child);
    }

    let deadline = Instant::now() + BRIDGE_HEAVY_REQUEST_TIMEOUT;
    let mut timed_out = false;
    let status = loop {
        let mut guard = lock_ignoring_poison(&child);
        match guard.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = guard.kill();
                break guard.wait();
            }
            Ok(None) => {}
            Err(error) => break Err(error),
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(50));
    };
    lock_ignoring_poison(&state.control)
        .one_shots
        .retain(|handle| handle.id != id);
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();

    if ticket.cancelled() {
        return Err(BridgeError::Cancelled);
    }
    if state.closing.load(Ordering::Acquire) {
        return Err(BridgeError::Unavailable(BRIDGE_CLOSING.to_string()));
    }
    let status = status.map_err(|e| {
        BridgeError::Transport(format!("Failed to wait for the CodeWalker bridge: {e}"))
    })?;
    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);
    if timed_out {
        return Err(BridgeError::Transport(format!(
            "CodeWalker bridge timed out after {}s and was stopped.\nSTDERR:\n{}",
            BRIDGE_HEAVY_REQUEST_TIMEOUT.as_secs(),
            last_lines(&stderr, BRIDGE_STDERR_TAIL_LINES)
        )));
    }
    if !status.success() {
        return Err(BridgeError::Reported(format!(
            "CodeWalker bridge failed ({status}).\nSTDERR:\n{}\nSTDOUT:\n{}",
            last_lines(&stderr, BRIDGE_STDERR_TAIL_LINES),
            last_lines(&stdout, 10)
        )));
    }
    match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(BridgeError::Reported(format!(
            "CodeWalker bridge exited without a parse summary.\nSTDOUT:\n{}\nSTDERR:\n{}",
            last_lines(&stdout, 10),
            last_lines(&stderr, BRIDGE_STDERR_TAIL_LINES)
        ))),
    }
}

/// One mutex per cache key, so two callers parsing the same model take turns
/// and the second reuses the first one's entry. Entries drop with their last user.
fn parse_key_lock(key: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = lock_ignoring_poison(LOCKS.get_or_init(Default::default));
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(existing) = locks.get(key).and_then(Weak::upgrade) {
        return existing;
    }
    let fresh = Arc::new(Mutex::new(()));
    locks.insert(key.to_string(), Arc::downgrade(&fresh));
    fresh
}

/// True while every file the bridge read for an entry, and every candidate it
/// looked for and did not find, is as it was during the parse.
fn cache_inputs_unchanged(meta: &serde_json::Value) -> bool {
    let Some(inputs) = meta.get("inputs").and_then(|v| v.as_array()) else {
        return false;
    };
    inputs.iter().all(|input| {
        let Some(path) = input.get("path").and_then(|v| v.as_str()) else {
            return false;
        };
        if input.get("missing").and_then(|v| v.as_bool()) == Some(true) {
            return !Path::new(path).exists();
        }
        let (Some(mtime), Some(size)) = (
            input.get("mtimeMs").and_then(|v| v.as_u64()),
            input.get("size").and_then(|v| v.as_u64()),
        ) else {
            return false;
        };
        file_identity(path).is_ok_and(|identity| identity == (mtime, size))
    })
}

/// The entry's `meta.json` when the entry is complete and still current.
fn read_complete_parse_entry(dir: &Path) -> Option<serde_json::Value> {
    if !dir.join("model.clmesh").is_file() || !dir.join("manifest.json").is_file() {
        return None;
    }
    let meta = read_json_file(&dir.join("meta.json"))?;
    (meta.is_object() && cache_inputs_unchanged(&meta)).then_some(meta)
}

fn write_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut staging = path.as_os_str().to_owned();
    staging.push(".tmp");
    let staging = PathBuf::from(staging);
    std::fs::write(&staging, bytes)?;
    std::fs::rename(&staging, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&staging);
    })
}

/// Bridge warnings as short strings, capped at `MAX_PARSE_WARNINGS`.
fn normalize_warnings(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let mut warnings: Vec<String> = value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if warnings.len() > MAX_PARSE_WARNINGS {
        let extra = warnings.len() - (MAX_PARSE_WARNINGS - 1);
        warnings.truncate(MAX_PARSE_WARNINGS - 1);
        warnings.push(format!("{extra} more warnings were not listed."));
    }
    warnings.into_iter().map(serde_json::Value::from).collect()
}

/// Checks the bridge output and writes `meta.json` last: its presence is what
/// marks the entry complete.
fn finish_parse_entry(
    out_dir: &Path,
    input_path: &str,
    meta: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let serde_json::Value::Object(mut meta) = meta else {
        return Err("CodeWalker bridge returned no parse summary.".to_string());
    };
    if !out_dir.join("model.clmesh").is_file() {
        return Err("CodeWalker bridge did not produce mesh cache output.".to_string());
    }
    if !out_dir.join("manifest.json").is_file() {
        return Err("CodeWalker bridge did not write the model manifest.".to_string());
    }
    meta.insert(
        "inputPath".to_string(),
        serde_json::Value::from(input_path.to_string()),
    );
    let warnings = normalize_warnings(meta.get("warnings"));
    meta.insert("warnings".to_string(), serde_json::Value::Array(warnings));
    if !meta.get("inputs").is_some_and(|v| v.is_array()) {
        // An older bridge build records nothing; the model file itself is
        // still covered by the cache key.
        meta.insert("inputs".to_string(), serde_json::json!([]));
    }
    let meta = serde_json::Value::Object(meta);
    write_file_atomically(&out_dir.join("meta.json"), meta.to_string().as_bytes())
        .map_err(|e| format!("Failed to finish the model cache entry: {e}"))?;
    Ok(meta)
}

fn parse_yft_result(
    out_dir: &Path,
    key: &str,
    cached: bool,
    meta: serde_json::Value,
) -> serde_json::Value {
    let warnings = meta
        .get("warnings")
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::json!({
        "meshPath": out_dir.join("model.clmesh").to_string_lossy().to_string(),
        "manifestPath": out_dir.join("manifest.json").to_string_lossy().to_string(),
        "cacheKey": key,
        "cached": cached,
        "meta": meta,
        "warnings": warnings,
    })
}

fn reset_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| format!("Failed to clear a partial model cache entry: {e}"))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create output dir: {e}"))
}

/// Serve-mode parse, retried once in a cold one-shot process only when the
/// serve process itself failed (crash, timeout, broken protocol). A model the
/// bridge rejected, a cancel, or a missing bridge is reported as is.
fn run_parse_yft(
    app: &tauri::AppHandle,
    path: &str,
    out_dir: &Path,
    out_mesh: &Path,
    ticket: &BridgeTicket,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "input": path,
        "output": out_mesh.to_string_lossy().to_string(),
    });
    match bridge_call(
        app,
        "parseYft",
        params,
        BRIDGE_HEAVY_REQUEST_TIMEOUT,
        Some(ticket),
    ) {
        Ok(meta) => Ok(meta),
        Err(BridgeError::Transport(serve_error)) => {
            eprintln!(
                "[bridge] serve-mode parse failed, retrying in a one-shot process: {serve_error}"
            );
            reset_dir(out_dir)?;
            run_bridge_one_shot(app, path, out_mesh, ticket).map_err(|error| match error {
                BridgeError::Cancelled => BRIDGE_CANCELLED.to_string(),
                other => format!("{}\n(serve mode error: {serve_error})", String::from(other)),
            })
        }
        Err(other) => Err(other.into()),
    }
}

/// `force` discards the entry and parses again. Without it, an entry is reused
/// while the model (cache key) and every file the bridge read are unchanged.
fn parse_yft_blocking(
    app: &tauri::AppHandle,
    path: &str,
    force: bool,
    request_token: Option<String>,
) -> Result<serde_json::Value, String> {
    if !is_bridge_model(path) {
        return Err("Only .yft, .ydr and .ydd models are supported by parse_yft".to_string());
    }

    if !cfg!(target_os = "windows") {
        return Err("YFT parsing is only supported on Windows in this build.".to_string());
    }

    let ticket = BridgeTicket::register(app, request_token)?;
    let cache_root = app_cache_root(app, "yft-cache")?;
    std::fs::create_dir_all(&cache_root).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let (mtime, size) = file_identity(path)?;
    let key = cache_key(PARSE_YFT_CACHE_REVISION, path, mtime, size);
    let key_lock = parse_key_lock(&key);
    let _parsing = lock_ignoring_poison(&key_lock);
    if ticket.cancelled() {
        return Err(BRIDGE_CANCELLED.to_string());
    }

    let out_dir = cache_root.join(&key);
    let out_mesh = out_dir.join("model.clmesh");
    {
        // Hold the cache lock so maintenance cannot remove the entry between
        // this check and the renderer reading it.
        let _guard = lock_ignoring_poison(&CACHE_LOCK);
        if !force {
            if let Some(meta) = read_complete_parse_entry(&out_dir) {
                touch_cache_entry(&out_dir);
                return Ok(parse_yft_result(&out_dir, &key, true, meta));
            }
        }
        // Forced, stale, or left incomplete by an interrupted parse.
        if out_dir.exists() {
            std::fs::remove_dir_all(&out_dir)
                .map_err(|e| format!("Failed to clear the model cache for a re-parse: {e}"))?;
        }
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("Failed to create output dir: {e}"))?;
    }

    let parsed = run_parse_yft(app, path, &out_dir, &out_mesh, &ticket)
        .and_then(|meta| finish_parse_entry(&out_dir, path, meta));
    let meta = match parsed {
        Ok(meta) => meta,
        Err(error) => {
            let _guard = lock_ignoring_poison(&CACHE_LOCK);
            if out_dir.exists() {
                remove_cache_entry(&out_dir);
            }
            return Err(error);
        }
    };

    {
        let _guard = lock_ignoring_poison(&CACHE_LOCK);
        evict_other_entries_for_input(&cache_root, &key, path);
    }

    run_cache_maintenance(app);

    Ok(parse_yft_result(&out_dir, &key, false, meta))
}

/// `parse_yft({ path, force?, requestToken? })`. A `requestToken` lets the
/// caller stop this parse with `cancel_bridge_request`.
#[tauri::command]
async fn parse_yft(
    path: String,
    force: Option<bool>,
    request_token: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        parse_yft_blocking(&app, &path, force.unwrap_or(false), request_token)
    })
    .await
    .map_err(|e| format!("Failed to join YFT parse task: {e}"))?
}

/// Builds the bridge's shared GTA texture index ahead of the first mod part.
/// The RPF scan takes seconds, and when the vehicle itself came from the parse
/// cache it would otherwise land on the first part the user fits. Skipped when
/// no bridge executable exists, so it never starts a development build.
#[tauri::command]
async fn warm_codewalker_bridge(app: tauri::AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if try_find_codewalker_bridge(&app).is_none() {
            return Ok(());
        }
        bridge_request(
            &app,
            "warmSharedTextures",
            serde_json::json!({}),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("Failed to join bridge warm-up task: {e}"))?
}

#[tauri::command]
async fn allow_model_resource(path: String, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        model_resource_scope::allow(&app, Path::new(&path))
    })
    .await
    .map_err(|e| format!("Failed to prepare model resource access: {e}"))?
}

/// Re-allows an ELS VCF folder (or a VCF's folder) chosen in an earlier run.
/// Returns the folder that was allowed.
#[tauri::command]
async fn allow_els_folder(path: String, app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || els_scope::allow(&app, Path::new(&path)))
        .await
        .map_err(|e| format!("Failed to prepare ELS folder access: {e}"))?
}

/// Backs up ELS-FiveM's vcf.lua beside itself before a VCF is added to it.
#[tauri::command]
async fn backup_vcf_list(
    list: String,
    backup: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        els_scope::backup_vcf_list(&app, Path::new(&list), Path::new(&backup))
    })
    .await
    .map_err(|e| format!("Failed to back up vcf.lua: {e}"))?
}

/// Reads ELS-FiveM's pattern tables from a folder picked in this session.
#[tauri::command]
async fn read_els_pattern_tables(
    path: String,
    app: tauri::AppHandle,
) -> Result<els_scope::PatternTables, String> {
    tauri::async_runtime::spawn_blocking(move || {
        els_scope::read_pattern_tables(&app, Path::new(&path))
    })
    .await
    .map_err(|e| format!("Failed to read the pattern tables: {e}"))?
}

#[tauri::command]
async fn open_model_meta_file(
    model_path: String,
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        model_resource_scope::validate_meta_file(Path::new(&model_path), Path::new(&path))?;
        // The renderer's opener scope is independent of its filesystem scope.
        // Only this validated, user-clicked resource file reaches the native opener.
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|error| format!("Could not open metadata in its default editor: {error}"))
    })
    .await
    .map_err(|error| format!("Failed to open metadata file: {error}"))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamRename {
    from: String,
    to_name: String,
}

/// The vehicle renamer's stream file renames, validated against the selected
/// model's resource (see model_resource_scope::rename_stream_files). Rejects
/// with `{ message, rolledBack }`; `rolledBack: false` means some files kept
/// their new names because putting them back also failed.
#[tauri::command]
async fn rename_model_stream_files(
    model_path: String,
    renames: Vec<StreamRename>,
) -> Result<Vec<String>, model_resource_scope::RenameFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let list: Vec<(PathBuf, String)> = renames
            .into_iter()
            .map(|entry| (PathBuf::from(entry.from), entry.to_name))
            .collect();
        model_resource_scope::rename_stream_files(Path::new(&model_path), &list).map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
    })
    .await
    .map_err(|error| model_resource_scope::RenameFailure {
        message: format!("Failed to rename stream files: {error}"),
        // The task died mid-way, so the files' state is unknown.
        rolled_back: false,
    })?
}

/// Writes recoloured lens textures into the open model's own texture
/// dictionaries. The body is raw bytes (lens_write::parse_request). Resolves
/// `{ files: [{ path, backup, textures }] }`; rejects with a message that says
/// whether anything changed.
#[tauri::command]
async fn write_lens_textures(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The lens write must be sent as raw bytes.".into());
    };
    let body = body.clone();
    tauri::async_runtime::spawn_blocking(move || write_lens_textures_blocking(&app, &body))
        .await
        .map_err(|error| format!("The lens write stopped: {error}. Check the texture dictionaries and their backups."))?
}

/// True when the user opened `model` in Cortex (the picker or file association
/// put it in the filesystem scope), so a write to its files follows their choice.
fn model_opened(app: &tauri::AppHandle, model: &Path) -> bool {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope.is_allowed(model)
        || model
            .canonicalize()
            .is_ok_and(|path| scope.is_allowed(path))
}

fn write_lens_textures_blocking(
    app: &tauri::AppHandle,
    body: &[u8],
) -> Result<serde_json::Value, String> {
    let mut request = lens_write::parse_request(body)?;
    if !model_opened(app, &request.model) {
        return Err("Open the model in Cortex before writing its lens textures.".into());
    }
    for (index, dictionary) in request.dictionaries.iter().enumerate() {
        model_resource_scope::validate_sibling_ytd(&request.model, &dictionary.path)?;
        let same = |other: &lens_write::DictionaryWrite| {
            other.path.canonicalize().ok() == dictionary.path.canonicalize().ok()
        };
        if request.dictionaries[..index].iter().any(same) {
            return Err(format!("{} is listed twice.", dictionary.path.display()));
        }
    }
    // The bridge reads the resolved source that passed the check.
    for dictionary in &mut request.dictionaries {
        for texture in &mut dictionary.textures {
            if let Some(source) = texture.source.take() {
                texture.source = Some(model_resource_scope::validate_lens_copy_source(
                    &request.model,
                    &source,
                )?);
            }
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let staging =
        app_cache_root(app, "lens-write")?.join(format!("{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("Cannot prepare the lens write: {error}"))?;
    // Every dictionary is rebuilt before any user file is touched.
    let result = (|| {
        let mut built = Vec::new();
        let mut written = Vec::new();
        for (index, dictionary) in request.dictionaries.iter().enumerate() {
            let mut textures = Vec::new();
            for (slot, texture) in dictionary.textures.iter().enumerate() {
                let path = staging.join(format!("{index}-{slot}.dds"));
                std::fs::write(&path, &body[texture.dds.clone()])
                    .map_err(|error| format!("Cannot prepare {}: {error}", texture.name))?;
                textures.push(serde_json::json!({
                    "name": texture.name,
                    "path": path,
                    "mode": texture.mode,
                    "source": texture.source,
                }));
            }
            let output = staging.join(format!("{index}.ytd"));
            let rebuilt = bridge_request(
                app,
                "writeYtdTextures",
                serde_json::json!({
                    "input": dictionary.path,
                    "output": output,
                    "textures": textures,
                }),
                BRIDGE_REQUEST_TIMEOUT,
            )
            .map_err(|error| format!("{error} Nothing was changed."))?;
            built.push((dictionary.path.clone(), output));
            written.push(rebuilt);
        }
        let replaced = lens_write::replace_with_backups(&built, &request.stamp)?;
        Ok(serde_json::json!({
            "files": replaced
                .into_iter()
                .zip(written)
                .map(|(file, rebuilt)| serde_json::json!({
                    "path": file.path,
                    "backup": file.backup,
                    "textures": rebuilt.get("textures").cloned().unwrap_or_default(),
                }))
                .collect::<Vec<_>>(),
        }))
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// The model's own texture dictionaries with each texture's size, mip count and
/// format, for planning a livery write. `legacy` is false for a dictionary the
/// bridge cannot rebuild.
#[tauri::command]
async fn livery_dictionaries(
    model_path: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let model = PathBuf::from(model_path.trim());
        if !has_extension(&model_path, "yft") || !model.is_file() {
            return Err(format!("Model not found: {}", model.display()));
        }
        let mut dictionaries = Vec::new();
        for path in model_resource_scope::model_sibling_ytds(&model) {
            let display = path.to_string_lossy().to_string();
            let listing = export_ytd_listing(&app, &display)?;
            let textures = listing
                .get("textures")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|texture| {
                    let name = texture.get("name")?.as_str()?;
                    let file = texture.get("path")?.as_str()?;
                    let info = livery_write::read_dds_info(Path::new(file));
                    Some(serde_json::json!({
                        "name": name,
                        "path": file,
                        "width": info.as_ref().map(|info| info.width),
                        "height": info.as_ref().map(|info| info.height),
                        "levels": info.as_ref().map(|info| info.levels),
                        "format": info.as_ref().map(|info| info.format.clone()),
                    }))
                })
                .collect::<Vec<_>>();
            dictionaries.push(serde_json::json!({
                "path": display,
                "name": path.file_name().map(|name| name.to_string_lossy().to_string()),
                "legacy": livery_write::is_legacy_ytd(&path),
                "textures": textures,
            }));
        }
        Ok(serde_json::json!({ "dictionaries": dictionaries }))
    })
    .await
    .map_err(|error| format!("Reading the livery dictionaries stopped: {error}"))?
}

/// Starts a livery write for a model the user opened. Returns `{ token }`.
#[tauri::command]
async fn livery_write_begin(
    model_path: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let model = PathBuf::from(model_path.trim());
    if !has_extension(&model_path, "yft") || !model.is_file() {
        return Err(format!("Model not found: {}", model.display()));
    }
    if !model_opened(&app, &model) {
        return Err("Open the model in Cortex before writing its liveries.".into());
    }
    let root = app_cache_root(&app, "livery-write")?;
    tauri::async_runtime::spawn_blocking(move || {
        let token = app
            .state::<livery_write::LiveryWriteState>()
            .begin(&root, model)?;
        Ok(serde_json::json!({ "token": token }))
    })
    .await
    .map_err(|error| format!("Starting the livery write stopped: {error}"))?
}

/// Stages one livery DDS (raw body, see livery_write::parse_stage).
#[tauri::command]
async fn livery_write_stage(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("A livery texture must be sent as raw bytes.".into());
    };
    let body = body.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (token, id, dds) = livery_write::parse_stage(&body)?;
        app.state::<livery_write::LiveryWriteState>()
            .stage(&token, &id, dds)
    })
    .await
    .map_err(|error| format!("Staging a livery texture stopped: {error}"))?
}

/// Writes the staged liveries and removes the ones the request deletes: every
/// dictionary is rebuilt first, then the
/// user's files are replaced, each after a stamped backup beside it. Resolves
/// `{ files: [{ path, backup, textures }] }`; rejects with a message that says
/// whether anything changed.
#[tauri::command]
async fn livery_write_commit(
    request: livery_write::CommitRequest,
    app: tauri::AppHandle,
    state: State<'_, livery_write::LiveryWriteState>,
) -> Result<serde_json::Value, String> {
    let staged = state.take(&request.token)?;
    tauri::async_runtime::spawn_blocking(move || commit_livery_write(&app, &request, &staged))
        .await
        .map_err(|error| {
            format!("The livery write stopped: {error}. Check the texture dictionaries and their backups.")
        })?
}

fn commit_livery_write(
    app: &tauri::AppHandle,
    request: &livery_write::CommitRequest,
    staged: &livery_write::Staged,
) -> Result<serde_json::Value, String> {
    livery_write::check_commit(request, &staged.files)?;
    if !model_opened(app, &staged.model) {
        return Err("Open the model in Cortex before writing its liveries.".into());
    }
    for (index, ytd) in request.ytds.iter().enumerate() {
        model_resource_scope::validate_sibling_ytd(&staged.model, &ytd.path)?;
        let same = |other: &livery_write::CommitYtd| {
            other.path.canonicalize().ok() == ytd.path.canonicalize().ok()
        };
        if request.ytds[..index].iter().any(same) {
            return Err(format!("{} is listed twice.", ytd.path.display()));
        }
    }
    // Every dictionary is rebuilt before any user file is touched.
    let mut built = Vec::new();
    let mut written = Vec::new();
    for (index, ytd) in request.ytds.iter().enumerate() {
        let textures = ytd
            .textures
            .iter()
            .map(|texture| {
                // check_commit made sure every id is staged; a removal has none.
                serde_json::json!({
                    "name": texture.name,
                    "path": texture.id.as_ref().map(|id| &staged.files[id]),
                    "mode": texture.mode,
                    "like": texture.like,
                })
            })
            .collect::<Vec<_>>();
        let output = staged.dir.join(format!("{index}.ytd"));
        let rebuilt = bridge_request(
            app,
            "writeYtdTextures",
            serde_json::json!({
                "input": ytd.path,
                "output": output,
                "textures": textures,
            }),
            BRIDGE_REQUEST_TIMEOUT,
        )
        .map_err(|error| format!("{error} Nothing was changed."))?;
        built.push((ytd.path.clone(), output));
        written.push(rebuilt);
    }
    let replaced = lens_write::replace_with_backups(&built, &request.stamp)?;
    Ok(serde_json::json!({
        "files": replaced
            .into_iter()
            .zip(written)
            .map(|(file, rebuilt)| serde_json::json!({
                "path": file.path,
                "backup": file.backup,
                "textures": rebuilt.get("textures").cloned().unwrap_or_default(),
            }))
            .collect::<Vec<_>>(),
    }))
}

/// Drops a livery write and what it staged.
#[tauri::command]
fn livery_write_cancel(token: String, state: State<'_, livery_write::LiveryWriteState>) {
    state.cancel(&token);
}

fn validate_ped_name(ped: &str) -> Result<String, String> {
    let trimmed = ped.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("Ped name must be 1-64 characters.".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(format!("Ped name `{trimmed}` must match ^[a-z0-9_]+$."));
    }
    Ok(trimmed.to_string())
}

fn validate_path_segment(value: &str, label: &str, allow_empty: bool) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err(format!("{label} must not be empty."));
    }
    if trimmed.len() > 255
        || trimmed == "."
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('\0')
    {
        return Err(format!("{label} must be a single file or folder name."));
    }
    Ok(trimmed.to_string())
}

/// Animation dictionary and clip names: game identifiers only, never paths.
fn validate_clip_name(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let allowed = |c: char| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '@' | '.' | '-')
    };
    if trimmed.is_empty()
        || trimmed.len() > 128
        || trimmed.contains("..")
        || !trimmed.chars().all(allowed)
    {
        return Err(format!(
            "{label} must be 1-128 characters of a-z, 0-9, _, @, ., -."
        ));
    }
    Ok(trimmed)
}

#[tauri::command]
async fn list_ped_clips(dict: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dict = validate_clip_name(&dict, "Animation dictionary")?;
        bridge_request(
            &app,
            "listPedClips",
            serde_json::json!({ "dict": dict }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join clip listing task: {e}"))?
}

#[tauri::command]
async fn export_ped_clip(
    dict: String,
    clip: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dict = validate_clip_name(&dict, "Animation dictionary")?;
        let clip = validate_clip_name(&clip, "Clip")?;
        bridge_request(
            &app,
            "exportPedClip",
            serde_json::json!({ "dict": dict, "clip": clip }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join clip export task: {e}"))?
}

/// A model's own clip, such as a vehicles.meta convertible roof: the resource's
/// streamed `<dict>.ycd` when it has one, otherwise the game's dictionary.
#[tauri::command]
async fn export_model_clip(
    model_path: String,
    dict: String,
    clip: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dict = validate_clip_name(&dict, "Animation dictionary")?;
        let clip = validate_clip_name(&clip, "Clip")?;
        let ycd = model_resource_scope::find_animation_dictionary(Path::new(&model_path), &dict)?;
        // A resource .ycd is one file read; the game dictionary may need the archive scan.
        let timeout = if ycd.is_some() {
            BRIDGE_REQUEST_TIMEOUT
        } else {
            BRIDGE_HEAVY_REQUEST_TIMEOUT
        };
        let mut result = bridge_request(
            &app,
            "exportModelClip",
            serde_json::json!({
                "dict": dict,
                "clip": clip,
                "ycdPath": ycd.as_ref().map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
            }),
            timeout,
        )?;
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "source".to_string(),
                serde_json::Value::from(if ycd.is_some() { "resource" } else { "game" }),
            );
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("Failed to join clip export task: {e}"))?
}

/// Search text for game names: lowercase identifier characters and spaces.
fn validate_search_query(value: &str) -> Result<String, String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let allowed = |c: char| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '@' | '.' | '-' | ' ')
    };
    if trimmed.is_empty() || trimmed.len() > 64 || !trimmed.chars().all(allowed) {
        return Err(
            "Search must be 1-64 characters of a-z, 0-9, _, @, ., - and spaces.".to_string(),
        );
    }
    Ok(trimmed)
}

const MAX_YCD_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// A user-picked animation dictionary. Read only; never written or moved.
fn validate_ycd_file(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !has_extension(&path.to_string_lossy(), "ycd") {
        return Err("Pick a .ycd animation dictionary.".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| {
        format!(
            "Can't read {}: {e}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_YCD_FILE_BYTES {
        return Err(format!(
            "{} is not a .ycd file the preview can read (empty, too large or not a file).",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(path)
}

#[tauri::command]
async fn search_anim_dicts(
    query: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let query = validate_search_query(&query)?;
        bridge_request(
            &app,
            "searchAnimDicts",
            serde_json::json!({ "query": query }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join animation search task: {e}"))?
}

#[tauri::command]
async fn list_ycd_file_clips(
    path: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_ycd_file(&path)?;
        bridge_request(
            &app,
            "listClipFile",
            serde_json::json!({ "ycdPath": path.to_string_lossy().to_string() }),
            BRIDGE_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join clip listing task: {e}"))?
}

#[tauri::command]
async fn export_ycd_file_clip(
    path: String,
    clip: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_ycd_file(&path)?;
        let clip = clip.trim().to_string();
        if clip.is_empty() || clip.len() > 128 || clip.chars().any(char::is_control) {
            return Err("Clip must be 1-128 printable characters.".to_string());
        }
        bridge_request(
            &app,
            "exportClipFile",
            serde_json::json!({ "ycdPath": path.to_string_lossy().to_string(), "clip": clip }),
            BRIDGE_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join clip export task: {e}"))?
}

#[tauri::command]
async fn search_game_props(
    query: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let query = validate_search_query(&query)?;
        bridge_request(
            &app,
            "searchGameProps",
            serde_json::json!({ "query": query }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join prop search task: {e}"))?
}

/// Extracts a game prop (`<name>.ydr`) into `prop-cache/<name>/` for parsing.
#[tauri::command]
async fn export_game_prop(
    name: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim().to_ascii_lowercase();
        let allowed =
            |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-');
        if name.is_empty() || name.len() > 128 || !name.chars().all(allowed) {
            return Err("Prop name must be 1-128 characters of a-z, 0-9, _, -.".to_string());
        }
        let output_dir = app_cache_root(&app, "prop-cache")?;
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create prop cache dir: {e}"))?;
        bridge_request(
            &app,
            "exportGameProp",
            serde_json::json!({
                "name": name,
                "outputDir": output_dir.to_string_lossy().to_string(),
            }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join prop export task: {e}"))?
}

#[tauri::command]
async fn list_ped_assets(ped: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ped = validate_ped_name(&ped)?;
        bridge_request(
            &app,
            "listPedAssets",
            serde_json::json!({ "ped": ped }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join ped listing task: {e}"))?
}

#[tauri::command]
async fn export_ped_asset(
    ped: String,
    folder: String,
    file: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ped = validate_ped_name(&ped)?;
        let folder = validate_path_segment(&folder, "folder", true)?;
        let file = validate_path_segment(&file, "file", false)?;
        if !(has_extension(&file, "ydd") || has_extension(&file, "ytd")) {
            return Err("Only .ydd and .ytd ped assets can be exported.".to_string());
        }

        let output_dir = app_cache_root(&app, "ped-cache")?;
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create ped cache dir: {e}"))?;

        bridge_request(
            &app,
            "exportPedAsset",
            serde_json::json!({
                "ped": ped,
                "folder": folder,
                "file": file,
                "outputDir": output_dir.to_string_lossy().to_string(),
            }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join ped export task: {e}"))?
}

/// Game ped models (a name with both a `.ymt` and a `.yft`) matching `query`.
#[tauri::command]
async fn search_peds(query: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let query = validate_search_query(&query)?;
        bridge_request(
            &app,
            "searchPeds",
            serde_json::json!({ "query": query }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join ped search task: {e}"))?
}

/// A game ped's skeleton, component and prop variations, and the archive files
/// they resolve to. Nothing is written; the bridge caches it per ped.
#[tauri::command]
async fn describe_game_ped(
    ped: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ped = validate_ped_name(&ped)?;
        bridge_request(
            &app,
            "describeGamePed",
            serde_json::json!({ "ped": ped }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join ped description task: {e}"))?
}

const MAX_PED_FILES: usize = 4096;
const MAX_PED_FILE_BYTES: u64 = 512 * 1024 * 1024;
const PED_FILE_SCAN_DEPTH: usize = 6;
/// Files and folders a selection's walk may look at before it gives up.
const MAX_PED_SCAN_ENTRIES: usize = 50_000;
const PED_DESCRIBE_REVISION: &[u8] = b"describe_ped_files_v1";

fn is_ped_file(path: &Path) -> bool {
    let name = path.to_string_lossy();
    ["ymt", "yft", "ydd", "ytd"]
        .iter()
        .any(|ext| has_extension(&name, ext))
}

/// What a folder walk sees of one entry. Links inside a picked folder are `Other`.
enum PedScanEntry {
    Folder(PathBuf),
    File(PathBuf),
    Other,
}

fn list_ped_folder(dir: &Path) -> std::io::Result<Vec<PedScanEntry>> {
    Ok(std::fs::read_dir(dir)?
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => PedScanEntry::Folder(entry.path()),
            Ok(kind) if kind.is_file() => PedScanEntry::File(entry.path()),
            _ => PedScanEntry::Other,
        })
        .collect())
}

/// The ped files in a selection, plus what the walk skipped.
#[derive(Debug)]
struct PedFileSelection {
    files: Vec<PathBuf>,
    warnings: Vec<String>,
}

/// The ped files in a picked selection: picked files as they are, picked
/// folders walked (at most six levels) for `.ymt`/`.yft`/`.ydd`/`.ytd`. A
/// picked link is followed, since the user chose it; links found inside a
/// folder are not. Sorted and de-duplicated. Missing picks are an error naming
/// them, so a restored character can ask to be located again. A picked folder
/// that can't be read fails; a subfolder that can't be read is skipped with a
/// warning. More than `max_entries` files and folders looked at is an error.
fn collect_ped_files(paths: &[String]) -> Result<PedFileSelection, String> {
    collect_ped_files_with(paths, MAX_PED_SCAN_ENTRIES, &mut list_ped_folder)
}

fn collect_ped_files_with(
    paths: &[String],
    max_entries: usize,
    list: &mut dyn FnMut(&Path) -> std::io::Result<Vec<PedScanEntry>>,
) -> Result<PedFileSelection, String> {
    let mut files = Vec::new();
    let mut missing = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut visited = 0usize;
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if !path.is_absolute() {
            return Err("Ped files must be absolute paths.".to_string());
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            missing.push(path);
            continue;
        };
        if meta.is_file() {
            if !is_ped_file(&path) {
                return Err(format!(
                    "{} is not a ped file (.ymt, .yft, .ydd or .ytd).",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
            files.push(path);
        } else if meta.is_dir() {
            let mut stack = vec![(path, 0usize)];
            while let Some((dir, depth)) = stack.pop() {
                let entries = match list(&dir) {
                    Ok(entries) => entries,
                    // The user's own pick must be readable; a locked subfolder
                    // (a backup, a system folder) only loses its files.
                    Err(e) if depth == 0 => {
                        return Err(format!("Can't read {}: {e}", dir.display()))
                    }
                    Err(e) => {
                        skipped.push(format!("{} ({e})", dir.display()));
                        continue;
                    }
                };
                visited += entries.len();
                if visited > max_entries {
                    return Err(format!(
                        "The selection holds more than {max_entries} files and folders to look through; pick the ped's own folder."
                    ));
                }
                for entry in entries {
                    match entry {
                        PedScanEntry::Folder(child) if depth < PED_FILE_SCAN_DEPTH => {
                            stack.push((child, depth + 1));
                        }
                        PedScanEntry::File(child) if is_ped_file(&child) => files.push(child),
                        _ => {}
                    }
                }
                if files.len() > MAX_PED_FILES {
                    break;
                }
            }
        }
        if files.len() > MAX_PED_FILES {
            return Err(format!(
                "The selection holds more than {MAX_PED_FILES} ped files; pick the ped's own folder."
            ));
        }
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing
            .iter()
            .take(3)
            .map(|path| path.display().to_string())
            .collect();
        let more = missing.len().saturating_sub(names.len());
        let suffix = if more > 0 {
            format!(" and {more} more")
        } else {
            String::new()
        };
        return Err(format!("Missing ped files: {}{suffix}", names.join(", ")));
    }
    files.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    files.dedup_by_key(|path| path.to_string_lossy().to_lowercase());
    let mut warnings = Vec::new();
    if let Some(first) = skipped.first() {
        let more = skipped.len() - 1;
        warnings.push(if more > 0 {
            format!("Couldn't read {first} or {more} other folders, so their files were left out.")
        } else {
            format!("Couldn't read {first}, so its files were left out.")
        });
    }
    Ok(PedFileSelection { files, warnings })
}

/// The `.ydd` files of a description that the renderer may read through
/// `read_ped_drawable`: `files[*]` refs of kind `ydd` with a `path` that the
/// selection's walk collected. Keys are lowercased paths.
fn ped_drawable_grants(result: &serde_json::Value, collected: &[PathBuf]) -> Vec<String> {
    let collected: HashSet<String> = collected
        .iter()
        .map(|file| file.to_string_lossy().to_lowercase())
        .collect();
    result
        .get("files")
        .and_then(|files| files.as_array())
        .into_iter()
        .flatten()
        .filter(|file| file.get("kind").and_then(|kind| kind.as_str()) == Some("ydd"))
        .filter_map(|file| file.get("path").and_then(|path| path.as_str()))
        .map(str::to_lowercase)
        .filter(|key| collected.contains(key))
        .collect()
}

/// User ped drawables described this session. The viewer parses them itself;
/// it reads them through `read_ped_drawable` rather than the fs plugin, whose
/// runtime scope can't grant read without write.
static PED_DRAWABLE_READS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn allow_ped_drawable_reads(result: &serde_json::Value, collected: &[PathBuf]) {
    let grants = ped_drawable_grants(result, collected);
    if grants.is_empty() {
        return;
    }
    lock_ignoring_poison(PED_DRAWABLE_READS.get_or_init(Default::default)).extend(grants);
}

/// The walk's warnings go first in the description's `warnings`; they are not
/// cached, since a folder that was locked may open next time.
fn with_scan_warnings(mut result: serde_json::Value, warnings: &[String]) -> serde_json::Value {
    if warnings.is_empty() {
        return result;
    }
    if let Some(object) = result.as_object_mut() {
        let mut merged: Vec<serde_json::Value> = warnings.iter().cloned().map(Into::into).collect();
        if let Some(existing) = object.get("warnings").and_then(|value| value.as_array()) {
            merged.extend(existing.iter().cloned());
        }
        object.insert("warnings".to_string(), serde_json::Value::Array(merged));
    }
    result
}

/// The bytes of a user ped drawable that a `describe_ped_files` result named.
/// Any other path is refused.
#[tauri::command]
async fn read_ped_drawable(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = PathBuf::from(&path);
        let name = file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let allowed = has_extension(&path, "ydd")
            && PED_DRAWABLE_READS
                .get()
                .is_some_and(|set| lock_ignoring_poison(set).contains(&path.to_lowercase()));
        if !allowed {
            return Err(format!(
                "{name} isn't a drawable of a ped read this session; read the ped's files again."
            ));
        }
        let meta =
            std::fs::metadata(&file).map_err(|e| format!("Can't read {}: {e}", file.display()))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file.", file.display()));
        }
        if meta.len() > MAX_PED_FILE_BYTES {
            return Err(format!("{name} is larger than 512 MB."));
        }
        std::fs::read(&file)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("Can't read {}: {e}", file.display()))
    })
    .await
    .map_err(|e| format!("Failed to join ped drawable read: {e}"))?
}

/// The cache key of a selection, and the identity its entry must match:
/// every collected file with its modified time and size.
fn ped_files_identity(ped: &str, files: &[PathBuf]) -> Result<(String, serde_json::Value), String> {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(PED_DESCRIBE_REVISION);
    hasher.write(ped.as_bytes());
    let mut identity = Vec::with_capacity(files.len());
    for file in files {
        let path = file.to_string_lossy().to_string();
        let (mtime, size) = file_identity(&path)?;
        if size > MAX_PED_FILE_BYTES {
            return Err(format!(
                "{} is larger than 512 MB.",
                file.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        hasher.write(path.to_lowercase().as_bytes());
        identity.push(serde_json::json!([path, mtime, size]));
    }
    Ok((
        format!("{:016x}", hasher.finish()),
        serde_json::Value::Array(identity),
    ))
}

/// The user's own ped from picked files or folders (`.ymt`, `.yft`, `.ydd`,
/// `.ytd`, FiveM `<ped>^<file>` names included). With several peds in the
/// selection and no `ped`, resolves to `{ ped: "", candidates }`. Descriptions
/// are cached in `ped-cache/describe-v1/` per selection while every file keeps
/// its modified time and size. Files are only read.
#[tauri::command]
async fn describe_ped_files(
    paths: Vec<String>,
    ped: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ped = ped.unwrap_or_default().trim().to_ascii_lowercase();
        if ped.len() > 128
            || ped
                .chars()
                .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
        {
            return Err("Ped name must be a file name of at most 128 characters.".to_string());
        }
        if paths.is_empty() || paths.len() > MAX_PED_FILES {
            return Err("Pick a ped folder or the ped's files.".to_string());
        }
        let PedFileSelection {
            files,
            warnings: scan_warnings,
        } = collect_ped_files(&paths)?;
        if files.is_empty() {
            return Err("No ped files (.ymt, .yft, .ydd, .ytd) in the selection.".to_string());
        }
        let (key, identity) = ped_files_identity(&ped, &files)?;
        let cache_dir = app_cache_root(&app, "ped-cache")?.join("describe-v1");
        let entry = cache_dir.join(format!("{key}.json"));
        {
            let _guard = lock_ignoring_poison(&CACHE_LOCK);
            if let Some(stored) = read_json_file(&entry) {
                if stored.get("identity") == Some(&identity) {
                    if let Some(result) = stored.get("result") {
                        allow_ped_drawable_reads(result, &files);
                        return Ok(with_scan_warnings(result.clone(), &scan_warnings));
                    }
                }
            }
        }
        let file_list: Vec<String> = files
            .iter()
            .map(|file| file.to_string_lossy().to_string())
            .collect();
        let result = bridge_request(
            &app,
            "describePedFiles",
            serde_json::json!({ "ped": ped, "files": file_list }),
            BRIDGE_REQUEST_TIMEOUT,
        )?;
        // Only a description the bridge produced opens its drawables to the viewer.
        allow_ped_drawable_reads(&result, &files);
        let stored = serde_json::json!({ "identity": identity, "result": &result });
        let _guard = lock_ignoring_poison(&CACHE_LOCK);
        if std::fs::create_dir_all(&cache_dir).is_ok() {
            if let Ok(bytes) = serde_json::to_vec(&stored) {
                // A failed cache write only costs the next call a bridge read.
                let _ = write_file_atomically(&entry, &bytes);
            }
        }
        Ok(with_scan_warnings(result, &scan_warnings))
    })
    .await
    .map_err(|e| format!("Failed to join ped description task: {e}"))?
}

/// Reads the bridge's `textures.json` listing when every referenced DDS still
/// exists. Listings written before `warnings` existed report none.
fn read_texture_listing(dir: &Path) -> Option<serde_json::Value> {
    let mut listing = read_json_file(&dir.join("textures.json"))?;
    let textures = listing.get("textures")?.as_array()?;
    if textures.is_empty() {
        return None;
    }
    let complete = textures.iter().all(|texture| {
        texture
            .get("path")
            .and_then(|p| p.as_str())
            .map(|p| Path::new(p).is_file())
            .unwrap_or(false)
    });
    if !complete {
        return None;
    }
    if let Some(object) = listing.as_object_mut() {
        if !object.get("warnings").is_some_and(|v| v.is_array()) {
            object.insert("warnings".to_string(), serde_json::json!([]));
        }
    }
    Some(listing)
}

#[tauri::command]
async fn export_ytd(path: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || export_ytd_listing(&app, &path))
        .await
        .map_err(|e| format!("Failed to join ytd export task: {e}"))?
}

/// A dictionary's textures as DDS files in the ytd cache, reused while the
/// `.ytd` is unchanged: `{ dir, textures: [{ name, path }], warnings }`.
fn export_ytd_listing(app: &tauri::AppHandle, path: &str) -> Result<serde_json::Value, String> {
    let trimmed = path.trim().to_string();
    if !has_extension(&trimmed, "ytd") {
        return Err("Only .ytd files are supported by export_ytd".to_string());
    }
    if !Path::new(&trimmed).is_file() {
        return Err(format!("Texture dictionary not found: {trimmed}"));
    }

    let cache_root = app_cache_root(app, "ytd-cache")?;
    std::fs::create_dir_all(&cache_root)
        .map_err(|e| format!("Failed to create ytd cache dir: {e}"))?;

    let (mtime, size) = file_identity(&trimmed)?;
    let key = cache_key(b"export_ytd_v1", &trimmed, mtime, size);
    let out_dir = cache_root.join(&key);

    {
        let _guard = CACHE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(listing) = read_texture_listing(&out_dir) {
            touch_cache_entry(&out_dir);
            return Ok(listing);
        }
    }

    let listing = bridge_request(
        app,
        "exportYtd",
        serde_json::json!({
            "path": trimmed,
            "outputDir": out_dir.to_string_lossy().to_string(),
        }),
        BRIDGE_REQUEST_TIMEOUT,
    )
    .inspect_err(|_| {
        // Partial DDS files without a listing are never reused; drop them.
        let _guard = lock_ignoring_poison(&CACHE_LOCK);
        if out_dir.exists() && read_texture_listing(&out_dir).is_none() {
            remove_cache_entry(&out_dir);
        }
    })?;
    touch_cache_entry(&out_dir);
    run_cache_maintenance(app);
    Ok(listing)
}

/// Game license plate textures and carcols plate definitions, exported once from
/// the GTA V archives into `<appCacheDir>/cortex-labs/plate-cache/v1`.
#[tauri::command]
async fn export_plate_textures(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out_dir = app_cache_root(&app, "plate-cache")?.join("v1");
        {
            let _guard = CACHE_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(listing) = read_json_file(&out_dir.join("plates.json")) {
                let complete = listing
                    .get("textures")
                    .and_then(|textures| textures.as_array())
                    .map(|textures| {
                        !textures.is_empty()
                            && textures.iter().all(|texture| {
                                texture
                                    .get("path")
                                    .and_then(|p| p.as_str())
                                    .map(|p| Path::new(p).is_file())
                                    .unwrap_or(false)
                            })
                    })
                    .unwrap_or(false);
                if complete {
                    return Ok(listing);
                }
            }
        }
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("Failed to create plate cache dir: {e}"))?;
        bridge_request(
            &app,
            "exportPlateTextures",
            serde_json::json!({ "outputDir": out_dir.to_string_lossy().to_string() }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join plate export task: {e}"))?
}

#[derive(serde::Deserialize)]
struct BugReportIssuePayload {
    title: String,
    body: String,
    labels: Vec<String>,
    /// The full feedback payload the docs-site endpoint validates.
    report: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
struct BugReportResult {
    ok: bool,
    issue_number: u64,
    issue_url: String,
}

/// The public feedback endpoint compiled into this build:
/// `CORTEX_BUG_REPORT_ENDPOINT`, else the renderer's `VITE_BUG_REPORT_ENDPOINT`,
/// read from the build environment. It is a URL, never a credential; the
/// renderer cannot reach it itself because the CSP limits `connect-src`.
const BUILD_BUG_REPORT_ENDPOINT: Option<&str> = match option_env!("CORTEX_BUG_REPORT_ENDPOINT") {
    Some(endpoint) => Some(endpoint),
    None => option_env!("VITE_BUG_REPORT_ENDPOINT"),
};

/// The origin the desktop webview uses on Windows. The docs-site route rejects
/// requests whose `Origin` is not in its `BUG_REPORT_ALLOWED_ORIGINS`, so list it there.
const BUG_REPORT_ORIGIN: &str = "http://tauri.localhost";
const BUG_REPORT_TIMEOUT: Duration = Duration::from_secs(30);

enum BugReportTransport {
    /// The docs-site `/api/report-bug` route; it holds the GitHub token.
    Endpoint(String),
    /// Debug builds only: GitHub directly with `GITHUB_TOKEN`, `GITHUB_OWNER` and
    /// `GITHUB_REPO` from the process environment (loaded from `.env`). A release
    /// build never sends with a token.
    GitHub {
        token: String,
        owner: String,
        repo: String,
    },
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bug_report_endpoint(raw: Option<&str>) -> Option<String> {
    let endpoint = raw?.trim();
    reqwest::Url::parse(endpoint)
        .ok()
        .filter(|url| url.scheme() == "https" && url.host_str().is_some())
        .map(|_| endpoint.to_string())
}

fn bug_report_transport() -> Option<BugReportTransport> {
    if let Some(endpoint) = bug_report_endpoint(BUILD_BUG_REPORT_ENDPOINT) {
        return Some(BugReportTransport::Endpoint(endpoint));
    }
    if !cfg!(debug_assertions) {
        return None;
    }
    Some(BugReportTransport::GitHub {
        token: non_empty_env("GITHUB_TOKEN")?,
        owner: non_empty_env("GITHUB_OWNER")?,
        repo: non_empty_env("GITHUB_REPO")?,
    })
}

/// `{ available, transport }`: whether this build can send feedback, so the
/// form can say so before the user writes a report.
#[tauri::command]
fn bug_report_status() -> serde_json::Value {
    let transport = match bug_report_transport() {
        Some(BugReportTransport::Endpoint(_)) => Some("endpoint"),
        Some(BugReportTransport::GitHub { .. }) => Some("github"),
        None => None,
    };
    serde_json::json!({ "available": transport.is_some(), "transport": transport })
}

fn submit_to_endpoint(
    client: &reqwest::blocking::Client,
    endpoint: &str,
    report: &serde_json::Value,
) -> Result<BugReportResult, String> {
    let response = client
        .post(endpoint)
        .header("Origin", BUG_REPORT_ORIGIN)
        .json(report)
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "Feedback submission timed out. Check your connection and try again.".to_string()
            } else {
                format!("Feedback submission failed: {e}")
            }
        })?;
    let status = response.status();
    let body: serde_json::Value = response.json().unwrap_or(serde_json::Value::Null);
    if !status.is_success() || body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Feedback submission failed with HTTP {status}.")));
    }
    Ok(BugReportResult {
        ok: true,
        issue_number: body
            .get("issueNumber")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        issue_url: body
            .get("issueUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn submit_to_github(
    client: &reqwest::blocking::Client,
    payload: &BugReportIssuePayload,
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<BugReportResult, String> {
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/issues");
    let response = client
        .post(&api_url)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({
            "title": payload.title,
            "body": payload.body,
            "labels": payload.labels,
        }))
        .send()
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().unwrap_or_default();
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if let Some(msg) = parsed.get("message").and_then(|v| v.as_str()) {
                return Err(format!("GitHub API: {msg}"));
            }
        }
        return Err(format!("GitHub API request failed with HTTP {status}."));
    }

    let issue: serde_json::Value = response
        .json()
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;
    let number = issue
        .get("number")
        .and_then(|v| v.as_u64())
        .ok_or("GitHub API response missing issue number.")?;
    let html_url = issue
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(BugReportResult {
        ok: true,
        issue_number: number,
        issue_url: html_url,
    })
}

#[tauri::command]
async fn submit_bug_report(payload: BugReportIssuePayload) -> Result<BugReportResult, String> {
    let transport = bug_report_transport().ok_or_else(|| {
        "Sending feedback is not configured in this build. Copy the report as Markdown instead."
            .to_string()
    })?;

    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .user_agent(format!(
                "cortex-studio-bug-reporter/{}",
                env!("CARGO_PKG_VERSION")
            ))
            .timeout(BUG_REPORT_TIMEOUT)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        match &transport {
            BugReportTransport::Endpoint(endpoint) => {
                let report = payload
                    .report
                    .as_ref()
                    .ok_or("The feedback report payload is missing.")?;
                submit_to_endpoint(&client, endpoint, report)
            }
            BugReportTransport::GitHub { token, owner, repo } => {
                submit_to_github(&client, &payload, token, owner, repo)
            }
        }
    })
    .await
    .map_err(|e| format!("Failed to join bug report task: {e}"))?
}

#[tauri::command]
fn consume_pending_open_file(state: State<PendingOpenFileState>) -> Option<String> {
    state
        .path
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

fn normalize_path_for_compare(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let trimmed = text.trim_end_matches('\\');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = normalize_path_for_compare(path);
    let root = normalize_path_for_compare(root);
    if root.is_empty() {
        return false;
    }
    path == root || path.starts_with(&format!("{root}\\"))
}

/// Creates a directory only inside the user's own locations (home, app data,
/// cache, temp, desktop, documents, downloads). Relative or `..` paths are rejected.
#[tauri::command]
fn ensure_dir(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Path must not contain `..`".to_string());
    }

    let resolver = app.path();
    let allowed_roots: Vec<PathBuf> = [
        resolver.home_dir(),
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_cache_dir(),
        resolver.temp_dir(),
        resolver.desktop_dir(),
        resolver.document_dir(),
        resolver.download_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .collect();

    if !allowed_roots
        .iter()
        .any(|root| path_is_within(&candidate, root))
    {
        return Err("Path is outside the user's home, app data, or temp folders".to_string());
    }

    std::fs::create_dir_all(&candidate).map_err(|e| e.to_string())
}

/// vMenu character saves from FiveM's local KVP store, read without touching
/// the database. An empty result with no stores means FiveM has no store here.
#[tauri::command]
async fn list_fivem_characters(app: tauri::AppHandle) -> Result<fivem_kvs::KvsScan, String> {
    let roaming = app
        .path()
        .data_dir()
        .map_err(|e| format!("Couldn't find the roaming app data folder: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || fivem_kvs::scan(&roaming.join("CitizenFX")))
        .await
        .map_err(|e| format!("Failed to read FiveM saves: {e}"))
}

#[tauri::command]
fn open_folder_fallback(path: String) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }

    let requested_path = PathBuf::from(trimmed);
    let target_path = if requested_path.is_dir() {
        requested_path
    } else if requested_path.is_file() {
        requested_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not resolve parent folder".to_string())?
    } else {
        return Err(format!("Path does not exist: {}", trimmed));
    };

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to launch Explorer: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to launch Finder: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }

    Ok(())
}

/// Decode a Paint.NET (.pdn) file into raw RGBA pixel data (see `pdn.rs`).
/// Returns a binary payload: `u32 LE width`, `u32 LE height`, then `width*height*4` RGBA bytes.
#[tauri::command]
async fn decode_pdn(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || pdn::decode_file(Path::new(&path)))
        .await
        .map_err(|e| format!("Failed to join PDN decode task: {e}"))?
        .map(tauri::ipc::Response::new)
}

#[cfg(debug_assertions)]
fn load_dotenv() {
    let candidates = [
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".env"),
    ];

    for path in &candidates {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim().trim_matches('"');
                if key.is_empty() {
                    continue;
                }
                if std::env::var(key).is_err() {
                    std::env::set_var(key, value);
                }
            }
        }
        break;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    load_dotenv();

    let app = tauri::Builder::default()
        .manage(WatchState::default())
        .manage(EupWatchState::default())
        .manage(PendingOpenFileState::default())
        .manage(BridgeState::default())
        .manage(livery_write::LiveryWriteState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(file_path) = extract_open_file_arg(&args) {
                queue_open_file(app, file_path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            inspect_updater_release,
            start_watch,
            stop_watch,
            start_window_watch,
            stop_window_watch,
            start_multi_watch,
            stop_multi_watch,
            start_eup_watch,
            stop_eup_watch,
            parse_yft,
            warm_codewalker_bridge,
            allow_model_resource,
            allow_els_folder,
            backup_vcf_list,
            read_els_pattern_tables,
            open_model_meta_file,
            rename_model_stream_files,
            write_lens_textures,
            livery_dictionaries,
            livery_write_begin,
            livery_write_stage,
            livery_write_commit,
            livery_write_cancel,
            list_ped_assets,
            export_ped_asset,
            search_peds,
            describe_game_ped,
            describe_ped_files,
            read_ped_drawable,
            list_ped_clips,
            export_ped_clip,
            export_model_clip,
            search_anim_dicts,
            list_ycd_file_clips,
            export_ycd_file_clip,
            search_game_props,
            export_game_prop,
            photo_assets::list_game_vehicles,
            vehicle_snapshots::vehicle_snapshot_index,
            vehicle_snapshots::read_vehicle_snapshot,
            vehicle_snapshots::save_vehicle_snapshot,
            photo_assets::export_game_vehicle,
            photo_assets::export_game_vehicle_mods,
            photo_assets::lookup_game_text,
            export_ytd,
            export_plate_textures,
            consume_pending_open_file,
            ensure_dir,
            open_folder_fallback,
            list_fivem_characters,
            decode_pdn,
            submit_bug_report,
            bug_report_status,
            cancel_bridge_request
        ])
        .setup(|app| {
            // On Windows, "Open With" passes the file path as a CLI argument.
            // Queue it so the frontend can consume it once listeners are mounted.
            let args: Vec<String> = std::env::args().collect();
            if let Some(file_path) = extract_open_file_arg(&args) {
                let state = app.state::<PendingOpenFileState>();
                let mut pending = state
                    .path
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *pending = Some(file_path);
            }

            run_cache_maintenance(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            shutdown_bridge(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cortex-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ped_files_expand_folders_and_report_missing_picks() {
        let dir = scratch_dir("ped-files");
        let stream = dir.join("stream");
        std::fs::create_dir_all(stream.join("my_ped")).unwrap();
        std::fs::write(stream.join("my_ped.ymt"), b"ymt").unwrap();
        std::fs::write(stream.join("my_ped^uppr_000_u.ydd"), b"ydd").unwrap();
        std::fs::write(stream.join("my_ped").join("head_000_r.ydd"), b"ydd").unwrap();
        std::fs::write(stream.join("readme.txt"), b"text").unwrap();
        let folder = stream.to_string_lossy().to_string();

        let files = collect_ped_files(std::slice::from_ref(&folder))
            .unwrap()
            .files;
        let names: Vec<String> = files
            .iter()
            .map(|file| file.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(!names.contains(&"readme.txt".to_string()));

        let ymt = stream.join("my_ped.ymt").to_string_lossy().to_string();
        let both = collect_ped_files(&[folder.clone(), ymt]).unwrap().files;
        assert_eq!(
            both.len(),
            3,
            "a picked file inside a picked folder counts once"
        );

        let gone = dir.join("gone").to_string_lossy().to_string();
        let error = collect_ped_files(&[folder.clone(), gone]).unwrap_err();
        assert!(error.starts_with("Missing ped files:"), "{error}");

        let text = stream.join("readme.txt").to_string_lossy().to_string();
        assert!(collect_ped_files(&[text]).is_err());
        assert!(collect_ped_files(&["relative\\my_ped.ymt".to_string()]).is_err());

        let (key, identity) = ped_files_identity("my_ped", &files).unwrap();
        let (again, same) = ped_files_identity("my_ped", &files).unwrap();
        assert_eq!((key.as_str(), &identity), (again.as_str(), &same));
        let (other, _) = ped_files_identity("other_ped", &files).unwrap();
        assert_ne!(key, other, "the chosen ped is part of the key");
        std::fs::write(stream.join("my_ped.ymt"), b"edited ymt").unwrap();
        let (_, changed) = ped_files_identity("my_ped", &files).unwrap();
        assert_ne!(identity, changed, "an edited file changes the identity");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ped_walk_skips_unreadable_subfolders_and_caps_entries() {
        // The pick must exist for its metadata check; its listing is faked so
        // a subfolder can refuse to open.
        let root = scratch_dir("ped-walk");
        let pick = root.to_string_lossy().to_string();
        let locked = root.join("backup");
        let mut list = |dir: &Path| -> std::io::Result<Vec<PedScanEntry>> {
            if dir == root.as_path() {
                Ok(vec![
                    PedScanEntry::File(dir.join("my_ped.ymt")),
                    PedScanEntry::File(dir.join("my_ped.ydd")),
                    PedScanEntry::File(dir.join("readme.txt")),
                    PedScanEntry::Folder(dir.join("backup")),
                    PedScanEntry::Other,
                ])
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "access denied",
                ))
            }
        };
        let selection =
            collect_ped_files_with(std::slice::from_ref(&pick), 100, &mut list).unwrap();
        assert_eq!(
            selection.files.len(),
            2,
            "readme.txt and links are left out"
        );
        assert_eq!(selection.warnings.len(), 1, "{:?}", selection.warnings);
        assert!(
            selection.warnings[0].contains(&locked.display().to_string()),
            "the warning names the skipped folder: {:?}",
            selection.warnings
        );

        let error = collect_ped_files_with(std::slice::from_ref(&pick), 3, &mut list)
            .err()
            .unwrap();
        assert!(error.contains("more than 3 files and folders"), "{error}");

        let mut unreadable = |_: &Path| -> std::io::Result<Vec<PedScanEntry>> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "access denied",
            ))
        };
        let error = collect_ped_files_with(std::slice::from_ref(&pick), 100, &mut unreadable)
            .err()
            .unwrap();
        assert!(
            error.starts_with("Can't read"),
            "an unreadable pick fails: {error}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ped_drawable_reads_cover_only_described_collected_drawables() {
        let collected = vec![
            PathBuf::from(r"D:\Peds\my_ped.ydd"),
            PathBuf::from(r"D:\Peds\my_ped.ytd"),
            PathBuf::from(r"D:\Peds\my_ped^uppr_000_u.ydd"),
        ];
        let result = serde_json::json!({
            "ped": "my_ped",
            "files": [
                { "kind": "ydd", "dictionary": true, "path": r"D:\Peds\my_ped.ydd" },
                { "kind": "ytd", "dictionary": true, "path": r"D:\Peds\my_ped.ytd" },
                { "kind": "ydd", "dictionary": false, "path": r"D:\Other\not_collected.ydd" },
                { "kind": "ydd", "dictionary": false, "folder": "my_ped", "file": "head_000_r.ydd" },
            ],
        });
        assert_eq!(
            ped_drawable_grants(&result, &collected),
            vec![r"d:\peds\my_ped.ydd".to_string()],
            "only collected .ydd paths the description names: not the .ytd, not a path outside the selection, not an undescribed drawable"
        );
        let candidates = serde_json::json!({ "ped": "", "candidates": ["a", "b"] });
        assert!(ped_drawable_grants(&candidates, &collected).is_empty());

        let merged = with_scan_warnings(
            serde_json::json!({ "warnings": ["Two copies of my_ped.ydd"] }),
            &[r"Couldn't read D:\Peds\backup".to_string()],
        );
        assert_eq!(
            merged["warnings"],
            serde_json::json!([r"Couldn't read D:\Peds\backup", "Two copies of my_ped.ydd"])
        );
    }

    #[test]
    fn cache_entries_follow_their_recorded_inputs() {
        let dir = scratch_dir("inputs");
        let ytd = dir.join("car.ytd");
        std::fs::write(&ytd, b"one").unwrap();
        let path = ytd.to_string_lossy().to_string();
        let (mtime, size) = file_identity(&path).unwrap();
        let absent = dir.join("car+hi.ytd");
        let meta = serde_json::json!({ "inputs": [
            { "path": path, "mtimeMs": mtime, "size": size },
            { "path": absent.to_string_lossy(), "missing": true },
        ]});
        assert!(cache_inputs_unchanged(&meta));

        std::fs::write(&absent, b"new").unwrap();
        assert!(
            !cache_inputs_unchanged(&meta),
            "a candidate that appeared refreshes the parse"
        );
        std::fs::remove_file(&absent).unwrap();
        assert!(cache_inputs_unchanged(&meta));

        std::fs::write(&ytd, b"edited").unwrap();
        assert!(
            !cache_inputs_unchanged(&meta),
            "an edited dictionary refreshes the parse"
        );

        assert!(
            !cache_inputs_unchanged(&serde_json::json!({})),
            "entries without inputs are never reused"
        );
        assert!(!cache_inputs_unchanged(
            &serde_json::json!({ "inputs": [{ "path": path }] })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dictionary_saved_at_the_same_size_refreshes_the_parse() {
        // Editing a texture inside a .ytd usually keeps its size.
        let dir = scratch_dir("same-size");
        let ytd = dir.join("police3.ytd");
        std::fs::write(&ytd, b"one").unwrap();
        let path = ytd.to_string_lossy().to_string();
        let (mtime, size) = file_identity(&path).unwrap();
        let meta =
            serde_json::json!({ "inputs": [{ "path": path, "mtimeMs": mtime, "size": size }] });

        std::fs::write(&ytd, b"two").unwrap();
        let saved = std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime + 2000);
        std::fs::File::options()
            .write(true)
            .open(&ytd)
            .unwrap()
            .set_modified(saved)
            .unwrap();
        assert_eq!(file_identity(&path).unwrap().1, size);
        assert!(!cache_inputs_unchanged(&meta));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_complete_entries_are_reused() {
        let dir = scratch_dir("entry");
        std::fs::write(dir.join("model.clmesh"), b"CLM1").unwrap();
        assert!(
            finish_parse_entry(&dir, "C:/car.yft", serde_json::json!({ "meshCount": 1 })).is_err(),
            "an entry without a manifest is not finished"
        );
        assert!(!dir.join("meta.json").exists());
        assert!(read_complete_parse_entry(&dir).is_none());

        std::fs::write(dir.join("manifest.json"), b"{}").unwrap();
        let warnings: Vec<String> = (0..150).map(|i| format!("warning {i}")).collect();
        let meta = finish_parse_entry(
            &dir,
            "C:/car.yft",
            serde_json::json!({ "meshCount": 1, "warnings": warnings }),
        )
        .unwrap();
        assert_eq!(meta["inputPath"], "C:/car.yft");
        assert_eq!(meta["inputs"], serde_json::json!([]));
        let listed = meta["warnings"].as_array().unwrap();
        assert_eq!(listed.len(), MAX_PARSE_WARNINGS);
        assert_eq!(listed.last().unwrap(), "51 more warnings were not listed.");
        assert!(!dir.join("meta.json.tmp").exists());
        assert!(read_complete_parse_entry(&dir).is_some());

        std::fs::remove_file(dir.join("model.clmesh")).unwrap();
        assert!(read_complete_parse_entry(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_tokens_and_report_endpoints_are_validated() {
        assert!(validate_request_token("3f2a-b_9").is_ok());
        assert!(validate_request_token("").is_err());
        assert!(validate_request_token("a/b").is_err());
        assert!(validate_request_token(&"a".repeat(65)).is_err());

        assert_eq!(
            bug_report_endpoint(Some(" https://docs.example.com/api/report-bug ")).as_deref(),
            Some("https://docs.example.com/api/report-bug")
        );
        assert!(bug_report_endpoint(Some("http://docs.example.com/api/report-bug")).is_none());
        assert!(bug_report_endpoint(Some("not a url")).is_none());
        assert!(bug_report_endpoint(None).is_none());
    }

    /// The shipped capability's fs scope, combined the way tauri-plugin-fs does:
    /// the global scope for every fs command plus the write-file command's denies.
    /// The probe paths do not exist, so they are matched as written.
    #[cfg(windows)]
    #[test]
    fn capability_keeps_writes_out_of_autostart_and_credential_folders() {
        use tauri::utils::config::FsScope;

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap().clone();
        let paths = |identifier: &str, key: &str| -> Vec<PathBuf> {
            permissions
                .iter()
                .filter(|permission| permission["identifier"] == identifier)
                .flat_map(|permission| permission[key].as_array().cloned().unwrap_or_default())
                .filter_map(|entry| entry["path"].as_str().map(PathBuf::from))
                .collect()
        };
        let app = tauri::test::mock_app();
        let scope = |extra_deny: Vec<PathBuf>| {
            tauri::scope::fs::Scope::new(
                &app,
                &FsScope::Scope {
                    allow: paths("fs:scope", "allow"),
                    deny: paths("fs:scope", "deny")
                        .into_iter()
                        .chain(extra_deny)
                        .collect(),
                    require_literal_leading_dot: None,
                },
            )
            .unwrap()
        };
        let read = scope(Vec::new());
        let write = scope(paths("fs:allow-write-file", "deny"));
        let home = app.path().home_dir().unwrap();

        for path in [
            r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\cortex-probe.bat",
            r"appdata\roaming\microsoft\windows\start menu\programs\startup\cortex-probe.bat",
            r"AppData\Local\Discord\cortex-probe.js",
            r"Application Data\Microsoft\cortex-probe.bat",
            r".ssh\cortex-probe",
            r"Documents\WindowsPowerShell\cortex-probe.ps1",
            r"Documents\cortex-probe-repo\.git\hooks\pre-commit",
            // Windows drops a trailing dot or space from a folder name and
            // resolves 8.3 short names after the scope check, for new files.
            r"AppData.\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\cortex-probe.bat",
            r"AppData \Roaming\Microsoft\Windows\Start Menu\Programs\Startup\cortex-probe.bat",
            r"Documents\cortex-probe-repo\GIT~1\hooks\pre-commit",
            r"Documents\WINDOW~1\cortex-probe.ps1",
            r"SSH~1\cortex-probe",
        ] {
            assert!(!write.is_allowed(home.join(path)), "write allowed: {path}");
        }
        for path in [
            r"AppData\Roaming\Microsoft\cortex-probe",
            r"AppData\Local\Google\cortex-probe",
            r".ssh\cortex-probe",
        ] {
            assert!(!read.is_allowed(home.join(path)), "read allowed: {path}");
        }
        for path in [
            r"Documents\cortex-probe\livery.png",
            r"Desktop\cortex-probe\stream\car.ytd",
        ] {
            assert!(write.is_allowed(home.join(path)), "write blocked: {path}");
            assert!(read.is_allowed(home.join(path)), "read blocked: {path}");
        }
    }
}
