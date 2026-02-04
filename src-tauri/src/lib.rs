use std::{path::PathBuf, sync::Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, State};

#[derive(Default)]
struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<PathBuf>>,
}

#[derive(serde::Serialize, Clone)]
struct WatchPayload {
    path: String,
    kind: String,
}

#[tauri::command]
fn start_watch(path: String, app: tauri::AppHandle, state: State<WatchState>) -> Result<(), String> {
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;
    let mut path_guard = state
        .path
        .lock()
        .map_err(|_| "path lock failed".to_string())?;

    if let Some(mut existing) = watcher_guard.take() {
        if let Some(prev_path) = path_guard.take() {
            let _ = existing.unwatch(&prev_path);
        }
    }

    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            let payload = WatchPayload {
                path: event
                    .paths
                    .get(0)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                kind: format!("{:?}", event.kind),
            };
            let _ = app_handle.emit("texture:update", payload);
        }
    })
    .map_err(|e| e.to_string())?;

    let path_buf = PathBuf::from(&path);
    watcher
        .watch(&path_buf, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *path_guard = Some(path_buf);
    *watcher_guard = Some(watcher);

    Ok(())
}

#[tauri::command]
fn stop_watch(state: State<WatchState>) -> Result<(), String> {
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;
    let mut path_guard = state
        .path
        .lock()
        .map_err(|_| "path lock failed".to_string())?;

    if let Some(mut watcher) = watcher_guard.take() {
        if let Some(prev_path) = path_guard.take() {
            let _ = watcher.unwatch(&prev_path);
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatchState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![start_watch, stop_watch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
