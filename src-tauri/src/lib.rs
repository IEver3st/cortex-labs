use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use std::collections::HashSet;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager, State};

fn is_yft(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("yft"))
        .unwrap_or(false)
}

fn is_supported_open_model(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("yft")
                || ext.eq_ignore_ascii_case("ydd")
                || ext.eq_ignore_ascii_case("dff")
                || ext.eq_ignore_ascii_case("clmesh")
        })
        .unwrap_or(false)
}

fn normalize_open_file_arg(raw: &str) -> Option<String> {
    let mut candidate = raw.trim().trim_matches('"').to_string();
    if candidate.is_empty() {
        return None;
    }

    if let Some(rest) = candidate.strip_prefix("file://") {
        let mut normalized = rest.replace("%20", " ");
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

    if let Ok(mut pending) = app.state::<PendingOpenFileState>().path.lock() {
        *pending = Some(file_path.clone());
    }

    let _ = app.emit("file-open", file_path);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > data.len() {
        return None;
    }
    Some(u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

fn find_geometry_chunk(data: &[u8], start: usize, end: usize) -> Option<usize> {
    let mut offset = start;
    while offset + 12 <= end {
        let chunk_id = read_u32_le(data, offset)?;
        let size = read_u32_le(data, offset + 4)? as usize;
        let data_start = offset + 12;
        let data_end = data_start + size;
        if data_end > end || data_end > data.len() {
            return None;
        }
        if chunk_id == 0x0F {
            return Some(offset);
        }
        if chunk_id == 0x10 || chunk_id == 0x1A || chunk_id == 0x0E {
            if let Some(found) = find_geometry_chunk(data, data_start, data_end) {
                return Some(found);
            }
        }
        offset = data_end;
    }
    None
}

fn read_dff_vertex_count(path: &Path) -> Option<u32> {
    let data = std::fs::read(path).ok()?;
    let geom_offset = find_geometry_chunk(&data, 0, data.len())?;
    let geom_start = geom_offset + 12;
    if geom_start + 24 > data.len() {
        return None;
    }
    let struct_size = read_u32_le(&data, geom_start + 4)? as usize;
    let struct_data = geom_start + 12;
    if struct_data + struct_size > data.len() || struct_data + 12 > data.len() {
        return None;
    }
    read_u32_le(&data, struct_data + 8)
}

fn find_first_file_with_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .find(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
}

fn run_yft_converter(
    work_dir: &Path,
    settings: &Path,
    col_materials: &Path,
    converter_exe: &Path,
    zlib: &Path,
    input_yft: &Path,
    input_ytd: Option<&Path>,
) -> Result<(PathBuf, Option<PathBuf>, std::process::Output, String), String> {
    if work_dir.exists() {
        std::fs::remove_dir_all(work_dir)
            .map_err(|e| format!("Failed to reset working dir: {e}"))?;
    }
    std::fs::create_dir_all(work_dir).map_err(|e| format!("Failed to create working dir: {e}"))?;

    let staged_settings = work_dir.join("GeneralSettings.ini");
    let staged_col = work_dir.join("col_gen_materials.dat");
    let staged_yft = work_dir.join("model.yft");
    let staged_exe = work_dir.join(
        converter_exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("ytdydryddyft2txddffcol.exe"),
    );
    let staged_zlib = work_dir.join(
        zlib.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("zlib1.dll"),
    );

    std::fs::copy(settings, &staged_settings)
        .map_err(|e| format!("Failed to stage settings: {e}"))?;
    std::fs::copy(col_materials, &staged_col)
        .map_err(|e| format!("Failed to stage material file: {e}"))?;
    std::fs::copy(converter_exe, &staged_exe)
        .map_err(|e| format!("Failed to stage converter: {e}"))?;
    std::fs::copy(zlib, &staged_zlib).map_err(|e| format!("Failed to stage zlib: {e}"))?;
    std::fs::copy(input_yft, &staged_yft).map_err(|e| format!("Failed to stage YFT: {e}"))?;

    if let Some(ytd) = input_ytd {
        let staged_ytd = work_dir.join("model.ytd");
        let _ = std::fs::copy(ytd, &staged_ytd);
    }

    let output = std::process::Command::new(&staged_exe)
        .current_dir(work_dir)
        .output()
        .map_err(|e| format!("Failed to run converter: {e}"))?;

    let log_path = work_dir.join("log.txt");
    let log_contents = std::fs::read_to_string(&log_path).unwrap_or_default();

    let mut produced_dff = work_dir.join("model.dff");
    if !produced_dff.exists() {
        if let Some(found) = find_first_file_with_ext(work_dir, "dff") {
            produced_dff = found;
        }
    }
    if !produced_dff.exists() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "YFT conversion failed (exit={:?}).\nSTDERR:\n{}\nSTDOUT:\n{}\nLOG:\n{}",
            output.status.code(),
            stderr.trim(),
            stdout.trim(),
            log_contents.trim()
        ));
    }

    let mut produced_txd = work_dir.join("model.txd");
    if !produced_txd.exists() {
        produced_txd = find_first_file_with_ext(work_dir, "txd").unwrap_or(produced_txd);
    }

    Ok((
        produced_dff,
        if produced_txd.exists() {
            Some(produced_txd)
        } else {
            None
        },
        output,
        log_contents,
    ))
}

#[derive(Default)]
struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct WindowWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct MultiWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    paths: Mutex<Vec<PathBuf>>,
}

#[derive(Default)]
struct ModelWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct PendingOpenFileState {
    path: Mutex<Option<String>>,
}

#[derive(serde::Serialize, Clone)]
struct WatchPayload {
    path: String,
    kind: String,
}

#[tauri::command]
fn start_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<WatchState>,
) -> Result<(), String> {
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
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
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

#[tauri::command]
fn start_window_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<WindowWatchState>,
) -> Result<(), String> {
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
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
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
fn stop_window_watch(state: State<WindowWatchState>) -> Result<(), String> {
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

#[tauri::command]
fn start_multi_watch(
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<MultiWatchState>,
) -> Result<(), String> {
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;
    let mut paths_guard = state
        .paths
        .lock()
        .map_err(|_| "path lock failed".to_string())?;

    if let Some(mut existing) = watcher_guard.take() {
        for prev_path in paths_guard.drain(..) {
            let _ = existing.unwatch(&prev_path);
        }
    }

    let mut unique: HashSet<PathBuf> = HashSet::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        unique.insert(PathBuf::from(trimmed));
    }

    if unique.is_empty() {
        return Ok(());
    }

    let app_handle = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
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

    for path_buf in unique.iter() {
        watcher
            .watch(path_buf, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }

    *paths_guard = unique.into_iter().collect();
    *watcher_guard = Some(watcher);

    Ok(())
}

#[tauri::command]
fn stop_multi_watch(state: State<MultiWatchState>) -> Result<(), String> {
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "watcher lock failed".to_string())?;
    let mut paths_guard = state
        .paths
        .lock()
        .map_err(|_| "path lock failed".to_string())?;

    if let Some(mut watcher) = watcher_guard.take() {
        for prev_path in paths_guard.drain(..) {
            let _ = watcher.unwatch(&prev_path);
        }
    }

    Ok(())
}

#[tauri::command]
fn start_model_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<ModelWatchState>,
) -> Result<(), String> {
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
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let payload = WatchPayload {
                    path: event
                        .paths
                        .get(0)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    kind: format!("{:?}", event.kind),
                };
                let _ = app_handle.emit("model:update", payload);
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
fn stop_model_watch(state: State<ModelWatchState>) -> Result<(), String> {
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

#[tauri::command]
fn parse_yft(path: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if !is_yft(&path) {
        return Err("Only .yft files are supported by parse_yft".to_string());
    }

    if !cfg!(target_os = "windows") {
        return Err("YFT parsing is only supported on Windows in this build.".to_string());
    }

    let exe_name = if cfg!(target_os = "windows") {
        "CodeWalkerBridge.exe"
    } else {
        "CodeWalkerBridge"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("codewalker-bridge")
            .join(exe_name),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("codewalker-bridge")
            .join("bin")
            .join("Release")
            .join("net10.0")
            .join(exe_name),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("codewalker-bridge")
            .join("bin")
            .join("Debug")
            .join("net10.0")
            .join(exe_name),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("codewalker-bridge")
            .join("bin")
            .join("Release")
            .join("net8.0")
            .join(exe_name),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("codewalker-bridge")
            .join("bin")
            .join("Debug")
            .join("net8.0")
            .join(exe_name),
    );
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("bin")
                .join("codewalker-bridge")
                .join(exe_name),
        );
    }

    let bridge = candidates.into_iter().find(|p| p.exists()).ok_or_else(|| {
        "Missing CodeWalker bridge executable. Build it with `dotnet publish -c Release` in `tools/codewalker-bridge`."
            .to_string()
    })?;

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {e}"))?
        .join("cortex-labs")
        .join("yft-cache");
    std::fs::create_dir_all(&cache_root).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat input: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::Hasher;
    hasher.write(path.as_bytes());
    hasher.write_u64(mtime);
    hasher.write_u64(size);
    let key = format!("{:016x}", hasher.finish());

    let out_dir = cache_root.join(&key);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create output dir: {e}"))?;
    let out_mesh = out_dir.join("model.clmesh");
    let out_meta = out_dir.join("meta.json");

    // Check for sibling YTD file (auto-discovery)
    let path_buf = PathBuf::from(&path);
    let file_stem = path_buf.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let parent = path_buf
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));

    // Try exact match first: model.yft -> model.ytd
    let mut ytd_path_buf = parent.join(format!("{}.ytd", file_stem));

    // If not found, try stripping _hi / +hi suffix: model_hi.yft -> model.ytd
    if !ytd_path_buf.exists() {
        if let Some(stripped) = file_stem
            .strip_suffix("_hi")
            .or_else(|| file_stem.strip_suffix("+hi"))
        {
            ytd_path_buf = parent.join(format!("{}.ytd", stripped));
        }
    }

    let found_ytd = if ytd_path_buf.exists() {
        Some(ytd_path_buf.to_string_lossy().to_string())
    } else {
        None
    };

    if out_mesh.exists() {
        let meta_json = if out_meta.exists() {
            std::fs::read_to_string(&out_meta)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        return Ok(serde_json::json!({
            "meshPath": out_mesh.to_string_lossy().to_string(),
            "cacheKey": key,
            "cached": true,
            "meta": meta_json,
            "ytdPath": found_ytd
        }));
    }

    let output = Command::new(&bridge)
        .arg("--input")
        .arg(&path)
        .arg("--output")
        .arg(&out_mesh)
        .output()
        .map_err(|e| format!("Failed to run CodeWalker bridge: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "CodeWalker bridge failed.\nSTDERR:\n{}\nSTDOUT:\n{}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    if !out_mesh.exists() {
        return Err("CodeWalker bridge did not produce mesh cache output.".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let meta_json = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .unwrap_or_else(|_| serde_json::json!({}));
    let _ = std::fs::write(&out_meta, meta_json.to_string());

    Ok(serde_json::json!({
        "meshPath": out_mesh.to_string_lossy().to_string(),
        "cacheKey": key,
        "cached": false,
        "meta": meta_json,
        "ytdPath": found_ytd
    }))
}

#[tauri::command]
fn convert_yft(path: String, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if !is_yft(&path) {
        return Err("Only .yft files are supported by convert_yft".to_string());
    }

    if !cfg!(target_os = "windows") {
        return Err("YFT conversion is only supported on Windows in this build.".to_string());
    }

    let converter_folder = "yft-converter";
    let converter_exe = "ytdydryddyft2txddffcol.exe";
    let converter_dll = "zlib1.dll";
    let mut candidates: Vec<PathBuf> = Vec::new();
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(converter_folder),
    );
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(converter_folder));
    }

    let converter_dir = candidates.into_iter().find(|p| p.exists()).ok_or_else(|| {
        format!(
            "Missing YFT converter folder.\n\
Place it at `src-tauri/bin/{}` for dev builds, or bundle it as a resource.\n\
See `THIRD_PARTY_NOTICES.md` for credits.",
            converter_folder
        )
    })?;

    let converter = converter_dir.join(converter_exe);
    let settings = converter_dir.join("GeneralSettings.ini");
    let vehicle_settings = converter_dir.join("GeneralSettings.vehicle.ini");
    let col_materials = converter_dir.join("col_gen_materials.dat");
    let zlib = converter_dir.join(converter_dll);

    if !converter.exists() {
        return Err(format!(
            "Missing converter executable at `{}`.",
            converter.to_string_lossy()
        ));
    }
    if !settings.exists() {
        return Err(format!(
            "Missing converter settings file at `{}`.",
            settings.to_string_lossy()
        ));
    }
    if !col_materials.exists() {
        return Err(format!(
            "Missing converter material file at `{}`.",
            col_materials.to_string_lossy()
        ));
    }
    if !zlib.exists() {
        return Err(format!(
            "Missing converter dependency `{}` at `{}`.",
            converter_dll,
            zlib.to_string_lossy()
        ));
    }

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {e}"))?
        .join("cortex-labs")
        .join("yft-cache");
    std::fs::create_dir_all(&cache_root).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat input: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::Hasher;
    hasher.write(path.as_bytes());
    hasher.write_u64(mtime);
    hasher.write_u64(size);
    let key = format!("{:016x}", hasher.finish());

    let out_dir = cache_root.join(&key);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create output dir: {e}"))?;
    let out_dff = out_dir.join("model.dff");
    let out_txd = out_dir.join("model.txd");

    if out_dff.exists() {
        let cached_vertices = read_dff_vertex_count(&out_dff).unwrap_or(0);
        if cached_vertices > 0 {
            return Ok(serde_json::json!({
                "dffPath": out_dff.to_string_lossy().to_string(),
                "txdPath": if out_txd.exists() { out_txd.to_string_lossy().to_string() } else { "".to_string() },
                "cacheKey": key,
                "cached": true,
                "vertexCount": cached_vertices
            }));
        }
        let _ = std::fs::remove_file(&out_dff);
        let _ = std::fs::remove_file(&out_txd);
    }

    let short_key = if key.len() > 12 { &key[..12] } else { &key };
    let temp_root = std::env::temp_dir().join("cl-yft");
    let mut work_dir = temp_root.join(short_key);
    if std::fs::create_dir_all(&temp_root).is_err() {
        work_dir = out_dir.join("work");
    }

    let input_ytd = Path::new(&path).with_extension("ytd");
    let input_ytd_ref = if input_ytd.exists() {
        Some(input_ytd.as_path())
    } else {
        None
    };

    let mut settings_path = settings;
    let mut run = run_yft_converter(
        &work_dir,
        &settings_path,
        &col_materials,
        &converter,
        &zlib,
        Path::new(&path),
        input_ytd_ref,
    )?;

    let mut vertex_count = read_dff_vertex_count(&run.0).unwrap_or(0);
    if vertex_count == 0 && vehicle_settings.exists() {
        settings_path = vehicle_settings;
        run = run_yft_converter(
            &work_dir,
            &settings_path,
            &col_materials,
            &converter,
            &zlib,
            Path::new(&path),
            input_ytd_ref,
        )?;
        vertex_count = read_dff_vertex_count(&run.0).unwrap_or(0);
    }

    if vertex_count == 0 {
        let stderr = String::from_utf8_lossy(&run.2.stderr);
        let stdout = String::from_utf8_lossy(&run.2.stdout);
        return Err(format!(
            "YFT converter produced a DFF with 0 vertices. This YFT likely uses a newer vertex format not supported by the bundled converter.\n\
STDERR:\n{}\nSTDOUT:\n{}\nLOG:\n{}",
            stderr.trim(),
            stdout.trim(),
            run.3.trim()
        ));
    }

    std::fs::copy(&run.0, &out_dff).map_err(|e| format!("Failed to store .dff: {e}"))?;
    if let Some(txd) = run.1.as_ref() {
        let _ = std::fs::copy(txd, &out_txd);
    }

    Ok(serde_json::json!({
        "dffPath": out_dff.to_string_lossy().to_string(),
        "txdPath": if out_txd.exists() { out_txd.to_string_lossy().to_string() } else { "".to_string() },
        "cacheKey": key,
        "cached": false,
        "exitCode": run.2.status.code(),
        "vertexCount": vertex_count
    }))
}

#[tauri::command]
fn consume_pending_open_file(state: State<PendingOpenFileState>) -> Option<String> {
    state
        .path
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path is empty".to_string());
    }

    std::fs::create_dir_all(PathBuf::from(path)).map_err(|e| e.to_string())
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

/// Decode a Paint.NET (.pdn) file into raw RGBA pixel data.
/// Returns base64-encoded RGBA pixels plus width/height.
#[tauri::command]
fn decode_pdn(path: String) -> Result<serde_json::Value, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let data = std::fs::read(&path).map_err(|e| format!("Failed to read PDN file: {e}"))?;

    // Validate PDN3 magic
    if data.len() < 24 || &data[0..4] != b"PDN3" {
        return Err("Not a valid Paint.NET file (missing PDN3 magic).".to_string());
    }

    // Find image dimensions by scanning for "width" and "height" field names
    // in the .NET BinaryFormatter stream
    let (width, height) = extract_pdn_dimensions(&data)
        .ok_or_else(|| "Could not extract image dimensions from PDN file.".to_string())?;

    if width == 0 || height == 0 || width > 65536 || height > 65536 {
        return Err(format!("Invalid PDN dimensions: {width}x{height}"));
    }

    // Find and decompress all gzip chunks
    let mut gzip_offsets = Vec::new();
    let mut i = 24;
    while i + 2 < data.len() {
        if data[i] == 0x1F && data[i + 1] == 0x8B && i + 2 < data.len() && data[i + 2] == 0x08 {
            gzip_offsets.push(i);
            i += 18; // skip minimum gzip overhead
        } else {
            i += 1;
        }
    }

    if gzip_offsets.is_empty() {
        return Err("No compressed pixel data found in PDN file.".to_string());
    }

    // Decompress all chunks first.
    let mut inflated_chunks: Vec<Vec<u8>> = Vec::new();

    for offset in &gzip_offsets {
        let slice = &data[*offset..];
        let mut decoder = GzDecoder::new(slice);
        let mut inflated = Vec::new();
        if decoder.read_to_end(&mut inflated).is_err() || inflated.is_empty() {
            continue;
        }

        inflated_chunks.push(inflated);
    }

    if inflated_chunks.is_empty() {
        return Err("Failed to decompress any pixel data from PDN file.".to_string());
    }

    // Width/height extraction can occasionally return swapped values.
    // If chunk alignment strongly suggests a swap, correct it.
    let mut width_usize = width as usize;
    let mut height_usize = height as usize;
    maybe_swap_pdn_dimensions_by_alignment(&inflated_chunks, &mut width_usize, &mut height_usize);

    let expected_size = width_usize.saturating_mul(height_usize).saturating_mul(4);
    if expected_size == 0 {
        return Err("PDN decode produced invalid output dimensions.".to_string());
    }

    let row_bytes = width_usize.saturating_mul(4);
    let has_row_misalignment = row_bytes > 0
        && inflated_chunks
            .iter()
            .any(|chunk| chunk.len() >= row_bytes && chunk.len() % row_bytes != 0);

    // If chunks are not row-aligned, strip small per-chunk metadata/header bytes.
    let mut layers = assemble_pdn_layers(
        &inflated_chunks,
        width_usize,
        height_usize,
        has_row_misalignment,
    );
    if layers.is_empty() {
        // Fallback to raw concatenation if trimmed assembly yielded nothing.
        layers = assemble_pdn_layers(&inflated_chunks, width_usize, height_usize, false);
    }
    if layers.is_empty() {
        return Err("Failed to reconstruct any PDN layers from decompressed data.".to_string());
    }

    // Composite layers bottom-to-top, converting BGRA → RGBA
    let mut rgba = vec![0u8; expected_size];
    for layer in &layers {
        let len = std::cmp::min(layer.len(), expected_size);
        let mut j = 0;
        while j + 3 < len {
            let pix = (j / 4) * 4;
            if pix + 3 >= rgba.len() {
                break;
            }

            let src_b = layer[j];
            let src_g = layer[j + 1];
            let src_r = layer[j + 2];
            let src_a = layer[j + 3];

            if src_a == 0 {
                j += 4;
                continue;
            }

            let dst_a = rgba[pix + 3];
            if src_a == 255 || dst_a == 0 {
                rgba[pix] = src_r;
                rgba[pix + 1] = src_g;
                rgba[pix + 2] = src_b;
                rgba[pix + 3] = src_a;
            } else {
                let sa = src_a as f32 / 255.0;
                let da = dst_a as f32 / 255.0;
                let out_a = sa + da * (1.0 - sa);
                if out_a > 0.0 {
                    rgba[pix] =
                        ((src_r as f32 * sa + rgba[pix] as f32 * da * (1.0 - sa)) / out_a) as u8;
                    rgba[pix + 1] = ((src_g as f32 * sa + rgba[pix + 1] as f32 * da * (1.0 - sa))
                        / out_a) as u8;
                    rgba[pix + 2] = ((src_b as f32 * sa + rgba[pix + 2] as f32 * da * (1.0 - sa))
                        / out_a) as u8;
                    rgba[pix + 3] = (out_a * 255.0) as u8;
                }
            }

            j += 4;
        }
    }

    // Encode as base64 for transfer to frontend
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&rgba);

    Ok(serde_json::json!({
        "width": width_usize,
        "height": height_usize,
        "rgba_base64": encoded
    }))
}

fn maybe_swap_pdn_dimensions_by_alignment(
    chunks: &[Vec<u8>],
    width: &mut usize,
    height: &mut usize,
) {
    if *width == 0 || *height == 0 || *width == *height {
        return;
    }

    let row_a = width.saturating_mul(4);
    let row_b = height.saturating_mul(4);
    if row_a == 0 || row_b == 0 {
        return;
    }

    let aligned_a = chunks
        .iter()
        .filter(|chunk| chunk.len() >= row_a && chunk.len() % row_a == 0)
        .count();
    let aligned_b = chunks
        .iter()
        .filter(|chunk| chunk.len() >= row_b && chunk.len() % row_b == 0)
        .count();

    if aligned_b > aligned_a && aligned_b >= chunks.len().saturating_div(2) {
        std::mem::swap(width, height);
    }
}

fn assemble_pdn_layers(
    chunks: &[Vec<u8>],
    width: usize,
    height: usize,
    trim_chunk_headers: bool,
) -> Vec<Vec<u8>> {
    let expected_size = width.saturating_mul(height).saturating_mul(4);
    let row_bytes = width.saturating_mul(4);
    if expected_size == 0 {
        return Vec::new();
    }

    let mut layers: Vec<Vec<u8>> = Vec::new();
    let mut current_layer: Vec<u8> = Vec::with_capacity(expected_size);

    for chunk in chunks {
        let payload = if trim_chunk_headers {
            select_pdn_chunk_payload(chunk, row_bytes)
        } else {
            (0, chunk.len())
        };
        if payload.1 <= payload.0 || payload.1 > chunk.len() {
            continue;
        }

        current_layer.extend_from_slice(&chunk[payload.0..payload.1]);

        while current_layer.len() >= expected_size {
            let layer = current_layer.drain(..expected_size).collect::<Vec<u8>>();
            layers.push(layer);
        }
    }

    // Keep non-empty trailing data as a partial layer and pad to full image size.
    if current_layer.len() >= row_bytes.max(1) {
        current_layer.resize(expected_size, 0);
        layers.push(current_layer);
    }

    layers
}

fn select_pdn_chunk_payload(chunk: &[u8], row_bytes: usize) -> (usize, usize) {
    if row_bytes == 0 || chunk.len() <= row_bytes {
        return (0, chunk.len());
    }

    let max_trim = std::cmp::min(64, chunk.len().saturating_sub(1));
    let mut best: Option<(usize, usize, usize)> = None;

    for lead in 0..=max_trim {
        for trail in 0..=max_trim {
            if lead + trail >= chunk.len() {
                continue;
            }
            let payload_len = chunk.len() - lead - trail;
            if payload_len < row_bytes || payload_len % row_bytes != 0 {
                continue;
            }
            let rows = payload_len / row_bytes;
            if rows == 0 || rows > 8192 {
                continue;
            }
            let discarded = lead + trail;
            match best {
                None => best = Some((lead, chunk.len() - trail, discarded)),
                Some((best_start, best_end, best_discarded)) => {
                    let best_payload_len = best_end.saturating_sub(best_start);
                    if discarded < best_discarded
                        || (discarded == best_discarded && payload_len > best_payload_len)
                    {
                        best = Some((lead, chunk.len() - trail, discarded));
                    }
                }
            }
        }
    }

    if let Some((start, end, _)) = best {
        return (start, end);
    }

    let aligned_len = chunk.len() - (chunk.len() % row_bytes);
    if aligned_len >= row_bytes {
        return (0, aligned_len);
    }

    (0, chunk.len())
}

/// Extract width and height from a PDN file's .NET BinaryFormatter stream.
fn extract_pdn_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let mut width: u32 = 0;
    let mut height: u32 = 0;

    // Scan for "width" and "height" length-prefixed strings
    let width_needle = b"width";
    let height_needle = b"height";

    for i in 0..data.len().saturating_sub(10) {
        // .NET BinaryFormatter writes field names as length-prefixed strings
        if data[i] == width_needle.len() as u8 && i + 1 + width_needle.len() < data.len() {
            if &data[i + 1..i + 1 + width_needle.len()] == width_needle {
                // Scan forward for a reasonable Int32 value
                width = scan_for_dimension(data, i + 1 + width_needle.len());
            }
        }
        if data[i] == height_needle.len() as u8 && i + 1 + height_needle.len() < data.len() {
            if &data[i + 1..i + 1 + height_needle.len()] == height_needle {
                height = scan_for_dimension(data, i + 1 + height_needle.len());
            }
        }
        if width > 0 && height > 0 {
            return Some((width, height));
        }
    }

    // Fallback: scan for dimension pair in the header area
    for i in 24..std::cmp::min(data.len().saturating_sub(8), 4096) {
        let a = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        let b = u32::from_le_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]);
        if (16..=16384).contains(&a)
            && (16..=16384).contains(&b)
            && a.is_power_of_two()
            && b.is_power_of_two()
        {
            return Some((a, b));
        }
    }

    None
}

/// Scan forward from a position to find a reasonable dimension value.
fn scan_for_dimension(data: &[u8], from: usize) -> u32 {
    for off in from..std::cmp::min(from + 64, data.len().saturating_sub(4)) {
        let val = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
        if (1..=65536).contains(&val) && (val.is_power_of_two() || val % 64 == 0 || val % 100 == 0)
        {
            return val;
        }
    }
    for off in from..std::cmp::min(from + 64, data.len().saturating_sub(4)) {
        let val = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
        if (16..=65536).contains(&val) {
            return val;
        }
    }
    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatchState::default())
        .manage(WindowWatchState::default())
        .manage(MultiWatchState::default())
        .manage(ModelWatchState::default())
        .manage(PendingOpenFileState::default())
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
            start_watch,
            stop_watch,
            start_window_watch,
            stop_window_watch,
            start_multi_watch,
            stop_multi_watch,
            start_model_watch,
            stop_model_watch,
            parse_yft,
            convert_yft,
            consume_pending_open_file,
            ensure_dir,
            open_folder_fallback,
            decode_pdn
        ])
        .setup(|app| {
            // On Windows, "Open With" passes the file path as a CLI argument.
            // Queue it so the frontend can consume it once listeners are mounted.
            let args: Vec<String> = std::env::args().collect();
            if let Some(file_path) = extract_open_file_arg(&args) {
                if let Ok(mut pending) = app.state::<PendingOpenFileState>().path.lock() {
                    *pending = Some(file_path);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
