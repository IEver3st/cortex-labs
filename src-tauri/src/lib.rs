use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager, State};

fn is_yft(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("yft"))
        .unwrap_or(false)
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
struct ModelWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    path: Mutex<Option<PathBuf>>,
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
            "meta": meta_json
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
        "meta": meta_json
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatchState::default())
        .manage(ModelWatchState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_watch,
            stop_watch,
            start_model_watch,
            stop_model_watch,
            parse_yft,
            convert_yft
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
