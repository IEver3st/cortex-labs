use std::path::{Path, PathBuf};
use std::process::Command;

const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Cortex Forge";
const DEFAULT_BINARY: &str = "cortex-forge-desktop.exe";
const MIN_VERSION: (u64, u64, u64) = (0, 1, 0);
const MANIFESTS: &[&str] = &["fxmanifest.lua", "__resource.lua"];
const MAX_RESOURCE_DEPTH: usize = 8;

#[derive(serde::Serialize, Clone)]
pub struct ForgeInstall {
    path: String,
    version: String,
}

struct Found {
    exe: PathBuf,
    version: Option<String>,
}

#[cfg(windows)]
fn registered() -> Option<Found> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    [CURRENT_USER, LOCAL_MACHINE].into_iter().find_map(|hive| {
        let key = hive.open(UNINSTALL_KEY).ok()?;
        let dir = key.get_string("InstallLocation").ok()?;
        let bin = key
            .get_string("MainBinaryName")
            .unwrap_or_else(|_| DEFAULT_BINARY.into());
        let mut exe =
            PathBuf::from(dir.trim().trim_matches('"')).join(bin.trim().trim_matches('"'));
        if exe.extension().is_none() {
            exe.set_extension("exe");
        }
        if !exe.is_absolute() || !exe.is_file() {
            return None;
        }
        let version = key
            .get_string("DisplayVersion")
            .ok()
            .map(|v| v.trim().to_string());
        Some(Found { exe, version })
    })
}

#[cfg(not(windows))]
fn registered() -> Option<Found> {
    None
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>());
    let major = parts.next()?.ok()?;
    let minor = parts.next().unwrap_or(Ok(0)).ok()?;
    let patch = parts.next().unwrap_or(Ok(0)).ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn supported() -> Option<(PathBuf, String)> {
    let found = registered()?;
    let version = found.version?;
    (parse_version(&version)? >= MIN_VERSION).then_some((found.exe, version))
}

fn has_manifest(dir: &Path) -> bool {
    MANIFESTS.iter().any(|name| dir.join(name).is_file())
}

fn resource_folder(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    start
        .ancestors()
        .take(MAX_RESOURCE_DEPTH)
        .take_while(|dir| dir.parent().is_some())
        .find(|dir| has_manifest(dir))
        .map(Path::to_path_buf)
}

#[tauri::command]
pub fn forge_find() -> Option<ForgeInstall> {
    supported().map(|(exe, version)| ForgeInstall {
        path: exe.display().to_string(),
        version,
    })
}

#[tauri::command]
pub fn forge_resource_folder(path: String) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    resource_folder(Path::new(&path)).map(|dir| dir.display().to_string())
}

#[tauri::command]
pub fn forge_check_resource(folder: String) -> Result<(), String> {
    let dir = PathBuf::from(if cfg!(windows) {
        folder.replace('/', "\\")
    } else {
        folder
    });
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("{} isn't there any more.", dir.display()));
    }
    if !has_manifest(&dir) {
        return Err(format!(
            "{} has no fxmanifest.lua or __resource.lua, so Cortex Forge can't open it as a resource.",
            dir.display()
        ));
    }
    let (exe, _) = supported().ok_or(
        "Cortex Forge isn't installed, or this version can't check resources from Studio.",
    )?;
    Command::new(&exe)
        .arg("--vehicles")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't start Cortex Forge: {e}"))
}
