//! Pack sheet snapshots: one small JPEG per vehicle model, taken by the viewer
//! while that vehicle is open and kept in `vehicle-snapshots/` in the app
//! cache. The renderer never names a file: the key is derived here from the
//! model path, and only a JPEG under the size cap is written.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::app_cache_root;

const SNAPSHOT_DIR: &str = "vehicle-snapshots";
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;
const MAX_INDEX_PATHS: usize = 5000;
/// Past this many snapshots, the oldest are removed down to the target.
const PRUNE_TRIGGER: usize = 3000;
const PRUNE_TARGET: usize = 2400;
/// Bump when snapshots taken earlier should no longer be shown.
const KEY_REVISION: &[u8] = b"vehicle-snapshot-v1";
/// Numbers each save's partial file, so two saves of one model never share one.
static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The file a model's snapshot is kept in: the model path with separators
/// unified and case folded, as Windows paths compare, hashed.
fn snapshot_name(model_path: &str) -> Result<String, String> {
    let normalized = model_path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    if !(normalized.ends_with(".yft") || normalized.ends_with(".clmesh")) {
        return Err("A snapshot belongs to a .yft or .clmesh model.".into());
    }
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(KEY_REVISION);
    hasher.write(normalized.as_bytes());
    Ok(format!("{:016x}.jpg", hasher.finish()))
}

fn modified_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let time = meta.modified().ok()?;
    Some(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(u64, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jpg"))
        .map(|path| (modified_ms(&path).unwrap_or(0), path))
        .collect();
    if files.len() <= PRUNE_TRIGGER {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let excess = files.len() - PRUNE_TARGET;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// For each model path, when its snapshot was taken (ms since the epoch), or
/// null when it has none.
#[tauri::command]
pub async fn vehicle_snapshot_index(
    model_paths: Vec<String>,
    app: tauri::AppHandle,
) -> Result<Vec<Option<u64>>, String> {
    if model_paths.len() > MAX_INDEX_PATHS {
        return Err(format!(
            "Snapshot lookup is limited to {MAX_INDEX_PATHS} models."
        ));
    }
    let dir = app_cache_root(&app, SNAPSHOT_DIR)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(model_paths
            .iter()
            .map(|path| {
                snapshot_name(path)
                    .ok()
                    .and_then(|name| modified_ms(&dir.join(name)))
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Failed to join snapshot lookup: {e}"))?
}

/// The model's snapshot as JPEG bytes; empty when it has none.
#[tauri::command]
pub async fn read_vehicle_snapshot(
    model_path: String,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let file = app_cache_root(&app, SNAPSHOT_DIR)?.join(snapshot_name(&model_path)?);
    tauri::async_runtime::spawn_blocking(move || match std::fs::read(&file) {
        Ok(bytes) => Ok(tauri::ipc::Response::new(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(tauri::ipc::Response::new(Vec::new()))
        }
        Err(error) => Err(format!("Failed to read the snapshot: {error}")),
    })
    .await
    .map_err(|e| format!("Failed to join snapshot read: {e}"))?
}

/// Keeps `jpeg` as the model's snapshot, replacing any earlier one. Returns
/// when it was taken (ms since the epoch).
#[tauri::command]
pub async fn save_vehicle_snapshot(
    model_path: String,
    jpeg: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    if jpeg.len() > MAX_SNAPSHOT_BYTES {
        return Err("The snapshot is larger than 512 KiB.".into());
    }
    if !jpeg.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err("A snapshot must be a JPEG image.".into());
    }
    let name = snapshot_name(&model_path)?;
    let dir = app_cache_root(&app, SNAPSHOT_DIR)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create the snapshot folder: {e}"))?;
        let file = dir.join(&name);
        // Written beside and renamed over, so a reader never sees half a file.
        let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let partial = dir.join(format!("{name}.{}-{sequence}.partial", std::process::id()));
        std::fs::write(&partial, &jpeg).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            format!("Failed to save the snapshot: {e}")
        })?;
        std::fs::rename(&partial, &file).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            format!("Failed to save the snapshot: {e}")
        })?;
        prune(&dir);
        modified_ms(&file).ok_or_else(|| "The saved snapshot could not be read back.".to_string())
    })
    .await
    .map_err(|e| format!("Failed to join snapshot save: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::snapshot_name;

    #[test]
    fn a_model_has_one_snapshot_whatever_its_separators_or_case() {
        let name = snapshot_name("C:\\Pack\\stream\\Car_hi.yft").unwrap();
        assert_eq!(name, snapshot_name("c:/pack/stream/car_HI.yft").unwrap());
        assert_eq!(name, snapshot_name(" C:/Pack/stream/Car_hi.yft ").unwrap());
        assert_ne!(name, snapshot_name("C:/Pack/stream/Other_hi.yft").unwrap());
        assert!(name.ends_with(".jpg") && !name.contains('/') && !name.contains('\\'));
    }

    #[test]
    fn only_models_have_snapshots() {
        assert!(snapshot_name("C:/Pack/stream/car.ytd").is_err());
        assert!(snapshot_name("C:/Pack/stream").is_err());
        assert!(snapshot_name("C:/Pack/cache/car.clmesh").is_ok());
    }
}
