use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::clothing_write::escrowed;

const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 8;
pub const MAX_MODELS: usize = 64;
const EXTENSIONS: &[&str] = &[
    "ytd", "yft", "ydr", "ydd", "ybn", "ycd", "ypt", "yld", "ynv",
];
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "cache"];
const HEADER_BYTES: u64 = 16;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamedFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub magic: Option<String>,
    pub version: Option<u32>,
    pub virtual_flags: Option<u32>,
    pub physical_flags: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct Unreadable {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamedAssets {
    pub files: Vec<StreamedFile>,
    pub unreadable: Vec<Unreadable>,
    pub escrowed: Vec<PathBuf>,
    pub truncated: bool,
}

fn has_stream_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| {
            EXTENSIONS
                .iter()
                .any(|wanted| ext.eq_ignore_ascii_case(wanted))
        })
}

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub fn read_header(path: &Path) -> Result<StreamedFile, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let bytes = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = Vec::with_capacity(HEADER_BYTES as usize);
    file.by_ref()
        .take(HEADER_BYTES)
        .read_to_end(&mut header)
        .map_err(|error| error.to_string())?;
    let word = |offset: usize| {
        header
            .get(offset..offset + 4)
            .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
    };
    let complete = header.len() as u64 == HEADER_BYTES;
    let magic = match header.get(..4) {
        Some(b"RSC7") if complete => Some("RSC7"),
        Some(b"RSC8") if complete => Some("RSC8"),
        _ => None,
    };
    Ok(StreamedFile {
        path: path.to_path_buf(),
        bytes,
        magic: magic.map(str::to_string),
        version: magic.and(word(4)),
        virtual_flags: magic.and(word(8)),
        physical_flags: magic.and(word(12)),
    })
}

fn model_twin(model: &Path) -> Option<PathBuf> {
    let stem = model.file_stem()?.to_str()?;
    let name = if stem.to_ascii_lowercase().ends_with("_hi") {
        format!("{}.yft", &stem[..stem.len() - 3])
    } else {
        format!("{stem}_hi.yft")
    };
    Some(model.with_file_name(name))
}

fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

struct Collector {
    out: StreamedAssets,
    seen: HashSet<String>,
}

impl Collector {
    fn read(&mut self, path: &Path) {
        if !self.seen.insert(key(path)) {
            return;
        }
        match read_header(path) {
            Ok(file) => self.out.files.push(file),
            Err(message) => self.out.unreadable.push(Unreadable {
                path: path.to_path_buf(),
                message,
            }),
        }
    }

    fn walk(&mut self, root: &Path) {
        if escrowed(root) {
            self.out.escrowed.push(root.to_path_buf());
            return;
        }
        let mut seen = 0usize;
        let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
        'walk: while let Some((dir, level)) = queue.pop_front() {
            if dir.join(".fxap").exists() {
                self.out.escrowed.push(dir);
                continue;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) => {
                    self.out.unreadable.push(Unreadable {
                        path: dir,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            for entry in entries.flatten() {
                seen += 1;
                if seen > MAX_ENTRIES {
                    self.out.truncated = true;
                    break 'walk;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if kind.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    if SKIPPED_DIRS.contains(&name.as_str()) {
                        continue;
                    }
                    if level < MAX_DEPTH {
                        queue.push_back((path, level + 1));
                    } else {
                        self.out.truncated = true;
                    }
                } else if kind.is_file() && has_stream_extension(&path) {
                    self.read(&path);
                }
            }
        }
    }

    fn model(&mut self, model: &Path, allowed: &dyn Fn(&Path) -> bool) {
        if escrowed(model) {
            if let Some(parent) = model.parent() {
                self.out.escrowed.push(parent.to_path_buf());
            }
            return;
        }
        let mut models = vec![model.to_path_buf()];
        models.extend(model_twin(model));
        let mut candidates = models.clone();
        for path in &models {
            candidates.extend(crate::model_resource_scope::model_sibling_ytds(path));
        }
        for path in candidates {
            if !is_regular_file(&path) || self.seen.contains(&key(&path)) {
                continue;
            }
            if allowed(&path) {
                self.read(&path);
            } else {
                self.out.unreadable.push(Unreadable {
                    path,
                    message: "Cortex has no access to it; open its folder in Cortex first.".into(),
                });
            }
        }
    }
}

pub fn describe(
    root: Option<&Path>,
    models: &[PathBuf],
    allowed: &dyn Fn(&Path) -> bool,
) -> StreamedAssets {
    let mut collector = Collector {
        out: StreamedAssets::default(),
        seen: HashSet::new(),
    };
    if let Some(root) = root {
        collector.walk(root);
    }
    for model in models {
        collector.model(model, allowed);
    }
    let mut out = collector.out;
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    out.escrowed.sort();
    out.escrowed.dedup();
    out
}
