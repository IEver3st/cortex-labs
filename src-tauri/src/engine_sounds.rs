use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{app_cache_root, bridge_request, lock_ignoring_poison};

const ROOT: &str = "engine-sounds";
const LIBRARY: &str = "library.json";
const MARKER: &str = ".cortex-engine-sounds.json";
const ARCHIVES: &[&str] = &["zip", "rar", "7z", "oiv"];
const KEPT_FILES: &[&str] = &[
    "rel",
    "awc",
    "rpf",
    "lua",
    "txt",
    "md",
    "xml",
    "oiv",
    "zip",
    "rar",
    "7z",
    "png",
    "wav",
    "nametable",
];
const MAX_ENTRIES: usize = 4000;
const MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH: usize = 2;
const MAX_README_BYTES: usize = 16 * 1024;
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(300);
const STAGE_REVISION: &str = "stage-v1";
const PREVIEW_REVISION: &str = "preview-v1";

static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
static DROPPED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
const DROPPED_LIMIT: usize = 64;

pub fn remember_drop(paths: &[PathBuf]) {
    let mut dropped = lock_ignoring_poison(&DROPPED);
    for path in paths {
        if let Ok(real) = path.canonicalize() {
            dropped.retain(|p| p != &real);
            dropped.push(real);
        }
    }
    let excess = dropped.len().saturating_sub(DROPPED_LIMIT);
    dropped.drain(..excess);
}

fn was_dropped(path: &Path) -> bool {
    path.canonicalize()
        .is_ok_and(|real| lock_ignoring_poison(&DROPPED).contains(&real))
}

#[derive(Deserialize, Clone)]
pub struct PackRef {
    id: String,
    source: String,
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_cache_root(app, ROOT)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn user_chose(app: &tauri::AppHandle, path: &Path) -> bool {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope.is_allowed(path)
        || path.canonicalize().is_ok_and(|p| scope.is_allowed(p))
        || was_dropped(path)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hash_hex(parts: &[&[u8]]) -> String {
    let mut fnv1a: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for &byte in part.iter().chain(std::iter::once(&0xff)) {
            fnv1a ^= u64::from(byte);
            fnv1a = fnv1a.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{fnv1a:016x}")
}

fn content_hash(path: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    Ok(hash_hex(&[&bytes]))
}

fn valid_id(id: &str) -> Result<&str, String> {
    if id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(id)
    } else {
        Err("That engine sound isn't in the library.".into())
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn read_library(dir: &Path) -> Vec<Value> {
    std::fs::read(dir.join(LIBRARY))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default()
}

fn write_library(dir: &Path, entries: &[Value]) -> Result<(), String> {
    let path = dir.join(LIBRARY);
    let temp = dir.join(format!("{LIBRARY}.partial"));
    let text = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(&temp, text)
        .map_err(|e| format!("Couldn't save the engine sound library: {e}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|e| format!("Couldn't save the engine sound library: {e}"))
}

fn system_tar() -> Result<PathBuf, String> {
    let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let tar = PathBuf::from(windows).join("System32").join("tar.exe");
    if tar.is_file() {
        Ok(tar)
    } else {
        Err("Windows' archive tool (System32\\tar.exe) is missing, so Studio can't open .zip, .rar or .7z downloads. Extract the download yourself and import the folder.".into())
    }
}

fn run_tar(args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    let mut command = Command::new(system_tar()?);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .output()
        .map_err(|e| format!("Couldn't run the archive tool: {e}"))
}

fn safe_entry(name: &str) -> bool {
    let trimmed = name.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.contains(':') || trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return false;
    }
    Path::new(&trimmed.replace('\\', "/"))
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

fn declared_bytes(archive: &Path) -> u64 {
    run_tar(&["-tvf".as_ref(), archive.as_os_str()])
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.split_whitespace().nth(4)?.parse::<u64>().ok())
                .sum()
        })
        .unwrap_or(0)
}

fn extract_archive(archive: &Path, dest: &Path, budget: &mut u64) -> Result<(), String> {
    let declared = declared_bytes(archive);
    if declared > *budget {
        return Err("This download unpacks to more than 3 GB.".into());
    }
    *budget -= declared;
    let listed = run_tar(&["-tf".as_ref(), archive.as_os_str()])?;
    if !listed.status.success() {
        return Err(format!(
            "{} isn't an archive Studio can open ({}).",
            archive.file_name().unwrap_or_default().to_string_lossy(),
            String::from_utf8_lossy(&listed.stderr).trim()
        ));
    }
    let names = String::from_utf8_lossy(&listed.stdout);
    let mut count = 0;
    for name in names.lines() {
        count += 1;
        if count > MAX_ENTRIES {
            return Err(format!("This download has more than {MAX_ENTRIES} files."));
        }
        if !safe_entry(name) {
            return Err(format!(
                "This download has an unsafe path inside it ({name}), so Studio won't extract it."
            ));
        }
    }
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Couldn't create {}: {e}", dest.display()))?;
    let done = run_tar(&[
        "-xf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        dest.as_os_str(),
    ])?;
    if !done.status.success() {
        return Err(format!(
            "Couldn't extract {}: {}",
            archive.file_name().unwrap_or_default().to_string_lossy(),
            String::from_utf8_lossy(&done.stderr).trim()
        ));
    }
    Ok(())
}

fn verify_tree(dest: &Path) -> Result<(), String> {
    let base = dest
        .canonicalize()
        .map_err(|e| format!("Couldn't read {}: {e}", dest.display()))?;
    let mut total = 0u64;
    let mut count = 0usize;
    let mut stack = vec![dest.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                return Err(format!(
                    "{} is a link, which an engine sound download never needs.",
                    path.display()
                ));
            }
            let real = path.canonicalize().map_err(|e| e.to_string())?;
            if !real.starts_with(&base) {
                return Err(format!(
                    "{} lands outside the import folder.",
                    path.display()
                ));
            }
            count += 1;
            if count > MAX_ENTRIES {
                return Err(format!("This download has more than {MAX_ENTRIES} files."));
            }
            if meta.is_dir() {
                stack.push(path);
            } else {
                total += meta.len();
                if total > MAX_TOTAL_BYTES {
                    return Err("This download unpacks to more than 3 GB.".into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(kind) if kind.is_file() => found.push(path),
                _ => {}
            }
        }
    }
    found.sort();
    found
}

fn expand_nested(dir: &Path, depth: usize, budget: &mut u64) -> Result<(), String> {
    if depth >= MAX_ARCHIVE_DEPTH {
        return Ok(());
    }
    for archive in files_under(dir)
        .into_iter()
        .filter(|p| ARCHIVES.contains(&extension(p).as_str()))
    {
        let target = archive.with_file_name(format!(
            "{}.unpacked",
            archive.file_name().unwrap_or_default().to_string_lossy()
        ));
        if target.exists() {
            continue;
        }
        extract_archive(&archive, &target, budget)?;
        verify_tree(&target)?;
        expand_nested(&target, depth + 1, budget)?;
    }
    Ok(())
}

fn copy_folder(src: &Path, dest: &Path) -> Result<(), String> {
    let mut total = 0u64;
    let files = files_under(src);
    if files.len() > MAX_ENTRIES {
        return Err(format!("That folder has more than {MAX_ENTRIES} files."));
    }
    for file in files {
        if !KEPT_FILES.contains(&extension(&file).as_str()) {
            continue;
        }
        let relative = file.strip_prefix(src).map_err(|e| e.to_string())?;
        let target = dest.join(relative);
        total += std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        if total > MAX_TOTAL_BYTES {
            return Err("That folder holds more than 3 GB of audio and archives.".into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&file, &target)
            .map_err(|e| format!("Couldn't copy {}: {e}", file.display()))?;
    }
    Ok(())
}

fn readme_text(dir: &Path) -> String {
    let mut text = String::new();
    for file in files_under(dir)
        .into_iter()
        .filter(|p| matches!(extension(p).as_str(), "txt" | "md"))
        .take(4)
    {
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let body = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_README_BYTES)]).to_string();
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        text.push_str(&format!("{name}\n{}\n\n", body.trim()));
    }
    for assembly in files_under(dir)
        .into_iter()
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("assembly.xml"))
        })
        .take(2)
    {
        let Ok(xml) = std::fs::read_to_string(&assembly) else {
            continue;
        };
        if let Some(description) = between(&xml, "<description><![CDATA[", "]]></description>") {
            let author = between(&xml, "<displayName>", "</displayName>").unwrap_or_default();
            text.push_str(&format!(
                "OpenIV package by {author}\n{}\n\n",
                description.trim()
            ));
        }
    }
    text.chars().take(MAX_README_BYTES).collect()
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(text[from..to].to_string())
}

fn import_id(path: &Path) -> Result<String, String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut listing = String::new();
    if meta.is_dir() {
        for file in files_under(path).into_iter().take(MAX_ENTRIES) {
            let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            listing.push_str(&format!("{}:{size};", file.display()));
        }
    }
    Ok(hash_hex(&[
        canonical.to_string_lossy().to_lowercase().as_bytes(),
        &meta.len().to_le_bytes(),
        &modified.to_le_bytes(),
        listing.as_bytes(),
    ]))
}

fn stage_into(app: &tauri::AppHandle, src: &Path, origin: &Path) -> Result<&'static str, String> {
    if origin.is_dir() {
        copy_folder(origin, &src.join(origin.file_name().unwrap_or_default()))?;
        let mut budget = MAX_TOTAL_BYTES;
        expand_nested(src, 0, &mut budget)?;
        return Ok("folder");
    }
    let ext = extension(origin);
    if ext == "rpf" {
        let folder = src.join(
            origin
                .parent()
                .and_then(|p| p.file_name())
                .unwrap_or_else(|| "pack".as_ref()),
        );
        let resident = origin
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("resident.rpf"));
        let kept = if resident { "RESIDENT.rpf" } else { "dlc.rpf" };
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        std::fs::copy(origin, folder.join(kept))
            .map_err(|e| format!("Couldn't copy the {kept}: {e}"))?;
        return Ok("rpf");
    }
    if ARCHIVES.contains(&ext.as_str()) {
        let mut budget = MAX_TOTAL_BYTES;
        extract_archive(origin, src, &mut budget)?;
        verify_tree(src)?;
        expand_nested(src, 0, &mut budget)?;
        return Ok("archive");
    }
    let _ = app;
    Err("Import a .zip, .rar, .7z or .oiv download, a dlc.rpf, or a folder.".into())
}

fn inspect(app: &tauri::AppHandle, src: &Path) -> Result<Value, String> {
    bridge_request(
        app,
        "inspectEngineAudio",
        json!({ "root": src.display().to_string() }),
        BRIDGE_TIMEOUT,
    )
}

#[tauri::command]
pub async fn engine_sounds_library(app: tauri::AppHandle) -> Result<Value, String> {
    let dir = root(&app)?;
    Ok(Value::Array(read_library(&dir)))
}

#[tauri::command]
pub async fn engine_sounds_import(
    path: String,
    gta_folder: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gta = chosen_gta_folder(&app, gta_folder.as_deref());
        import_blocking(&app, PathBuf::from(path.trim()), gta.as_deref())
    })
    .await
    .map_err(|e| format!("The import stopped: {e}"))?
}

fn import_blocking(
    app: &tauri::AppHandle,
    origin: PathBuf,
    gta: Option<&Path>,
) -> Result<Value, String> {
    if !origin.exists() {
        return Err(format!("{} isn't there any more.", origin.display()));
    }
    if !user_chose(app, &origin) {
        return Err("Pick or drop the download in Studio to import it.".into());
    }
    let dir = root(app)?;
    let id = import_id(&origin)?;
    {
        let _guard = lock_ignoring_poison(&LIBRARY_LOCK);
        if let Some(existing) = read_library(&dir).into_iter().find(|e| e["id"] == id) {
            return Ok(existing);
        }
    }
    let home = dir.join(&id);
    let partial = dir.join(format!("{id}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(partial.join("src")).map_err(|e| e.to_string())?;
    let outcome = (|| -> Result<Value, String> {
        let kind = stage_into(app, &partial.join("src"), &origin)?;
        let mut report = inspect(app, &partial.join("src"))?;
        if report["escrowed"].as_bool() == Some(true) {
            return Err("This download contains an escrowed (.fxap) resource. Studio doesn't open escrowed resources; install it the way its seller describes.".into());
        }
        let engines: usize = report["sources"]
            .as_array()
            .map(|s| {
                s.iter()
                    .map(|s| s["engines"].as_array().map_or(0, Vec::len))
                    .sum()
            })
            .unwrap_or(0);
        let sirens = sirens_for_import(app, &partial.join("src"), gta, engines)?;
        if engines == 0 && sirens.as_array().is_none_or(|list| list.is_empty()) {
            let orphans = report["orphanAwcs"].as_array().map_or(0, Vec::len);
            return Err(if orphans > 0 {
                "This download replaces sounds that are already in the game instead of adding a new engine sound or siren. Follow the mod's own instructions for it.".into()
            } else {
                "Studio didn't find an engine sound or a siren in this download.".into()
            });
        }
        let readme = readme_text(&partial.join("src"));
        let sources = report["sources"].take();
        Ok(json!({
            "id": id,
            "name": origin.file_name().unwrap_or_default().to_string_lossy(),
            "origin": origin.display().to_string(),
            "kind": kind,
            "importedAt": now_ms(),
            "readme": readme,
            "sources": sources,
            "sirens": sirens,
        }))
    })();
    let mut entry = match outcome {
        Ok(entry) => entry,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(error);
        }
    };
    rebase_paths(&mut entry, &partial, &home);
    let _ = std::fs::remove_dir_all(&home);
    std::fs::rename(&partial, &home).map_err(|e| format!("Couldn't finish the import: {e}"))?;
    let _guard = lock_ignoring_poison(&LIBRARY_LOCK);
    let mut library = read_library(&dir);
    library.retain(|e| e["id"] != entry["id"]);
    library.insert(0, entry.clone());
    write_library(&dir, &library)?;
    Ok(entry)
}

#[tauri::command]
pub async fn engine_sounds_remove(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let id = valid_id(&id)?.to_string();
    let dir = root(&app)?;
    let _guard = lock_ignoring_poison(&LIBRARY_LOCK);
    let mut library = read_library(&dir);
    library.retain(|e| e["id"] != id.as_str());
    write_library(&dir, &library)?;
    let _ = std::fs::remove_dir_all(dir.join(&id));
    Ok(())
}

fn rebase_paths(value: &mut Value, from: &Path, to: &Path) {
    match value {
        Value::String(text) => {
            if let Ok(rest) = Path::new(text.as_str()).strip_prefix(from) {
                *text = to.join(rest).display().to_string();
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| rebase_paths(item, from, to)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| rebase_paths(item, from, to)),
        _ => {}
    }
}

fn import_file(dir: &Path, id: &str, recorded: &str) -> Result<PathBuf, String> {
    let src = dir.join(valid_id(id)?).join("src");
    let path = Path::new(recorded);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        src.join(path)
    };
    if path.components().any(|c| c == Component::ParentDir) || !path.starts_with(&src) {
        return Err(format!(
            "{recorded} isn't inside this import. Remove the download and import it again."
        ));
    }
    Ok(path)
}

fn find_source(dir: &Path, pack: &PackRef) -> Result<(Value, Value), String> {
    let id = valid_id(&pack.id)?;
    let entry = read_library(dir)
        .into_iter()
        .find(|e| e["id"] == id)
        .ok_or("That engine sound isn't in the library any more.")?;
    let source = entry["sources"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == pack.source.as_str()))
        .cloned()
        .ok_or("That sound pack isn't in this import any more.")?;
    Ok((entry, source))
}

#[tauri::command]
pub async fn engine_sounds_preview(
    id: String,
    source: String,
    audio_name: String,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root(&app)?;
        let pack = PackRef { id, source };
        let (entry, found) = find_source(&dir, &pack)?;
        let named = found["engines"]
            .as_array()
            .is_some_and(|e| e.iter().any(|e| e["audioName"] == audio_name.as_str()));
        if !named {
            return Err(format!("{audio_name} isn't in that pack."));
        }
        let key = hash_hex(&[PREVIEW_REVISION.as_bytes(), pack.source.as_bytes(), audio_name.as_bytes()]);
        let out = dir.join(entry["id"].as_str().unwrap_or_default()).join("preview").join(key);
        let cached = out.join("result.json");
        if let Some(value) = std::fs::read(&cached)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            return Ok(value);
        }
        let _ = std::fs::remove_dir_all(&out);
        let result = bridge_request(
            &app,
            "decodeEngineAudio",
            json!({
                "root": dir.join(entry["id"].as_str().unwrap_or_default()).join("src").display().to_string(),
                "source": pack.source,
                "audioName": audio_name,
                "outputDir": out.display().to_string(),
            }),
            BRIDGE_TIMEOUT,
        )?;
        std::fs::write(&cached, serde_json::to_vec(&result).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Couldn't cache the preview: {e}"))?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("The preview stopped: {e}"))?
}

#[tauri::command]
pub async fn engine_sounds_read_wav(
    path: String,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let dir = root(&app)?;
    let file = PathBuf::from(path);
    let real = file
        .canonicalize()
        .map_err(|e| format!("Couldn't read {}: {e}", file.display()))?;
    let base = dir.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&base) || extension(&real) != "wav" {
        return Err("Studio only reads its own engine sound previews here.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&real)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Staged {
    dir: PathBuf,
    data_files: Vec<(String, String)>,
    files: Vec<String>,
    audio_names: Vec<String>,
    label: String,
    readme: String,
    origin: String,
    kind: String,
    rpf: Option<PathBuf>,
}

fn stage(app: &tauri::AppHandle, dir: &Path, pack: &PackRef) -> Result<Staged, String> {
    let (entry, source) = find_source(dir, pack)?;
    let id = entry["id"].as_str().unwrap_or_default();
    let key = hash_hex(&[STAGE_REVISION.as_bytes(), pack.source.as_bytes()]);
    let out = dir.join(id).join("stage").join(&key);
    let manifest = out.join("staged.json");
    let staged = match std::fs::read(&manifest)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    {
        Some(value) => value,
        None => {
            let _ = std::fs::remove_dir_all(&out);
            let value = bridge_request(
                app,
                "stageEngineSource",
                json!({
                    "root": dir.join(id).join("src").display().to_string(),
                    "source": pack.source,
                    "outputDir": out.join("files").display().to_string(),
                }),
                BRIDGE_TIMEOUT,
            )?;
            std::fs::write(
                &manifest,
                serde_json::to_vec(&value).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            value
        }
    };
    let data_files = staged["dataFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some((
                d["type"].as_str()?.to_string(),
                d["path"].as_str()?.to_string(),
            ))
        })
        .collect();
    let files = staged["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f["path"].as_str().map(str::to_string))
        .collect();
    let audio_names = source["engines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["named"].as_bool() == Some(true))
        .filter_map(|e| e["audioName"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let source_path = PathBuf::from(source["path"].as_str().unwrap_or_default());
    let kind = source["kind"].as_str().unwrap_or_default().to_string();
    let label_from = if kind == "rpf" {
        source_path.parent().and_then(|p| p.file_name())
    } else {
        source_path.file_name()
    };
    let label = resource_name(
        &label_from
            .map(|n| n.to_string_lossy().to_string())
            .or_else(|| audio_names.first().cloned())
            .unwrap_or_else(|| "engine_sound".into()),
    );
    Ok(Staged {
        dir: out.join("files"),
        data_files,
        files,
        audio_names,
        label,
        readme: entry["readme"].as_str().unwrap_or_default().to_string(),
        origin: entry["name"].as_str().unwrap_or_default().to_string(),
        rpf: if kind == "rpf" && source["encrypted"].as_bool() != Some(true) {
            Some(import_file(dir, id, &source_path.display().to_string())?)
        } else {
            None
        },
        kind,
    })
}

fn resource_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed: String = cleaned.trim_matches(['_', '-']).chars().take(48).collect();
    if trimmed.is_empty() {
        "engine_sound".into()
    } else if windows_reserved(&trimmed) {
        format!("{trimmed}_sound")
    } else {
        trimmed
    }
}

fn windows_reserved(stem: &str) -> bool {
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.ends_with(|c: char| c.is_ascii_digit()))
}

fn data_file_order(kind: &str) -> u8 {
    match kind {
        "AUDIO_SYNTHDATA" => 0,
        "AUDIO_GAMEDATA" => 1,
        "AUDIO_SOUNDDATA" => 2,
        "AUDIO_WAVEPACK" => 3,
        _ => 4,
    }
}

fn fxmanifest(audio_names: &[String], data_files: &[(String, String)]) -> String {
    let mut sorted = data_files.to_vec();
    sorted.sort_by_key(|(kind, path)| (data_file_order(kind), path.clone()));
    sorted.dedup();
    let mut files = Vec::new();
    for (kind, pattern) in [
        ("AUDIO_GAMEDATA", "audioconfig/*.dat151.rel"),
        ("AUDIO_SOUNDDATA", "audioconfig/*.dat54.rel"),
        ("AUDIO_SYNTHDATA", "audioconfig/*.dat10.rel"),
    ] {
        if data_files.iter().any(|(k, _)| k == kind) {
            files.push(pattern);
        }
    }
    files.push("sfx/**/*.awc");
    let mut text = String::new();
    text.push_str("fx_version 'cerulean'\ngame 'gta5'\n\n");
    text.push_str(&format!(
        "description 'Engine sound: {}'\n\n",
        audio_names.join(", ").replace('\'', "")
    ));
    text.push_str("files {\n");
    text.push_str(
        &files
            .iter()
            .map(|f| format!("  '{f}'"))
            .collect::<Vec<_>>()
            .join(",\n"),
    );
    text.push_str("\n}\n\n");
    for (kind, path) in sorted {
        text.push_str(&format!("data_file '{kind}' '{path}'\n"));
    }
    text
}

fn credits(staged: &[&Staged]) -> String {
    let mut text = String::from("Engine sounds installed with Cortex Studio.\n\nThese sounds belong to their authors. Their own notes and terms follow; installing them follows those terms, as installing them by hand would.\n\n");
    for pack in staged {
        text.push_str(&format!(
            "== {} (audioNameHash: {}) from {}\n\n{}\n\n",
            pack.label,
            pack.audio_names.join(", "),
            pack.origin,
            if pack.readme.trim().is_empty() {
                "The download came without notes."
            } else {
                pack.readme.trim()
            }
        ));
    }
    text
}

fn existing_audio(resources: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let mut found = Vec::new();
    let mut stack = vec![(resources.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let manifest = ["fxmanifest.lua", "__resource.lua"]
                .iter()
                .map(|m| path.join(m))
                .find(|m| m.is_file());
            if let Some(manifest) = manifest {
                let text = std::fs::read_to_string(&manifest).unwrap_or_default();
                let lines: Vec<String> = text
                    .lines()
                    .filter(|l| l.contains("AUDIO_WAVEPACK") || l.contains("AUDIO_GAMEDATA"))
                    .map(|l| l.trim().to_lowercase())
                    .collect();
                if !lines.is_empty() {
                    found.push((path, lines));
                }
            } else if depth < 4 {
                stack.push((path, depth + 1));
            }
        }
    }
    found
}

fn last_quoted(line: &str) -> Option<String> {
    let trimmed = line.trim_end_matches([' ', ',', ')']);
    let quote = trimmed.chars().last().filter(|c| *c == '\'' || *c == '"')?;
    let body = &trimmed[..trimmed.len() - 1];
    let start = body.rfind(quote)? + 1;
    Some(body[start..].replace('\\', "/").to_lowercase())
}

fn server_cfg_for(resources: &Path) -> Option<PathBuf> {
    resources
        .ancestors()
        .take(5)
        .map(|dir| dir.join("server.cfg"))
        .find(|cfg| cfg.is_file())
}

#[tauri::command]
pub async fn engine_sounds_check_fivem(
    resources_dir: String,
    items: Vec<PackRef>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resources = PathBuf::from(resources_dir.trim());
        if !resources.is_dir() {
            return Err(format!("{} isn't a folder.", resources.display()));
        }
        let dir = root(&app)?;
        let mut conflicts = Vec::new();
        let existing = existing_audio(&resources);
        for item in &items {
            let staged = stage(&app, &dir, item)?;
            for (kind, path) in &staged.data_files {
                let tail = path.rsplit('/').next().unwrap_or(path).to_lowercase();
                for (resource, lines) in &existing {
                    let ours = resource.join(MARKER).is_file();
                    let hit = lines.iter().any(|l| {
                        l.contains(&kind.to_lowercase())
                            && last_quoted(l)
                                .is_some_and(|q| q.rsplit('/').next() == Some(tail.as_str()))
                    });
                    if hit {
                        conflicts.push(json!({
                            "audio": staged.audio_names,
                            "file": tail,
                            "resource": resource.display().to_string(),
                            "studio": ours,
                        }));
                    }
                }
            }
        }
        let category = resources
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| n.starts_with('[') && n.ends_with(']'));
        let cfg = server_cfg_for(&resources);
        let ensured_by_group = match (&category, &cfg) {
            (Some(group), Some(cfg)) => std::fs::read_to_string(cfg)
                .unwrap_or_default()
                .lines()
                .any(|l| {
                    let line = l.trim().to_lowercase();
                    (line.starts_with("ensure ") || line.starts_with("start "))
                        && line.split_whitespace().nth(1) == Some(group.to_lowercase().as_str())
                }),
            _ => false,
        };
        Ok(json!({
            "conflicts": conflicts,
            "category": category,
            "serverCfg": cfg.map(|c| c.display().to_string()),
            "startsWithServer": ensured_by_group,
        }))
    })
    .await
    .map_err(|e| format!("The check stopped: {e}"))?
}

fn record_files(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut hashes = BTreeMap::new();
    for file in files_under(dir) {
        let relative = file
            .strip_prefix(dir)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if relative == MARKER {
            continue;
        }
        hashes.insert(relative, content_hash(&file)?);
    }
    Ok(hashes)
}

fn studio_owned_and_unchanged(dir: &Path) -> bool {
    let Some(marker) = std::fs::read(dir.join(MARKER))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return false;
    };
    let Ok(now) = record_files(dir) else {
        return false;
    };
    let recorded: BTreeMap<String, String> = marker["files"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    recorded == now
}

fn copy_staged(
    staged: &Staged,
    dest: &Path,
    seen: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for relative in &staged.files {
        if !safe_entry(relative) {
            return Err(format!("{relative} isn't a safe path."));
        }
        let from = staged.dir.join(relative);
        let hash = content_hash(&from)?;
        if let Some(previous) = seen.get(relative) {
            if previous != &hash {
                return Err(format!(
                    "Two of the chosen sounds both carry {relative} with different contents, so they can't share one resource. Install them as separate resources."
                ));
            }
            continue;
        }
        let to = dest.join(relative);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("Couldn't write {}: {e}", to.display()))?;
        seen.insert(relative.clone(), hash);
    }
    Ok(())
}

fn place_resource(
    resources: &Path,
    name: &str,
    build: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let target = resources.join(name);
    if target.exists() && !studio_owned_and_unchanged(&target) {
        return Err(format!(
            "{} already exists and wasn't installed by Studio (or was changed since). Studio won't overwrite it; pick another folder or name.",
            target.display()
        ));
    }
    let partial = resources.join(format!(".{name}.cortex-partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial)
        .map_err(|e| format!("Couldn't write to {}: {e}", resources.display()))?;
    if let Err(error) = build(&partial) {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(error);
    }
    let files = match record_files(&partial) {
        Ok(files) => files,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(error);
        }
    };
    let marker = json!({ "installedBy": "Cortex Studio", "installedAt": now_ms(), "files": files });
    std::fs::write(
        partial.join(MARKER),
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    if target.exists() {
        let old = resources.join(format!(".{name}.cortex-old"));
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(&target, &old).map_err(|e| {
            let _ = std::fs::remove_dir_all(&partial);
            format!("Couldn't replace {}: {e}", target.display())
        })?;
        if let Err(e) = std::fs::rename(&partial, &target) {
            let _ = std::fs::rename(&old, &target);
            let _ = std::fs::remove_dir_all(&partial);
            return Err(format!("Couldn't replace {}: {e}", target.display()));
        }
        let _ = std::fs::remove_dir_all(&old);
    } else {
        std::fs::rename(&partial, &target).map_err(|e| {
            let _ = std::fs::remove_dir_all(&partial);
            format!("Couldn't finish {}: {e}", target.display())
        })?;
    }
    Ok(target)
}

#[tauri::command]
pub async fn engine_sounds_install_fivem(
    resources_dir: String,
    items: Vec<PackRef>,
    single_player_ok: bool,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resources = PathBuf::from(resources_dir.trim());
        if !resources.is_dir() || !user_chose(&app, &resources) {
            return Err("Pick your server's resources folder in Studio first.".into());
        }
        if items.is_empty() {
            return Err("Choose at least one engine sound to install.".into());
        }
        let dir = root(&app)?;
        let staged = items.iter().map(|item| stage(&app, &dir, item)).collect::<Result<Vec<_>, _>>()?;
        if !single_player_ok {
            if let Some(pack) = staged.iter().find(|p| p.kind == "rpf") {
                return Err(format!(
                    "{} was made for single player. Confirm its author allows FiveM use before installing it on a server.",
                    pack.label
                ));
            }
        }
        let mut installed = Vec::new();
        let mut names = HashSet::new();
        for pack in &staged {
            let mut name = pack.label.clone();
            let mut n = 2;
            while !names.insert(name.clone()) {
                name = format!("{}_{n}", pack.label);
                n += 1;
            }
            let target = place_resource(&resources, &name, |dest| {
                copy_staged(pack, dest, &mut BTreeMap::new())?;
                std::fs::write(dest.join("fxmanifest.lua"), fxmanifest(&pack.audio_names, &pack.data_files)).map_err(|e| e.to_string())?;
                std::fs::write(dest.join("CREDITS.txt"), credits(&[pack])).map_err(|e| e.to_string())
            })
            .map_err(|e| {
                if installed.is_empty() {
                    e
                } else {
                    format!(
                        "{e} Installed before this: {}.",
                        installed.iter().filter_map(|i: &Value| i["name"].as_str()).collect::<Vec<_>>().join(", ")
                    )
                }
            })?;
            installed.push(json!({
                "name": name,
                "path": target.display().to_string(),
                "audioNames": pack.audio_names,
            }));
        }
        Ok(json!({ "resources": installed }))
    })
    .await
    .map_err(|e| format!("The install stopped: {e}"))?
}

fn oiv_guid(pack: &str, salt: &str) -> String {
    let h = hash_hex(&[pack.as_bytes(), salt.as_bytes()]);
    let g = hash_hex(&[pack.as_bytes(), format!("{salt}-2").as_bytes()]);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &g[0..4],
        &g[4..16]
    )
    .to_uppercase()
}

fn oiv_assembly(pack: &str, label: &str, audio_names: &[String], origin: &str) -> String {
    let guid = oiv_guid(pack, "oiv");
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" id="{{{guid}}}" target="Five">
<metadata>
<name>{name}</name>
<version>
<major>1</major>
<minor>0</minor>
<tag>Stable</tag>
</version>
<author>
<displayName>Packed with Cortex Studio</displayName>
</author>
<description><![CDATA[Adds the engine sound {sounds} as an add-on pack (nothing in the game is replaced).

Use it on a car by setting <audioNameHash>{first}</audioNameHash> in that car's vehicles.meta.

Packed from {origin}. The sound belongs to its author; see CREDITS.txt in the download.]]></description>
</metadata>
<colors>
<headerBackground useBlackTextColor="False">$FF3462BD</headerBackground>
<iconBackground>$FF121316</iconBackground>
</colors>
<content>
<add source="mod\{pack}\dlc.rpf">update\x64\dlcpacks\{pack}\dlc.rpf</add>
<archive path="update\update.rpf" createIfNotExist="False" type="RPF7">
<text path="common\data\dlclist.xml" createIfNotExist="False">
<insert where="Before" line="*&lt;/Paths&gt;*" condition="Mask">		&lt;Item&gt;dlcpacks:/{pack}/&lt;/Item&gt;</insert>
</text>
</archive>
</content>
</package>
"#,
        name = escape(&format!("{label} engine sound")),
        sounds = audio_names.join(", "),
        first = audio_names.first().cloned().unwrap_or_default(),
        origin = origin.replace("]]>", ""),
    )
}

fn install_text(pack: &str, audio_names: &[String]) -> String {
    format!(
        "{pack} engine sound for GTA V Legacy single player\r\n\r\nEasy way: double-click {pack}.oiv and install it with OpenIV (Package Installer), into the mods folder.\r\n\r\nBy hand:\r\n1. Copy the {pack} folder (with dlc.rpf inside) to GTAV\\mods\\update\\x64\\dlcpacks\\\r\n2. In OpenIV, open mods\\update\\update.rpf\\common\\data\\dlclist.xml and add this line before </Paths>:\r\n   <Item>dlcpacks:/{pack}/</Item>\r\n\r\nThen set <audioNameHash>{}</audioNameHash> in the vehicles.meta of the car that should use it.\r\n",
        audio_names.join("</audioNameHash> or <audioNameHash>")
    )
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

fn stored_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        if data.len() > u32::MAX as usize || out.len() > u32::MAX as usize {
            return Err("The package is too large for an .oiv.".into());
        }
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;
        let name_bytes = name.as_bytes();
        let header = |sig: u32, central_entry: bool| {
            let mut h = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central_entry {
                h.extend_from_slice(&20u16.to_le_bytes());
            }
            h.extend_from_slice(&20u16.to_le_bytes());
            h.extend_from_slice(&0x0800u16.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            h.extend_from_slice(&0x21u16.to_le_bytes());
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
            h.extend_from_slice(&size.to_le_bytes());
            h.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            if central_entry {
                h.extend_from_slice(&0u16.to_le_bytes());
                h.extend_from_slice(&0u16.to_le_bytes());
                h.extend_from_slice(&0u16.to_le_bytes());
                h.extend_from_slice(&0u32.to_le_bytes());
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name_bytes);
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend_from_slice(data);
        central.extend(header(0x0201_4b50, true));
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend(central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

#[tauri::command]
pub async fn engine_sounds_build_sp(
    out_dir: String,
    items: Vec<PackRef>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = PathBuf::from(out_dir.trim());
        if !out.is_dir() || !user_chose(&app, &out) {
            return Err("Pick a folder for the single-player packs in Studio first.".into());
        }
        let dir = root(&app)?;
        let mut built = Vec::new();
        let mut taken = HashSet::new();
        for item in &items {
            let packed = build_engine_sp_pack(&app, &dir, &out, item, &mut taken);
            match packed {
                Ok(value) => built.push(value),
                Err(error) => return Err(with_written(error, &built)),
            }
        }
        Ok(json!({ "packs": built }))
    })
    .await
    .map_err(|e| format!("Packing stopped: {e}"))?
}

fn sp_pack_name(label: &str, taken: &mut HashSet<String>) -> String {
    let cut: String = label.replace('-', "_").chars().take(36).collect();
    let base = match cut.trim_end_matches('_') {
        "" => "sound_pack".to_string(),
        trimmed => trimmed.to_string(),
    };
    let mut name = base.clone();
    let mut n = 2;
    while !taken.insert(name.clone()) {
        name = format!("{base}_{n}");
        n += 1;
    }
    name
}

fn with_written(error: String, built: &[Value]) -> String {
    let names: Vec<&str> = built.iter().filter_map(|b| b["pack"].as_str()).collect();
    if names.is_empty() {
        error
    } else {
        format!("{error} Already written: {}.", names.join(", "))
    }
}

fn place_sp_pack(
    partial: &Path,
    pack: &str,
    folder: &Path,
    oiv: Option<&Path>,
) -> Result<(), String> {
    std::fs::rename(partial.join(pack), folder).map_err(|e| e.to_string())?;
    if let Some(oiv) = oiv {
        if let Err(error) = std::fs::rename(partial.join(format!("{pack}.oiv")), oiv) {
            let _ = std::fs::rename(folder, partial.join(pack));
            return Err(error.to_string());
        }
    }
    Ok(())
}

fn build_engine_sp_pack(
    app: &tauri::AppHandle,
    dir: &Path,
    out: &Path,
    item: &PackRef,
    taken: &mut HashSet<String>,
) -> Result<Value, String> {
    let staged = stage(app, dir, item)?;
    let pack = sp_pack_name(&staged.label, taken);
    let folder = out.join(&pack);
    let oiv = out.join(format!("{pack}.oiv"));
    if folder.exists() || oiv.exists() {
        return Err(format!(
            "{} or {} already exists. Pick an empty folder so nothing gets overwritten.",
            folder.display(),
            oiv.display()
        ));
    }
    let work = dir.join(item.id.as_str()).join("sp").join(&pack);
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let rpf = work.join("dlc.rpf");
    let reused = match &staged.rpf {
        Some(original) => {
            std::fs::copy(original, &rpf)
                .map_err(|e| format!("Couldn't copy the author's dlc.rpf: {e}"))?;
            true
        }
        None => {
            bridge_request(
                app,
                "buildEngineDlc",
                json!({
                    "stagedDir": staged.dir.display().to_string(),
                    "packName": pack,
                    "outputPath": rpf.display().to_string(),
                }),
                BRIDGE_TIMEOUT,
            )?;
            false
        }
    };
    let rpf_bytes = std::fs::read(&rpf).map_err(|e| e.to_string())?;
    let assembly = oiv_assembly(&pack, &staged.label, &staged.audio_names, &staged.origin);
    let zip = stored_zip(&[
        ("assembly.xml".into(), assembly.into_bytes()),
        (format!("content/mod/{pack}/dlc.rpf"), rpf_bytes),
    ])?;
    let partial = out.join(format!(".{pack}.cortex-partial"));
    let _ = std::fs::remove_dir_all(&partial);
    let written = (|| -> Result<(), String> {
        std::fs::create_dir_all(partial.join(&pack)).map_err(|e| e.to_string())?;
        std::fs::copy(&rpf, partial.join(&pack).join("dlc.rpf")).map_err(|e| e.to_string())?;
        std::fs::write(partial.join(format!("{pack}.oiv")), &zip).map_err(|e| e.to_string())?;
        std::fs::write(
            partial.join(&pack).join("INSTALL.txt"),
            install_text(&pack, &staged.audio_names),
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(partial.join(&pack).join("CREDITS.txt"), credits(&[&staged]))
            .map_err(|e| e.to_string())?;
        place_sp_pack(&partial, &pack, &folder, Some(&oiv))
    })();
    let _ = std::fs::remove_dir_all(&partial);
    let _ = std::fs::remove_dir_all(&work);
    written.map_err(|e| format!("Couldn't write the {pack} pack: {e}"))?;
    Ok(json!({
        "pack": pack,
        "folder": folder.display().to_string(),
        "oiv": oiv.display().to_string(),
        "audioNames": staged.audio_names,
        "reusedAuthorRpf": reused,
        "from": staged.kind,
    }))
}

const SIREN_PREVIEW_REVISION: &str = "siren-preview-v1";
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "ogg", "flac", "m4a", "aac"];
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TONE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACK_TONES: usize = 24;

fn chosen_gta_folder(app: &tauri::AppHandle, raw: Option<&str>) -> Option<PathBuf> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let path = PathBuf::from(text);
    (path.is_dir() && user_chose(app, &path)).then_some(path)
}

fn inspect_sirens(app: &tauri::AppHandle, src: &Path, gta: Option<&Path>) -> Result<Value, String> {
    let mut request = json!({ "root": src.display().to_string() });
    if let Some(folder) = gta {
        request["gtaFolder"] = json!(folder.display().to_string());
    }
    let mut report = bridge_request(app, "inspectSirenAudio", request, BRIDGE_TIMEOUT)?;
    Ok(match report["sources"].take() {
        Value::Array(list) => Value::Array(list),
        _ => Value::Array(Vec::new()),
    })
}

fn sirens_for_import(
    app: &tauri::AppHandle,
    src: &Path,
    gta: Option<&Path>,
    engines: usize,
) -> Result<Value, String> {
    match inspect_sirens(app, src, gta) {
        Ok(list) => Ok(list),
        Err(error) if engines > 0 => {
            eprintln!("[sound-studio] siren scan skipped: {error}");
            Ok(Value::Array(Vec::new()))
        }
        Err(error) => Err(error),
    }
}

fn siren_source(entry: &Value, source: &str) -> Result<Value, String> {
    entry["sirens"]
        .as_array()
        .and_then(|list| list.iter().find(|s| s["id"] == source))
        .cloned()
        .ok_or_else(|| "That siren pack isn't in this import any more.".to_string())
}

fn library_entry(dir: &Path, id: &str) -> Result<Value, String> {
    let id = valid_id(id)?;
    read_library(dir)
        .into_iter()
        .find(|e| e["id"] == id)
        .ok_or_else(|| "That download isn't in the library any more.".to_string())
}

#[tauri::command]
pub async fn engine_sounds_siren_rescan(
    id: String,
    gta_folder: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root(&app)?;
        let gta = chosen_gta_folder(&app, gta_folder.as_deref());
        let entry = library_entry(&dir, &id)?;
        let home = dir.join(valid_id(&id)?);
        let sirens = inspect_sirens(&app, &home.join("src"), gta.as_deref())?;
        let _ = std::fs::remove_dir_all(home.join("sirens"));
        let _guard = lock_ignoring_poison(&LIBRARY_LOCK);
        let mut library = read_library(&dir);
        let mut updated = entry;
        updated["sirens"] = sirens;
        for item in library.iter_mut() {
            if item["id"] == updated["id"] {
                *item = updated.clone();
            }
        }
        write_library(&dir, &library)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("The rescan stopped: {e}"))?
}

#[tauri::command]
pub async fn engine_sounds_siren_preview(
    id: String,
    source: String,
    gta_folder: Option<String>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root(&app)?;
        let entry = library_entry(&dir, &id)?;
        let found = siren_source(&entry, &source)?;
        if found["needsGame"].as_bool() == Some(true) {
            return Err("Studio needs your GTA V folder to read this siren pack. Choose it in the Sirens panel.".into());
        }
        let gta = chosen_gta_folder(&app, gta_folder.as_deref());
        let home = dir.join(valid_id(&id)?);
        let key = hash_hex(&[SIREN_PREVIEW_REVISION.as_bytes(), source.as_bytes()]);
        let out = home.join("sirens").join(key);
        let cached = out.join("result.json");
        if let Some(value) = std::fs::read(&cached)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        {
            return Ok(value);
        }
        let _ = std::fs::remove_dir_all(&out);
        let mut request = json!({
            "root": home.join("src").display().to_string(),
            "source": source,
            "outputDir": out.display().to_string(),
        });
        if let Some(folder) = gta {
            request["gtaFolder"] = json!(folder.display().to_string());
        }
        let mut result = bridge_request(&app, "decodeSirenAudio", request, BRIDGE_TIMEOUT)?;
        if let Some(tones) = result["tones"].as_array_mut() {
            for tone in tones {
                let file = tone["file"].as_str().unwrap_or_default().to_string();
                let path = if Path::new(&file).is_absolute() { PathBuf::from(&file) } else { out.join(&file) };
                tone["path"] = json!(path.display().to_string());
            }
        }
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        std::fs::write(&cached, serde_json::to_vec(&result).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Couldn't cache the siren preview: {e}"))?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("The siren preview stopped: {e}"))?
}

#[tauri::command]
pub async fn engine_sounds_read_audio(
    path: String,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let file = PathBuf::from(path.trim());
    if !AUDIO_EXTENSIONS.contains(&extension(&file).as_str()) {
        return Err("Pick a .wav, .mp3, .ogg, .flac, .m4a or .aac file.".into());
    }
    if !user_chose(&app, &file) {
        return Err("Pick or drop the audio file in Studio to use it.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&file)
            .map_err(|e| format!("Couldn't read {}: {e}", file.display()))?;
        if meta.len() > MAX_AUDIO_BYTES {
            return Err(format!(
                "{} is larger than 64 MB. Trim it before using it as a siren tone.",
                file.display()
            ));
        }
        std::fs::read(&file)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("Couldn't read {}: {e}", file.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn valid_token(value: &str, max: usize) -> Option<&str> {
    let ok = !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && value.as_bytes()[0].is_ascii_lowercase();
    ok.then_some(value)
}

#[tauri::command]
pub async fn engine_sounds_stage_tone(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let build = header("x-build");
    let tone = header("x-tone");
    let build = valid_token(&build, 40).ok_or("That siren build id isn't valid.")?;
    let tone =
        valid_token(&tone, 32).ok_or("Tone names use a-z, 0-9 and _ and start with a letter.")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The tone audio didn't arrive.".into());
    };
    if bytes.len() < 44
        || bytes.len() > MAX_TONE_BYTES
        || &bytes[0..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
    {
        return Err(format!("{tone} isn't a WAV Studio can pack."));
    }
    let builds = root(&app)?.join("builds");
    let build = build.to_string();
    let tone = tone.to_string();
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !builds.join(&build).exists() {
            remove_stale_builds(&builds);
        }
        let folder = builds.join(&build).join("tones");
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(format!("{tone}.wav"));
        std::fs::write(&path, &bytes).map_err(|e| format!("Couldn't stage {tone}: {e}"))?;
        Ok(json!({ "path": path.display().to_string(), "bytes": bytes.len() }))
    })
    .await
    .map_err(|e| format!("Staging stopped: {e}"))?
}

fn remove_stale_builds(builds: &Path) {
    let Ok(entries) = std::fs::read_dir(builds) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600));
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SirenToneInput {
    name: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SirenPackInput {
    build: String,
    name: String,
    tones: Vec<SirenToneInput>,
    sources: Vec<PackRef>,
    lvc: String,
    fleet: String,
    test_command: bool,
    author_ok: bool,
}

fn siren_resource_name(raw: &str) -> String {
    let mut name: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(40)
        .collect();
    if name.is_empty() || !name.as_bytes()[0].is_ascii_lowercase() {
        name = format!("sirens_{name}");
    }
    if windows_reserved(&name) {
        name.push_str("_sirens");
    }
    name
}

fn siren_dlc_name(resource: &str) -> String {
    let dlc: String = resource.chars().filter(|c| *c != '_').take(24).collect();
    if dlc.is_empty() {
        "sirens".into()
    } else {
        dlc
    }
}

fn lua_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn siren_manifest(dlc: &str, labels: &[String], test_command: bool) -> String {
    let mut text = format!(
        "fx_version 'cerulean'\ngame 'gta5'\n\nauthor 'Built with Cortex Studio'\ndescription {}\n\nfiles {{\n    'dlc_{dlc}/{dlc}.awc',\n    'data/{dlc}.dat54.rel',\n    'data/{dlc}.dat54.nametable',\n}}\n\ndata_file 'AUDIO_WAVEPACK' 'dlc_{dlc}'\ndata_file 'AUDIO_SOUNDDATA' 'data/{dlc}.dat'\n",
        lua_quote(&format!("Server-side sirens: {}", labels.join(", ")))
    );
    text.push_str("\nclient_script 'client/bank.lua'\n");
    if test_command {
        text.push_str("client_script 'client/sirentest.lua'\n");
    }
    text
}

fn siren_bank_script(dlc: &str) -> String {
    format!(
        r#"local bank = {bank}

CreateThread(function()
    local deadline = GetGameTimer() + 30000
    while not RequestScriptAudioBank(bank, false) do
        if GetGameTimer() > deadline then
            print(('[%s] The siren bank %s did not load, so these tones stay silent.'):format(GetCurrentResourceName(), bank))
            return
        end
        Wait(250)
    end
end)
"#,
        bank = lua_quote(&script_bank(dlc))
    )
}

fn script_bank(dlc: &str) -> String {
    let upper = dlc.to_uppercase();
    format!("DLC_{upper}\\{upper}")
}

fn siren_test_script(resource: &str, dlc: &str, tones: &[String]) -> String {
    let list = tones
        .iter()
        .map(|t| lua_quote(t))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"local resource = {resource}
local soundset = {soundset}
local bank = {bank}
local tones = {{ {list} }}
local playing = nil

local function stopTone()
    if playing then
        StopSound(playing)
        ReleaseSoundId(playing)
        playing = nil
    end
end

local function known(name)
    for _, tone in ipairs(tones) do
        if tone == name then return true end
    end
    return false
end

RegisterCommand({command}, function(_, args)
    local tone = args[1]
    stopTone()
    if tone == 'stop' then return end
    if not tone or not known(tone) then
        print(('[%s] /%s <tone> plays a tone from your vehicle, /%s stop ends it. Tones: %s'):format(resource, {command}, {command}, table.concat(tones, ', ')))
        return
    end
    CreateThread(function()
        local deadline = GetGameTimer() + 5000
        while not RequestScriptAudioBank(bank, false) and GetGameTimer() < deadline do
            Wait(50)
        end
        local ped = PlayerPedId()
        local vehicle = GetVehiclePedIsIn(ped, false)
        local sound = GetSoundId()
        playing = sound
        PlaySoundFromEntity(sound, tone, vehicle ~= 0 and vehicle or ped, soundset, false, 0)
        Wait(1000)
        if playing == sound then
            print(('[%s] %s %s'):format(resource, tone, HasSoundFinished(sound) and 'did not play. Check that the resource started before you joined, then run /refresh or rejoin.' or 'is playing'))
        end
    end)
end, false)
"#,
        resource = lua_quote(resource),
        soundset = lua_quote(&format!("{dlc}_soundset")),
        bank = lua_quote(&script_bank(dlc)),
        command = lua_quote(dlc),
    )
}

fn siren_credits(dir: &Path, sources: &[PackRef]) -> Result<String, String> {
    let mut text = String::from("Sirens built with Cortex Studio.\n\n");
    if sources.is_empty() {
        text.push_str("Every tone in this pack came from audio you chose yourself.\n");
        return Ok(text);
    }
    text.push_str("Some tones come from siren packs by other authors. Their notes and terms follow; using the tones on a server follows those terms.\n\n");
    let mut seen = HashSet::new();
    for item in sources {
        let entry = library_entry(dir, &item.id)?;
        let found = siren_source(&entry, &item.source)?;
        if !seen.insert((item.id.clone(), item.source.clone())) {
            continue;
        }
        let readme = entry["readme"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        text.push_str(&format!(
            "== {} from {}\n\n{}\n\n",
            found["label"].as_str().unwrap_or("Siren pack"),
            entry["name"].as_str().unwrap_or_default(),
            if readme.is_empty() {
                "The download came without notes."
            } else {
                readme.as_str()
            }
        ));
    }
    Ok(text)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    for file in files_under(from) {
        let relative = file.strip_prefix(from).map_err(|e| e.to_string())?;
        let target = to.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&file, &target)
            .map_err(|e| format!("Couldn't write {}: {e}", target.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn engine_sounds_install_sirens(
    resources_dir: String,
    pack: SirenPackInput,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resources = PathBuf::from(resources_dir.trim());
        if !resources.is_dir() || !user_chose(&app, &resources) {
            return Err("Pick your server's resources folder in Studio first.".into());
        }
        let build = valid_token(&pack.build, 40).ok_or("That siren build id isn't valid.")?.to_string();
        if pack.tones.is_empty() {
            return Err("Add at least one tone to the siren pack.".into());
        }
        if pack.tones.len() > MAX_PACK_TONES {
            return Err(format!("A siren pack holds up to {MAX_PACK_TONES} tones."));
        }
        if !pack.sources.is_empty() && !pack.author_ok {
            return Err("Some tones come from another author's siren pack. Confirm its author allows FiveM use before installing it on a server.".into());
        }
        let dir = root(&app)?;
        let work = dir.join("builds").join(&build);
        let mut names = HashSet::new();
        let mut tones = Vec::new();
        for tone in &pack.tones {
            let name = valid_token(&tone.name, 32)
                .ok_or_else(|| format!("{} isn't a valid tone name. Use a-z, 0-9 and _.", tone.name))?;
            if !names.insert(name.to_string()) {
                return Err(format!("Two tones are both called {name}."));
            }
            let wav = work.join("tones").join(format!("{name}.wav"));
            if !wav.is_file() {
                return Err(format!("{name} wasn't prepared. Build the pack again."));
            }
            tones.push(json!({ "name": name, "wav": wav.display().to_string() }));
        }
        let name = siren_resource_name(&pack.name);
        let dlc = siren_dlc_name(&name);
        let credits_text = siren_credits(&dir, &pack.sources)?;
        let out = work.join("out");
        let _ = std::fs::remove_dir_all(&out);
        let built = bridge_request(
            &app,
            "buildSirenPack",
            json!({
                "outputDir": out.display().to_string(),
                "dlcName": dlc,
                "banks": [{ "name": dlc, "tones": tones }],
            }),
            BRIDGE_TIMEOUT,
        )?;
        let labels: Vec<String> = pack.tones.iter().map(|t| t.label.trim().chars().take(40).collect()).collect();
        let tone_names: Vec<String> = pack.tones.iter().map(|t| t.name.clone()).collect();
        let notes = format!(
            "Server-side sirens built with Cortex Studio\r\n\r\nResource: {name}\r\nSoundset (LVC Ref): {dlc}_soundset\r\nBank (LVC Fleet): dlc_{dlc}/{dlc}\r\nTones (LVC String): {}\r\n\r\n{}\r\n\r\nLVC Fleet\r\n{}\r\n\r\nIf a tone stays silent in game, make sure this resource starts before players join, then rejoin. With LVC Fleet, turn Local Override off.\r\n",
            tone_names.join(", "),
            pack.lvc.replace('\n', "\r\n"),
            pack.fleet.replace('\n', "\r\n"),
        );
        let target = place_resource(&resources, &name, |dest| {
            copy_tree(&out, dest)?;
            std::fs::write(dest.join("fxmanifest.lua"), siren_manifest(&dlc, &labels, pack.test_command))
                .map_err(|e| e.to_string())?;
            std::fs::write(dest.join("LVC.txt"), &notes).map_err(|e| e.to_string())?;
            std::fs::write(dest.join("CREDITS.txt"), &credits_text).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(dest.join("client")).map_err(|e| e.to_string())?;
            std::fs::write(dest.join("client").join("bank.lua"), siren_bank_script(&dlc))
                .map_err(|e| e.to_string())?;
            if pack.test_command {
                std::fs::write(dest.join("client").join("sirentest.lua"), siren_test_script(&name, &dlc, &tone_names))
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        });
        let _ = std::fs::remove_dir_all(&work);
        let target = target?;
        Ok(json!({
            "name": name,
            "path": target.display().to_string(),
            "dlc": dlc,
            "soundset": format!("{dlc}_soundset"),
            "bank": format!("dlc_{dlc}/{dlc}"),
            "command": if pack.test_command { Value::String(dlc.clone()) } else { Value::Null },
            "tones": tone_names,
            "files": built["files"].clone(),
            "warnings": built["warnings"].clone(),
        }))
    })
    .await
    .map_err(|e| format!("The siren install stopped: {e}"))?
}

fn resident_assembly(pack: &str, label: &str, origin: &str) -> String {
    let guid = oiv_guid(pack, "siren-oiv");
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" id="{{{guid}}}" target="Five">
<metadata>
<name>{name}</name>
<version>
<major>1</major>
<minor>0</minor>
<tag>Stable</tag>
</version>
<author>
<displayName>Packed with Cortex Studio</displayName>
</author>
<description><![CDATA[Installs the author's RESIDENT.rpf, unchanged, into your mods folder. It replaces the game's sirens for single player.

Packed from {origin}. The sirens belong to their author; see CREDITS.txt in the download.]]></description>
</metadata>
<colors>
<headerBackground useBlackTextColor="False">$FF3462BD</headerBackground>
<iconBackground>$FF121316</iconBackground>
</colors>
<content>
<add source="RESIDENT.rpf">x64\audio\sfx\RESIDENT.rpf</add>
</content>
</package>
"#,
        name = escape(&format!("{label} sirens")),
        origin = origin.replace("]]>", ""),
    )
}

#[tauri::command]
pub async fn engine_sounds_build_sirens_sp(
    out_dir: String,
    items: Vec<PackRef>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = PathBuf::from(out_dir.trim());
        if !out.is_dir() || !user_chose(&app, &out) {
            return Err("Pick a folder for the single-player packs in Studio first.".into());
        }
        if items.is_empty() {
            return Err("Tick at least one siren download to pack for single player.".into());
        }
        let dir = root(&app)?;
        let mut built = Vec::new();
        let mut taken = HashSet::new();
        for item in &items {
            match build_siren_sp_pack(&dir, &out, item, &mut taken) {
                Ok(value) => built.push(value),
                Err(error) => return Err(with_written(error, &built)),
            }
        }
        Ok(json!({ "packs": built }))
    })
    .await
    .map_err(|e| format!("Packing stopped: {e}"))?
}

fn build_siren_sp_pack(
    dir: &Path,
    out: &Path,
    item: &PackRef,
    taken: &mut HashSet<String>,
) -> Result<Value, String> {
    let entry = library_entry(dir, &item.id)?;
    let found = siren_source(&entry, &item.source)?;
    let kind = found["kind"].as_str().unwrap_or_default();
    let label = found["label"].as_str().unwrap_or("sirens");
    let pack = sp_pack_name(&siren_resource_name(label), taken);
    let src = dir.join(valid_id(&item.id)?).join("src");
    let located = import_file(dir, &item.id, found["path"].as_str().unwrap_or_default())?;
    let folder = out.join(&pack);
    let oiv = out.join(format!("{pack}.oiv"));
    if folder.exists() || oiv.exists() {
        return Err(format!(
            "{} or {} already exists. Pick an empty folder so nothing gets overwritten.",
            folder.display(),
            oiv.display()
        ));
    }
    let download = entry["name"].as_str().unwrap_or_default();
    let readme = entry["readme"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    let credits = format!(
        "Sirens packed with Cortex Studio from {download}\r\n\r\n{}\r\n",
        if readme.is_empty() {
            "The download came without notes."
        } else {
            readme.as_str()
        }
    );
    let partial = out.join(format!(".{pack}.cortex-partial"));
    let _ = std::fs::remove_dir_all(&partial);
    let written = (|| -> Result<Value, String> {
        let staged = partial.join(&pack);
        std::fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
        std::fs::write(staged.join("CREDITS.txt"), &credits).map_err(|e| e.to_string())?;
        match kind {
            "resident" => {
                let rpf = if located.is_file() {
                    located.clone()
                } else {
                    located.join("RESIDENT.rpf")
                };
                if !rpf.is_file() {
                    return Err(format!("{} is missing from the import.", rpf.display()));
                }
                std::fs::copy(&rpf, staged.join("RESIDENT.rpf")).map_err(|e| e.to_string())?;
                let bytes = std::fs::read(&rpf).map_err(|e| e.to_string())?;
                let zip = stored_zip(&[
                    (
                        "assembly.xml".into(),
                        resident_assembly(&pack, label, download).into_bytes(),
                    ),
                    ("content/RESIDENT.rpf".into(), bytes),
                ])?;
                std::fs::write(partial.join(format!("{pack}.oiv")), zip)
                    .map_err(|e| e.to_string())?;
                std::fs::write(
                    staged.join("INSTALL.txt"),
                    format!("{label} sirens for GTA V Legacy single player\r\n\r\nEasy way: double-click {pack}.oiv and install it with OpenIV (Package Installer), into the mods folder.\r\n\r\nBy hand: copy RESIDENT.rpf to GTAV\\mods\\x64\\audio\\sfx\\ (make the folders if they're missing). Keep the game's own RESIDENT.rpf outside mods untouched.\r\n"),
                )
                .map_err(|e| e.to_string())?;
                place_sp_pack(&partial, &pack, &folder, Some(&oiv))?;
                Ok(
                    json!({ "pack": pack, "folder": folder.display().to_string(), "oiv": oiv.display().to_string(), "from": kind }),
                )
            }
            "wavs" => {
                let base = if located.is_file() {
                    located
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or(src.clone())
                } else {
                    located.clone()
                };
                let target = staged.join("SirenMastery");
                for file in files_under(&base) {
                    let ext = extension(&file);
                    if ext != "wav" && ext != "xml" {
                        continue;
                    }
                    let relative = file.strip_prefix(&base).map_err(|e| e.to_string())?;
                    let to = target.join(relative);
                    if let Some(parent) = to.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    std::fs::copy(&file, &to).map_err(|e| e.to_string())?;
                }
                std::fs::write(
                    staged.join("INSTALL.txt"),
                    format!("{label} sirens for single player (Siren Mastery)\r\n\r\nThese need Albo1125's Siren Mastery plugin for RAGE Plugin Hook.\r\nCopy everything inside SirenMastery\\ to GTAV\\plugins\\SirenMastery\\, keeping the folder layout.\r\n"),
                )
                .map_err(|e| e.to_string())?;
                place_sp_pack(&partial, &pack, &folder, None)?;
                Ok(
                    json!({ "pack": pack, "folder": folder.display().to_string(), "oiv": Value::Null, "from": kind }),
                )
            }
            _ => Err(format!(
                "{label} is already a FiveM resource; there's no single-player version to pack."
            )),
        }
    })();
    let _ = std::fs::remove_dir_all(&partial);
    written.map_err(|e| format!("Couldn't pack {label}: {e}"))
}
