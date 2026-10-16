use std::io::Read;
use std::path::{Path, PathBuf};

use tauri_plugin_fs::FsExt;

// ELS scripts read vehicle configuration files (VCFs) from their own folders,
// often on another drive (GTA V/ELS/pack_default). The user adds such a folder
// or opens a VCF with a picker, which allows it for this session only; this
// re-allows it on later runs. Only a folder that already holds a VCF qualifies,
// and only that folder (not its subfolders), plus ELS-FiveM's vcf.lua beside it.
// The vcf.lua backup and the pattern-table import are native for the same
// reason: each touches named files without widening the renderer's scope.

const MAX_ENTRIES: usize = 2_000;
const SNIFF_BYTES: usize = 4_096;
const MAX_PATTERN_BYTES: u64 = 4 * 1024 * 1024;
// Where ELS-FiveM keeps its pattern tables, relative to the folder picked.
const PATTERN_DIRS: [&str; 4] = [
    "",
    "client/_patternTypes",
    "_patternTypes",
    "ELS-FiveM/client/_patternTypes",
];
const PATTERN_FILES: [&str; 3] = ["leds.lua", "traf.lua", "chp.lua"];

/// A path for the renderer: canonical paths on Windows carry a `\\?\` prefix
/// that no dialog or stored path has.
fn plain(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

fn is_vcf(path: &Path) -> bool {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("xml"))
    {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    if file
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    String::from_utf8_lossy(&head)
        .to_ascii_lowercase()
        .contains("<vcfroot")
}

fn holds_vcf(directory: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };
    entries
        .flatten()
        .take(MAX_ENTRIES)
        .any(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()) && is_vcf(&entry.path()))
}

/// The folder to allow for `path` (a VCF or a folder of VCFs).
pub fn vcf_folder(path: &Path) -> Result<PathBuf, String> {
    let target = path
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", path.display()))?;
    let directory = if target.is_file() {
        if !is_vcf(&target) {
            return Err(format!("{} is not an ELS VCF.", target.display()));
        }
        target
            .parent()
            .ok_or("The VCF has no parent folder.")?
            .to_path_buf()
    } else if target.is_dir() {
        if !holds_vcf(&target) {
            return Err(format!(
                "{} has no ELS VCF files (.xml with <vcfroot>).",
                target.display()
            ));
        }
        target
    } else {
        return Err(format!("{} is not a file or folder.", target.display()));
    };
    // Never grant a drive root.
    if directory.parent().is_none() {
        return Err("Move the VCFs out of the drive root to use them.".into());
    }
    Ok(directory)
}

pub fn allow<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> Result<String, String> {
    let directory = vcf_folder(path)?;
    let scope = app.fs_scope();
    scope
        .allow_directory(&directory, false)
        .map_err(|error| format!("Cannot open {}: {error}", directory.display()))?;
    // ELS-FiveM lists its VCFs in vcf.lua beside its vcf folder. Only that
    // layout, and only a real file (a link could point anywhere).
    let in_vcf_folder = directory
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("vcf"));
    if let Some(list) = directory
        .parent()
        .filter(|_| in_vcf_folder)
        .map(|parent| parent.join("vcf.lua"))
        .filter(|list| std::fs::symlink_metadata(list).is_ok_and(|meta| meta.is_file()))
    {
        scope
            .allow_file(&list)
            .map_err(|error| format!("Cannot open {}: {error}", list.display()))?;
    }
    Ok(plain(&directory))
}

/// Copies vcf.lua to `backup` before Cortex adds a VCF to it. `list` must be a
/// vcf.lua the renderer may already write (allowed with its vcf folder), and
/// `backup` a new `vcf.lua.<yyyymmdd-hhmmss>.bak` beside it.
pub fn backup_vcf_list<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    list: &Path,
    backup: &Path,
) -> Result<(), String> {
    let name = list
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("The list has no file name.")?;
    let regular = std::fs::symlink_metadata(list).is_ok_and(|meta| meta.is_file());
    if !name.eq_ignore_ascii_case("vcf.lua") || !regular {
        return Err(format!("{} is not ELS-FiveM's vcf.lua.", list.display()));
    }
    if !app.fs_scope().is_allowed(list) {
        return Err(format!(
            "{} is not in a folder opened for ELS.",
            list.display()
        ));
    }
    let stamp = backup
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_prefix(name))
        .and_then(|value| value.strip_prefix('.'))
        .and_then(|value| value.strip_suffix(".bak"))
        .unwrap_or("");
    let digits = |part: &str, count: usize| {
        part.len() == count && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    let stamped = stamp
        .split_once('-')
        .is_some_and(|(date, time)| digits(date, 8) && digits(time, 6));
    if !stamped || backup.parent() != list.parent() {
        return Err(format!(
            "{} is not a backup name for {}.",
            backup.display(),
            list.display()
        ));
    }
    // A new file only: create_new also refuses a (dangling) link at the name,
    // so the copy cannot be written through one.
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(backup)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{} already exists.", backup.display()),
            _ => format!("Cannot create {}: {error}", backup.display()),
        })?;
    std::fs::File::open(list)
        .and_then(|mut source| std::io::copy(&mut source, &mut target))
        .map(|_| ())
        .map_err(|error| {
            drop(target);
            let _ = std::fs::remove_file(backup);
            format!("Cannot back up {}: {error}", list.display())
        })
}

#[derive(serde::Serialize, Debug)]
pub struct PatternFile {
    name: String,
    text: String,
}

#[derive(serde::Serialize, Debug)]
pub struct PatternTables {
    dir: String,
    files: Vec<PatternFile>,
}

/// Reads ELS-FiveM's pattern tables (leds.lua, traf.lua, chp.lua) from a
/// folder picked in this session: the resource or its client/_patternTypes.
/// Only those files are read, so the picker grants the folder alone rather
/// than everything below it.
pub fn read_pattern_tables<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<PatternTables, String> {
    if !app.fs_scope().is_allowed(path) {
        return Err(format!(
            "{} was not picked in this session.",
            path.display()
        ));
    }
    let root = path
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", plain(&root)));
    }
    for relative in PATTERN_DIRS {
        let dir = if relative.is_empty() {
            root.clone()
        } else {
            root.join(relative)
        };
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut files = Vec::new();
        for entry in entries.flatten().take(MAX_ENTRIES) {
            let entry_name = entry.file_name();
            let Some(wanted) = PATTERN_FILES.iter().find(|file| {
                entry_name
                    .to_str()
                    .is_some_and(|name| file.eq_ignore_ascii_case(name))
            }) else {
                continue;
            };
            // A link out of the picked folder is not followed.
            let Ok(real) = entry.path().canonicalize() else {
                continue;
            };
            if !real.starts_with(&root) || !real.is_file() {
                continue;
            }
            if real.metadata().map_or(u64::MAX, |meta| meta.len()) > MAX_PATTERN_BYTES {
                return Err(format!(
                    "{} is too large for a pattern table.",
                    plain(&real)
                ));
            }
            let bytes = std::fs::read(&real)
                .map_err(|error| format!("Cannot read {}: {error}", plain(&real)))?;
            files.push(PatternFile {
                name: (*wanted).to_string(),
                text: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        if !files.is_empty() {
            files.sort_by(|a, b| a.name.cmp(&b.name));
            return Ok(PatternTables {
                dir: plain(&dir.canonicalize().unwrap_or(dir)),
                files,
            });
        }
    }
    Err(format!(
        "No ELS-FiveM pattern tables (leds.lua, traf.lua, chp.lua) in {} or its client/_patternTypes folder.",
        plain(&root)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "cortex-els-scope-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, path: &str, text: &str) -> PathBuf {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    const VCF: &str = "<?xml version=\"1.0\"?>\n<vcfroot Description=\"x\"><EOVERRIDE /></vcfroot>";

    #[test]
    fn a_vcf_folder_is_allowed_without_its_subfolders() {
        let fixture = Fixture::new();
        let vcf = fixture.file("ELS-FiveM/vcf/cruiser.xml", VCF);
        let list = fixture.file("ELS-FiveM/vcf.lua", "vcf_files = {}");
        let nested = fixture.file("ELS-FiveM/vcf/old/other.xml", VCF);
        let client = fixture.file("ELS-FiveM/client/client.lua", "");
        let app = app();
        let scope = app.fs_scope();
        let folder = vcf.parent().unwrap();
        assert!(!scope.is_allowed(&vcf));

        let allowed = allow(app.handle(), folder).unwrap();
        assert_eq!(allowed, plain(&folder.canonicalize().unwrap()));
        assert!(!allowed.starts_with(r"\\?\"));
        assert!(scope.is_allowed(&vcf));
        assert!(scope.is_allowed(folder.join("cruiser.xml.bak")));
        assert!(scope.is_allowed(&list));
        assert!(!scope.is_allowed(&nested));
        assert!(!scope.is_allowed(&client));
    }

    #[test]
    fn vcf_lua_is_allowed_only_beside_a_vcf_folder() {
        let fixture = Fixture::new();
        let vcf = fixture.file("pack/police.xml", VCF);
        let list = fixture.file("vcf.lua", "vcf_files = {}");
        let app = app();
        allow(app.handle(), &vcf).unwrap();
        assert!(!app.fs_scope().is_allowed(&list));
    }

    #[test]
    fn a_picked_vcf_allows_its_folder() {
        let fixture = Fixture::new();
        let vcf = fixture.file("pack_default/cruiser.xml", VCF);
        let app = app();
        allow(app.handle(), &vcf).unwrap();
        assert!(app
            .fs_scope()
            .is_allowed(vcf.parent().unwrap().join("new.xml")));
    }

    #[test]
    fn folders_and_files_without_vcfs_are_refused() {
        let fixture = Fixture::new();
        let meta = fixture.file("res/data/carcols.meta", "<CVehicleModelInfoVarGlobal />");
        let xml = fixture.file("res/data/other.xml", "<CVehicleModelInfoVarGlobal />");
        let app = app();
        assert!(allow(app.handle(), meta.parent().unwrap()).is_err());
        assert!(allow(app.handle(), &meta).is_err());
        assert!(allow(app.handle(), &xml).is_err());
        assert!(!app.fs_scope().is_allowed(&meta));
        assert!(allow(app.handle(), &fixture.0.join("missing")).is_err());
    }

    #[test]
    fn the_vcf_list_backup_is_a_stamped_copy_beside_an_allowed_list() {
        let fixture = Fixture::new();
        fixture.file("ELS-FiveM/vcf/cruiser.xml", VCF);
        let list = fixture.file("ELS-FiveM/vcf.lua", "vcf_files = {}");
        let other = fixture.file("Other/vcf.lua", "vcf_files = {}");
        let app = app();
        let backup = list.with_file_name("vcf.lua.20261015-143012.bak");
        // Not allowed yet.
        assert!(backup_vcf_list(app.handle(), &list, &backup).is_err());
        allow(app.handle(), list.parent().unwrap().join("vcf").as_path()).unwrap();
        backup_vcf_list(app.handle(), &list, &backup).unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), b"vcf_files = {}");
        // Never twice, never a free-form name, never another list.
        assert!(backup_vcf_list(app.handle(), &list, &backup).is_err());
        assert!(backup_vcf_list(app.handle(), &list, &list.with_file_name("vcf.lua.bak")).is_err());
        assert!(backup_vcf_list(app.handle(), &list, &list.with_file_name("client.lua")).is_err());
        let other_backup = other.with_file_name("vcf.lua.20261015-143012.bak");
        assert!(backup_vcf_list(app.handle(), &other, &other_backup).is_err());
    }

    #[test]
    fn pattern_tables_are_read_from_a_picked_folder_only() {
        let fixture = Fixture::new();
        fixture.file(
            "ELS-FiveM/client/_patternTypes/LEDS.lua",
            "led_PrimaryPatterns = {}",
        );
        fixture.file(
            "ELS-FiveM/client/_patternTypes/traf.lua",
            "traf_Patterns = {}",
        );
        fixture.file("ELS-FiveM/client/_patternTypes/notes.lua", "secret = 1");
        let resource = fixture.0.join("ELS-FiveM");
        let app = app();
        assert!(read_pattern_tables(app.handle(), &resource).is_err());
        app.fs_scope().allow_directory(&resource, false).unwrap();
        let tables = read_pattern_tables(app.handle(), &resource).unwrap();
        let names: Vec<_> = tables.files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["leds.lua", "traf.lua"]);
        assert!(tables.dir.ends_with("_patternTypes"));
        assert!(!tables.dir.starts_with(r"\\?\"));
        let empty = fixture.0.join("Empty");
        std::fs::create_dir(&empty).unwrap();
        app.fs_scope().allow_directory(&empty, false).unwrap();
        assert!(read_pattern_tables(app.handle(), &empty)
            .unwrap_err()
            .contains("No ELS-FiveM pattern tables"));
    }
}
