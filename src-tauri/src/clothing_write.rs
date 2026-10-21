//! Clothing packs (freemode ped clothing) on the native side, with the names
//! src/lib/clothing-pack.js plans in:
//!
//! - The texture write: the user's images written as textures of one item
//!   (`<prefix>^<slot>_diff_<NNN>_<letter>_<race>.ytd`) beside its drawable,
//!   new ones counted in the pack's `<ped>_<dlc>.ymt`. Staged like the livery
//!   write, rebuilt before any user file changes, new files added and the
//!   rest replaced after backups, all or nothing.
//! - The pack build: a new resource folder made from clothing the user picked,
//!   written beside nothing it was made from. Files come only from folders the
//!   user opened, never from the game install, FiveM's own files or an
//!   escrowed resource, and only in GTA V's plain resource format.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::livery_write::{check_textures, CommitTexture, LiveryWriteState};

const COMPONENT_SLOTS: [&str; 12] = [
    "head", "berd", "hair", "uppr", "lowr", "hand", "feet", "teef", "accs", "task", "decl", "jbib",
];
const PROP_SLOTS: [&str; 13] = [
    "p_head",
    "p_eyes",
    "p_ears",
    "p_mouth",
    "p_lhand",
    "p_rhand",
    "p_lwrist",
    "p_rwrist",
    "p_hip",
    "p_lfoot",
    "p_rfoot",
    "p_ph_l_hand",
    "p_ph_r_hand",
];
const PEDS: [&str; 2] = ["mp_m_freemode_01", "mp_f_freemode_01"];
const MAX_ITEM_TEXTURES: usize = 26;
const MAX_YMT_XML: usize = 32 * 1024 * 1024;
const MAX_SEARCH_ENTRIES: usize = 20_000;
const MAX_BUILD_FILES: usize = 20_000;
const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// The one clothing texture write in progress: the livery write's staging
/// session under its own label.
pub struct ClothingWriteState(pub LiveryWriteState);

impl Default for ClothingWriteState {
    fn default() -> Self {
        Self(LiveryWriteState::labelled("clothing"))
    }
}

/// A clothing drawable's name: `<prefix>^<slot>_<NNN>[_u|_r].ydd`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemName {
    /// Before `^`: `<ped>_<dlc>`, `<ped>_p_<dlc>`, or empty for a name
    /// without a pack, as tools export them.
    pub prefix: String,
    pub ped: Option<String>,
    pub dlc: Option<String>,
    pub is_prop: bool,
    pub slot: String,
    pub index: String,
}

impl ItemName {
    /// What every texture file of this item starts with.
    fn texture_head(&self) -> String {
        let pack = if self.prefix.is_empty() {
            String::new()
        } else {
            format!("{}^", self.prefix)
        };
        format!("{pack}{}_diff_{}_", self.slot, self.index)
    }

    /// The pack's ped variation file name, when the name carries a pack.
    pub fn ymt_name(&self) -> Option<String> {
        Some(format!("{}_{}.ymt", self.ped.as_ref()?, self.dlc.as_ref()?))
    }
}

fn three_digits(text: &str) -> bool {
    text.len() == 3 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Reads a clothing drawable's file name (any case), or None.
pub fn parse_drawable_name(file_name: &str) -> Option<ItemName> {
    // Clothing names are ASCII; the byte slicing below relies on it.
    if !file_name.is_ascii() {
        return None;
    }
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".ydd")?;
    let (prefix, rest) = match stem.rsplit_once('^') {
        Some((prefix, rest)) => (prefix, rest),
        None => ("", stem),
    };
    // Slot names are tried longest first, so p_ph_l_hand is not read as a shorter one.
    let mut slots: Vec<(&str, bool)> = COMPONENT_SLOTS
        .iter()
        .map(|slot| (*slot, false))
        .chain(PROP_SLOTS.iter().map(|slot| (*slot, true)))
        .collect();
    slots.sort_by_key(|(slot, _)| std::cmp::Reverse(slot.len()));
    let (slot, is_prop, index) = slots.into_iter().find_map(|(slot, is_prop)| {
        let tail = rest.strip_prefix(slot)?.strip_prefix('_')?;
        let (index, after) = tail.split_at(tail.len().min(3));
        if !three_digits(index) {
            return None;
        }
        // Components end `_u` or `_r`; either may carry a first-person `_1`.
        let after = match after.as_bytes() {
            [b'_', digit] if digit.is_ascii_digit() && is_prop => "",
            _ => after,
        };
        let valid = if is_prop {
            after.is_empty()
        } else {
            matches!(after, "_u" | "_r")
                || (after.len() == 4
                    && matches!(&after[..2], "_u" | "_r")
                    && after.as_bytes()[2] == b'_'
                    && after.as_bytes()[3].is_ascii_digit())
        };
        valid.then(|| (slot.to_string(), is_prop, index.to_string()))
    })?;

    let (ped, dlc) = if prefix.is_empty() {
        (None, None)
    } else {
        let ped = PEDS.iter().find(|ped| prefix.starts_with(**ped))?;
        let after = &prefix[ped.len()..];
        let dlc = match (is_prop, after) {
            (_, "") => None,
            (true, "_p") => None,
            (true, after) => Some(after.strip_prefix("_p_")?.to_string()),
            (false, after) => Some(after.strip_prefix('_')?.to_string()),
        };
        if dlc.as_deref().is_some_and(|dlc| {
            dlc.is_empty()
                || !dlc
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            return None;
        }
        (Some(ped.to_string()), dlc)
    };
    Some(ItemName {
        prefix: prefix.to_string(),
        ped,
        dlc,
        is_prop,
        slot,
        index,
    })
}

/// True when `file_name` names one of `item`'s texture files:
/// `<head><letter>[_<race>].ytd` (props have no race).
pub fn is_item_texture_name(item: &ItemName, file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let Some(tail) = lower
        .strip_prefix(&item.texture_head())
        .and_then(|tail| tail.strip_suffix(".ytd"))
    else {
        return false;
    };
    let bytes = tail.as_bytes();
    match bytes {
        [letter] => letter.is_ascii_lowercase(),
        [letter, b'_', race @ ..] => {
            letter.is_ascii_lowercase()
                && race.len() == 3
                && race.iter().all(|byte| byte.is_ascii_lowercase())
        }
        _ => false,
    }
}

/// The drawable a write is for: a regular `.ydd` with a clothing name.
pub fn item_of(drawable: &Path) -> Result<ItemName, String> {
    let name = drawable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !std::fs::symlink_metadata(drawable).is_ok_and(|meta| meta.is_file()) {
        return Err(format!("Clothing item not found: {}", drawable.display()));
    }
    parse_drawable_name(name).ok_or_else(|| {
        format!("{name} is not named as a clothing item (such as jbib_000_u.ydd), so Cortex cannot tell which textures are its own.")
    })
}

/// The item's texture files that exist beside its drawable, sorted by name.
pub fn item_texture_files(drawable: &Path, item: &ItemName) -> Vec<PathBuf> {
    let Some(folder) = drawable.parent() else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| is_item_texture_name(item, &entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect();
    files.sort_by_key(|path| path.file_name().map(|name| name.to_ascii_lowercase()));
    files
}

/// Checks that `ytd` is one of the item's texture files beside its drawable:
/// one that exists for a replace or a template, one that does not yet for a
/// new texture. Returns the path to use.
pub fn validate_item_texture(
    drawable: &Path,
    item: &ItemName,
    ytd: &Path,
    exists: bool,
) -> Result<PathBuf, String> {
    let folder = drawable
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", drawable.display()))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or("The clothing item has no folder.")?;
    let name = ytd
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let parent = ytd
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or_else(|| format!("Cannot access the folder of {}.", ytd.display()))?;
    if parent != folder || !is_item_texture_name(item, name) {
        return Err(format!(
            "{} is not one of this clothing item's texture files.",
            ytd.display()
        ));
    }
    let path = folder.join(name);
    let present = std::fs::symlink_metadata(&path);
    if exists && !present.as_ref().is_ok_and(|meta| meta.is_file()) {
        return Err(format!("{name} is no longer beside the clothing item."));
    }
    if !exists && present.is_ok() {
        return Err(format!(
            "{name} already exists, so it is not written as a new texture."
        ));
    }
    Ok(path)
}

/// The nearest folder at or above `path` holding `fxmanifest.lua` or
/// `__resource.lua`, within six levels.
pub fn resource_root(path: &Path) -> Option<PathBuf> {
    path.ancestors().skip(1).take(7).find_map(|dir| {
        (dir.join("fxmanifest.lua").is_file() || dir.join("__resource.lua").is_file())
            .then(|| dir.to_path_buf())
    })
}

/// The pack's `.ymt` for `drawable`: searched in its resource (or, outside a
/// resource, its folder and the one above). None when there is none; an
/// error when the name appears more than once.
pub fn find_pack_ymt(drawable: &Path, item: &ItemName) -> Result<Option<PathBuf>, String> {
    let Some(wanted) = item.ymt_name() else {
        return Ok(None);
    };
    // Searched under the name the user opened, so the path reads as theirs;
    // the commit compares resolved paths.
    if !drawable.is_absolute() || !drawable.is_file() {
        return Err(format!("Cannot access {}.", drawable.display()));
    }
    let folder = drawable
        .parent()
        .ok_or("The clothing item has no folder.")?;
    let (root, depth) = match resource_root(drawable) {
        Some(root) => (root, 6),
        None => (folder.parent().unwrap_or(folder).to_path_buf(), 1),
    };
    let mut found = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
    let mut seen = 0usize;
    while let Some((dir, level)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_SEARCH_ENTRIES {
                return Err(format!(
                    "This resource is too large to search for {wanted}."
                ));
            }
            // file_type does not follow links, so the search stays in the resource.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && level < depth {
                queue.push_back((entry.path(), level + 1));
            } else if kind.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&wanted)
            {
                found.push(entry.path());
            }
        }
    }
    match found.len() {
        0 => Ok(None),
        1 => Ok(found.pop()),
        _ => Err(format!(
            "{wanted} is in this resource more than once ({}), so Cortex cannot tell which one the game uses.",
            found
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The first bytes of a file: GTA V's plain resource header and version.
pub fn resource_header(path: &Path) -> Option<(bool, u32)> {
    let mut header = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .ok()?;
    Some((
        &header[..4] == b"RSC7",
        u32::from_le_bytes([header[4], header[5], header[6], header[7]]),
    ))
}

/* ── The texture write ── */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub token: String,
    pub stamp: String,
    #[serde(default)]
    pub ymt: Option<CommitYmt>,
    pub ytds: Vec<CommitYtd>,
}

#[derive(serde::Deserialize)]
pub struct CommitYmt {
    pub path: PathBuf,
    pub xml: String,
    /// The file as `clothing_item` read it, which `xml` was made from. The
    /// commit reads it again and stops if it changed since.
    pub base: String,
}

#[derive(serde::Deserialize)]
pub struct CommitYtd {
    pub path: PathBuf,
    /// "replace" an existing texture file, or "create" a new one from `template`.
    pub mode: String,
    #[serde(default)]
    pub template: Option<PathBuf>,
    pub textures: Vec<CommitTexture>,
}

/// Checks a commit's shape against what was staged; the caller checks where
/// its files are (validate_item_texture, find_pack_ymt).
pub fn check_commit(
    request: &CommitRequest,
    staged: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    if !crate::lens_write::valid_stamp(&request.stamp) {
        return Err(format!("\"{}\" is not a backup stamp.", request.stamp));
    }
    if request.ytds.is_empty() || request.ytds.len() > MAX_ITEM_TEXTURES {
        return Err("A clothing write names 1 to 26 texture files.".into());
    }
    let mut creates = false;
    for ytd in &request.ytds {
        check_textures(&ytd.path, &ytd.textures, staged)?;
        match (ytd.mode.as_str(), ytd.template.is_some()) {
            ("replace", false) => {}
            ("create", true) => creates = true,
            ("replace", true) => {
                return Err(format!(
                    "{} is replaced, so it has no template.",
                    ytd.path.display()
                ))
            }
            ("create", false) => {
                return Err(format!(
                    "{} is new but names no texture to start from.",
                    ytd.path.display()
                ))
            }
            (other, _) => return Err(format!("Unknown clothing write mode \"{other}\".")),
        }
    }
    match &request.ymt {
        None if creates => Err("New textures must be counted in the pack's .ymt.".into()),
        Some(ymt) if !creates => Err(format!(
            "{} only changes when textures are added.",
            ymt.path.display()
        )),
        Some(ymt)
            if ymt.xml.is_empty()
                || ymt.xml.len() > MAX_YMT_XML
                || ymt.base.is_empty()
                || ymt.base.len() > MAX_YMT_XML =>
        {
            Err("The pack's ped variation data is empty or too large.".into())
        }
        _ => Ok(()),
    }
}

/// Puts the new files in place (never over a file), then replaces the rest
/// after backups, the .ymt last. All or nothing: when the replace fails, the
/// new files are removed again.
pub fn apply_write(
    created: &[(PathBuf, PathBuf)],
    replaced: &[(PathBuf, PathBuf)],
    stamp: &str,
) -> Result<(Vec<PathBuf>, Vec<crate::lens_write::Replaced>), String> {
    let mut made: Vec<PathBuf> = Vec::new();
    let undo = |made: &[PathBuf]| -> Vec<String> {
        made.iter()
            .rev()
            .filter_map(|path| {
                std::fs::remove_file(path)
                    .err()
                    .map(|error| format!("{} ({error})", path.display()))
            })
            .collect()
    };
    for (target, built) in created {
        // Written in place: create_new refuses a file that appeared meanwhile,
        // and the game does not look for a new texture until the .ymt (replaced
        // last) counts it.
        if let Err(error) = crate::lens_write::copy_new(built, target) {
            let left = undo(&made);
            let mut message = format!("Could not write {}: {error}.", target.display());
            if left.is_empty() {
                message.push_str(" Nothing was changed.");
            } else {
                message.push_str(&format!(
                    " These new files could not be removed: {}.",
                    left.join("; ")
                ));
            }
            return Err(message);
        }
        made.push(target.clone());
    }
    match crate::lens_write::replace_with_backups(replaced, stamp) {
        Ok(replaced) => Ok((made, replaced)),
        Err(mut message) => {
            let left = undo(&made);
            if !made.is_empty() {
                if left.is_empty() {
                    message.push_str(" The new texture files were removed.");
                } else {
                    message.push_str(&format!(
                        " These new files could not be removed: {}.",
                        left.join("; ")
                    ));
                }
            }
            Err(message)
        }
    }
}

/* ── The pack build ── */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub parent: PathBuf,
    pub name: String,
    pub copies: Vec<BuildCopy>,
    pub ymts: Vec<BuildText>,
    pub texts: Vec<BuildText>,
    #[serde(default)]
    pub creatures: Vec<BuildText>,
}

#[derive(serde::Deserialize)]
pub struct BuildCopy {
    pub from: PathBuf,
    pub to: String,
}

#[derive(serde::Deserialize)]
pub struct BuildText {
    pub to: String,
    #[serde(alias = "xml")]
    pub text: String,
}

/// What a path belongs to when Cortex never copies from it: the game
/// install, or FiveM's own data (where servers' streamed files are cached).
pub fn protected_source(path: &Path) -> Option<&'static str> {
    for dir in path.ancestors() {
        let name = dir
            .file_name()
            .map(|value| value.to_string_lossy().to_ascii_lowercase());
        if matches!(
            name.as_deref(),
            Some("fivem.app" | "fivem application data")
        ) {
            return Some("FiveM's own files");
        }
        if ["GTA5.exe", "GTA5_Enhanced.exe", "PlayGTAV.exe"]
            .iter()
            .any(|exe| dir.join(exe).is_file())
        {
            return Some("the GTA V install");
        }
    }
    None
}

/// True when `path` is in a resource Asset Escrow protects (a folder above it
/// holds `.fxap`, however deep). Cortex does not copy anything out of those.
pub fn escrowed(path: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .any(|dir| dir.join(".fxap").exists())
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 120
        && segment != "."
        && segment != ".."
        && !segment.starts_with('.')
        && segment
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '-' | '.' | '^' | '+'))
}

/// A path inside the new resource: relative, `/`-separated, plain names.
fn relative_target(to: &str) -> Result<PathBuf, String> {
    let segments: Vec<&str> = to.split('/').collect();
    if segments.len() > 4 || !segments.iter().all(|segment| valid_segment(segment)) {
        return Err(format!("\"{to}\" is not a file name inside the new pack."));
    }
    let path: PathBuf = segments.iter().collect();
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("\"{to}\" is not a file name inside the new pack."));
    }
    Ok(path)
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// The resource folder name the pack is written as.
pub fn valid_resource_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A build checked against where it may read and write. `allowed` says
/// whether the user opened a path in Cortex (the filesystem scope).
pub struct CheckedBuild {
    pub target: PathBuf,
    pub copies: Vec<(PathBuf, PathBuf)>,
    pub ymts: Vec<(PathBuf, String)>,
    pub texts: Vec<(PathBuf, String)>,
    pub creatures: Vec<(PathBuf, String)>,
}

pub fn check_build(
    request: &BuildRequest,
    allowed: impl Fn(&Path) -> bool,
) -> Result<CheckedBuild, String> {
    if !valid_resource_name(&request.name) {
        return Err(format!(
            "\"{}\" cannot be a resource folder name: use letters, digits, _ and -.",
            request.name
        ));
    }
    let parent = request
        .parent
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", request.parent.display()))?;
    if !parent.is_dir() || !allowed(&parent) {
        return Err(format!(
            "Pick the folder for the new pack in Cortex first ({}).",
            request.parent.display()
        ));
    }
    if let Some(owner) = protected_source(&parent) {
        return Err(format!(
            "{} is inside {owner}, so the pack is not written there.",
            request.parent.display()
        ));
    }
    // Written where the user picked; the checks above ran on the resolved folder.
    let target = request.parent.join(&request.name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!(
            "{} already exists. Pick another name or folder; Cortex does not write over it.",
            target.display()
        ));
    }
    let total =
        request.copies.len() + request.ymts.len() + request.texts.len() + request.creatures.len();
    if request.copies.is_empty() || total > MAX_BUILD_FILES {
        return Err("A pack build copies 1 to 20000 files.".into());
    }

    let mut names = HashSet::new();
    let mut claim = |to: &str| -> Result<PathBuf, String> {
        let relative = relative_target(to)?;
        if !names.insert(to.to_ascii_lowercase()) {
            return Err(format!("{to} is written twice."));
        }
        Ok(relative)
    };

    let mut copies = Vec::with_capacity(request.copies.len());
    let mut checked_sources: HashMap<PathBuf, PathBuf> = HashMap::new();
    for copy in &request.copies {
        let relative = claim(&copy.to)?;
        let ext = extension_of(&copy.to);
        if !matches!(ext.as_str(), "ydd" | "ytd" | "yld")
            || extension_of(&copy.from.to_string_lossy()) != ext
        {
            return Err(format!(
                "{} cannot become {}.",
                copy.from.display(),
                copy.to
            ));
        }
        if !copy.to.starts_with("stream/") {
            return Err(format!("{} must go in the stream folder.", copy.to));
        }
        let from = match checked_sources.get(&copy.from) {
            Some(from) => from.clone(),
            None => {
                let from = check_source(&copy.from, &ext, &allowed)?;
                checked_sources.insert(copy.from.clone(), from.clone());
                from
            }
        };
        copies.push((from, relative));
    }
    let mut ymts = Vec::with_capacity(request.ymts.len());
    for ymt in &request.ymts {
        let relative = claim(&ymt.to)?;
        if extension_of(&ymt.to) != "ymt"
            || !ymt.to.starts_with("stream/")
            || ymt.to.matches('/').count() != 1
        {
            return Err(format!(
                "{} is not a ped variation file in the stream folder.",
                ymt.to
            ));
        }
        if ymt.text.is_empty() || ymt.text.len() > MAX_YMT_XML {
            return Err(format!("The data for {} is empty or too large.", ymt.to));
        }
        ymts.push((relative, ymt.text.clone()));
    }
    let mut creatures = Vec::with_capacity(request.creatures.len());
    for creature in &request.creatures {
        let relative = claim(&creature.to)?;
        let file_name = creature.to.strip_prefix("stream/").unwrap_or("");
        if extension_of(&creature.to) != "ymt"
            || file_name.contains('/')
            || !file_name.starts_with("mp_creaturemetadata_")
        {
            return Err(format!(
                "{} is not creature metadata in the stream folder.",
                creature.to
            ));
        }
        if creature.text.is_empty() || creature.text.len() > MAX_YMT_XML {
            return Err(format!(
                "The data for {} is empty or too large.",
                creature.to
            ));
        }
        creatures.push((relative, creature.text.clone()));
    }
    let mut texts = Vec::with_capacity(request.texts.len());
    for text in &request.texts {
        let relative = claim(&text.to)?;
        let root_file = !text.to.contains('/');
        if !root_file || !(text.to == "fxmanifest.lua" || extension_of(&text.to) == "meta") {
            return Err(format!(
                "{} is not a manifest or meta file at the top of the pack.",
                text.to
            ));
        }
        if text.text.is_empty() || text.text.len() > MAX_TEXT_BYTES {
            return Err(format!("{} is empty or too large.", text.to));
        }
        texts.push((relative, text.text.clone()));
    }
    if !texts
        .iter()
        .any(|(path, _)| path == Path::new("fxmanifest.lua"))
    {
        return Err("The pack has no fxmanifest.lua.".into());
    }
    Ok(CheckedBuild {
        target,
        copies,
        ymts,
        texts,
        creatures,
    })
}

/// A file the build copies: opened in Cortex, outside the game and FiveM's
/// files and escrowed resources, and in GTA V's plain (legacy) format.
fn check_source(
    path: &Path,
    ext: &str,
    allowed: &impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let regular = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file());
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", path.display()))?;
    if !regular || !allowed(&resolved) {
        return Err(format!(
            "{} was not opened in Cortex, so it is not copied.",
            path.display()
        ));
    }
    if let Some(owner) = protected_source(&resolved) {
        return Err(format!(
            "{} is part of {owner}; Cortex only builds packs from clothing you have as files.",
            path.display()
        ));
    }
    if escrowed(&resolved) {
        return Err(format!(
            "{} is in an escrowed resource (it has .fxap), so Cortex does not copy from it.",
            path.display()
        ));
    }
    let legacy = matches!(
        (resource_header(&resolved), ext),
        (Some((true, 13)), "ytd") | (Some((true, 165)), "ydd") | (Some((true, 8)), "yld")
    );
    if !legacy {
        return Err(format!(
            "{} is not a legacy GTA V {ext} file (it may be encrypted or from GTA V Enhanced), so it is not copied.",
            path.display()
        ));
    }
    Ok(resolved)
}

/// A clothing file in a folder the user picked to build from.
#[derive(Debug, serde::Serialize)]
pub struct FolderFile {
    pub path: PathBuf,
    /// In a resource Asset Escrow protects: listed so the user sees why it is
    /// left out, never copied.
    pub escrowed: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub files: Vec<FolderFile>,
    /// The folder held more than Cortex lists; the rest is left out.
    pub truncated: bool,
}

/// The clothing files (`.ydd`, `.ytd`, `.yld`, `.ymt`) in `folder` and its
/// folders, eight levels deep, without following links, sorted by path.
pub fn scan_clothing_folder(folder: &Path) -> Result<FolderScan, String> {
    if let Some(owner) = protected_source(folder) {
        return Err(format!(
            "{} is part of {owner}; Cortex only builds packs from clothing you have as files.",
            folder.display()
        ));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    let mut seen = 0usize;
    // A folder inside an escrowed resource: its own .fxap is checked in the walk.
    let above = escrowed(folder);
    let mut queue = std::collections::VecDeque::from([(folder.to_path_buf(), above, 0usize)]);
    'walk: while let Some((dir, inherited, level)) = queue.pop_front() {
        let locked = inherited || dir.join(".fxap").exists();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_SEARCH_ENTRIES {
                truncated = true;
                break 'walk;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if level < 8 {
                    queue.push_back((path, locked, level + 1));
                } else {
                    truncated = true;
                }
            } else if kind.is_file()
                && matches!(
                    extension_of(&path.to_string_lossy()).as_str(),
                    "ydd" | "ytd" | "yld" | "ymt"
                )
            {
                files.push(FolderFile {
                    path,
                    escrowed: locked,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FolderScan { files, truncated })
}

/* ── Identical files ── */

fn content_hash(path: &Path) -> std::io::Result<u64> {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
    }
    Ok(hasher.finish())
}

fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut left = std::io::BufReader::new(std::fs::File::open(a)?);
    let mut right = std::io::BufReader::new(std::fs::File::open(b)?);
    let mut one = vec![0u8; 1 << 16];
    let mut two = vec![0u8; 1 << 16];
    loop {
        let read = left.read(&mut one)?;
        if read == 0 {
            return Ok(right.read(&mut two[..1])? == 0);
        }
        // A file that changed size since the sizes were compared is not the same.
        match right.read_exact(&mut two[..read]) {
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
            other => other?,
        }
        if one[..read] != two[..read] {
            return Ok(false);
        }
    }
}

/// Groups files with the same bytes: returns, for each path in a group of two
/// or more, the group's number. Sizes rule most files out; a hash narrows the
/// rest and a byte comparison confirms every member.
pub fn identical_groups(paths: &[PathBuf]) -> Result<HashMap<usize, usize>, String> {
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for (index, path) in paths.iter().enumerate() {
        let meta = std::fs::metadata(path)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        by_size.entry(meta.len()).or_default().push(index);
    }
    let mut groups = HashMap::new();
    let mut next = 0usize;
    let mut sizes: Vec<_> = by_size
        .into_iter()
        .filter(|(_, list)| list.len() > 1)
        .collect();
    sizes.sort_by_key(|(_, list)| list[0]);
    for (_, list) in sizes {
        let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        for index in list {
            let hash = content_hash(&paths[index])
                .map_err(|error| format!("Cannot read {}: {error}", paths[index].display()))?;
            by_hash.entry(hash).or_default().push(index);
        }
        let mut candidates: Vec<_> = by_hash
            .into_values()
            .filter(|list| list.len() > 1)
            .collect();
        candidates.sort_by_key(|list| list[0]);
        for list in candidates {
            // Members join the first file they match byte for byte.
            let mut leaders: Vec<(usize, usize)> = Vec::new();
            for index in list {
                let mut joined = None;
                for (leader, group) in &leaders {
                    if same_bytes(&paths[*leader], &paths[index]).map_err(|error| {
                        format!("Cannot read {}: {error}", paths[index].display())
                    })? {
                        joined = Some(*group);
                        break;
                    }
                }
                match joined {
                    Some(group) => {
                        groups.insert(index, group);
                    }
                    None => {
                        leaders.push((index, next));
                        groups.insert(index, next);
                        next += 1;
                    }
                }
            }
        }
    }
    // A file that matched nothing is not in a group.
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for group in groups.values() {
        *counts.entry(*group).or_default() += 1;
    }
    groups.retain(|_, group| counts[group] > 1);
    Ok(groups)
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
                "cortex-clothing-write-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn resource(version: u32) -> Vec<u8> {
        [b"RSC7".as_slice(), &version.to_le_bytes(), &[0; 8]].concat()
    }

    #[test]
    fn drawable_names_give_their_pack_slot_and_number() {
        let vest =
            parse_drawable_name("mp_m_freemode_01_mp_m_gsdmods_vests^task_003_u.ydd").unwrap();
        assert_eq!(vest.prefix, "mp_m_freemode_01_mp_m_gsdmods_vests");
        assert_eq!(vest.ped.as_deref(), Some("mp_m_freemode_01"));
        assert_eq!(vest.dlc.as_deref(), Some("mp_m_gsdmods_vests"));
        assert_eq!(
            (vest.slot.as_str(), vest.index.as_str(), vest.is_prop),
            ("task", "003", false)
        );
        assert_eq!(
            vest.ymt_name().as_deref(),
            Some("mp_m_freemode_01_mp_m_gsdmods_vests.ymt")
        );

        let hat =
            parse_drawable_name("MP_F_FREEMODE_01_P_MP_F_GSDMOD_COWBOY^P_HEAD_002.ydd").unwrap();
        assert_eq!(hat.dlc.as_deref(), Some("mp_f_gsdmod_cowboy"));
        assert!(hat.is_prop);
        assert_eq!(
            hat.ymt_name().as_deref(),
            Some("mp_f_freemode_01_mp_f_gsdmod_cowboy.ymt")
        );

        let hand = parse_drawable_name("mp_m_freemode_01_p_pack^p_ph_l_hand_010.ydd").unwrap();
        assert_eq!(hand.slot, "p_ph_l_hand");
        let loose = parse_drawable_name("jbib_012_r.ydd").unwrap();
        assert_eq!(
            (
                loose.prefix.as_str(),
                loose.ped.as_deref(),
                loose.ymt_name()
            ),
            ("", None, None)
        );
        assert!(parse_drawable_name("jbib_000_u_1.ydd").is_some());

        for bad in [
            "jbib_000.ydd",
            "p_head_000_u.ydd",
            "shirt_000_u.ydd",
            "jbib_00_u.ydd",
            "mp_x_freemode_01_pack^jbib_000_u.ydd",
            "mp_m_freemode_01_pack^jbib_000_u.ytd",
            "mp_m_freemode_01_pack^p_head_000.ydd",
            // Non-ASCII names are not clothing names, and must not panic.
            "jbib_12\u{e9}_u.ydd",
            "jbib_000_\u{e9}1.ydd",
        ] {
            assert!(parse_drawable_name(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_the_items_own_texture_names_match() {
        let item = parse_drawable_name("mp_m_freemode_01_mp_m_pack^jbib_004_u.ydd").unwrap();
        for good in [
            "mp_m_freemode_01_mp_m_pack^jbib_diff_004_a_uni.ytd",
            "MP_M_FREEMODE_01_MP_M_PACK^JBIB_DIFF_004_Z_WHI.YTD",
        ] {
            assert!(is_item_texture_name(&item, good), "{good}");
        }
        for bad in [
            "mp_m_freemode_01_mp_m_pack^jbib_diff_005_a_uni.ytd",
            "mp_m_freemode_01_mp_m_other^jbib_diff_004_a_uni.ytd",
            "mp_m_freemode_01_mp_m_pack^jbib_diff_004_aa_uni.ytd",
            "mp_m_freemode_01_mp_m_pack^jbib_diff_004_a_uni.ydd",
            "mp_m_freemode_01_mp_m_pack^jbib_diff_004_a_un.ytd",
        ] {
            assert!(!is_item_texture_name(&item, bad), "{bad}");
        }
        let hat = parse_drawable_name("mp_m_freemode_01_p_pack^p_head_000.ydd").unwrap();
        assert!(is_item_texture_name(
            &hat,
            "mp_m_freemode_01_p_pack^p_head_diff_000_c.ytd"
        ));
    }

    #[test]
    fn texture_targets_stay_beside_their_item() {
        let fixture = Fixture::new();
        let drawable = fixture.file(
            "stream/pack/mp_m_freemode_01_mp_m_pack^task_000_u.ydd",
            &resource(165),
        );
        let a = fixture.file(
            "stream/pack/mp_m_freemode_01_mp_m_pack^task_diff_000_a_uni.ytd",
            &resource(13),
        );
        fixture.file(
            "stream/mp_m_freemode_01_mp_m_pack^task_diff_000_b_uni.ytd",
            &resource(13),
        );
        let item = item_of(&drawable).unwrap();
        assert_eq!(item_texture_files(&drawable, &item), vec![a.clone()]);
        assert!(validate_item_texture(&drawable, &item, &a, true).is_ok());
        assert!(validate_item_texture(&drawable, &item, &a, false).is_err());
        let b = a.with_file_name("mp_m_freemode_01_mp_m_pack^task_diff_000_b_uni.ytd");
        assert!(validate_item_texture(&drawable, &item, &b, false).is_ok());
        assert!(validate_item_texture(&drawable, &item, &b, true).is_err());
        let elsewhere = fixture
            .0
            .join("stream/mp_m_freemode_01_mp_m_pack^task_diff_000_c_uni.ytd");
        assert!(validate_item_texture(&drawable, &item, &elsewhere, false).is_err());
        let sneaky = fixture
            .0
            .join("stream/pack/../mp_m_freemode_01_mp_m_pack^task_diff_000_c_uni.ytd");
        assert!(validate_item_texture(&drawable, &item, &sneaky, false).is_err());
    }

    #[test]
    fn the_pack_ymt_is_found_once_in_the_resource() {
        let fixture = Fixture::new();
        fixture.file("fxmanifest.lua", b"fx_version 'cerulean'");
        let drawable = fixture.file(
            "stream/a/mp_m_freemode_01_mp_m_pack^task_000_u.ydd",
            &resource(165),
        );
        let item = item_of(&drawable).unwrap();
        assert_eq!(find_pack_ymt(&drawable, &item).unwrap(), None);
        let ymt = fixture.file("stream/mp_m_freemode_01_mp_m_pack.ymt", &resource(2));
        assert_eq!(
            find_pack_ymt(&drawable, &item)
                .unwrap()
                .map(|path| path.canonicalize().unwrap()),
            Some(ymt.canonicalize().unwrap())
        );
        fixture.file("stream/copy/mp_m_freemode_01_mp_m_pack.ymt", &resource(2));
        assert!(find_pack_ymt(&drawable, &item).is_err());
    }

    fn texture(name: &str, mode: &str, id: Option<&str>) -> CommitTexture {
        CommitTexture {
            name: name.into(),
            mode: mode.into(),
            id: id.map(Into::into),
            like: None,
        }
    }

    #[test]
    fn a_commit_counts_new_textures_in_the_ymt() {
        let staged: HashMap<String, PathBuf> = [("a".to_string(), PathBuf::from("a.dds"))].into();
        let replace = CommitRequest {
            token: "t".into(),
            stamp: "20261019-101500".into(),
            ymt: None,
            ytds: vec![CommitYtd {
                path: "x^task_diff_000_a_uni.ytd".into(),
                mode: "replace".into(),
                template: None,
                textures: vec![texture("t", "replace", Some("a"))],
            }],
        };
        assert!(check_commit(&replace, &staged).is_ok());
        let create = |ymt: Option<CommitYmt>, template: Option<PathBuf>| CommitRequest {
            token: "t".into(),
            stamp: "20261019-101500".into(),
            ymt,
            ytds: vec![CommitYtd {
                path: "x^task_diff_000_b_uni.ytd".into(),
                mode: "create".into(),
                template,
                textures: vec![texture("t", "replace", Some("a"))],
            }],
        };
        let ymt = || {
            Some(CommitYmt {
                path: "x.ymt".into(),
                xml: "<CPedVariationInfo />".into(),
                base: "<CPedVariationInfo />".into(),
            })
        };
        assert!(check_commit(&create(ymt(), Some("a.ytd".into())), &staged).is_ok());
        let mut baseless = ymt();
        baseless.as_mut().unwrap().base.clear();
        assert!(check_commit(&create(baseless, Some("a.ytd".into())), &staged).is_err());
        assert!(check_commit(&create(None, Some("a.ytd".into())), &staged).is_err());
        assert!(check_commit(&create(ymt(), None), &staged).is_err());
        let mut stray = replace;
        stray.ymt = ymt();
        assert!(check_commit(&stray, &staged).is_err());
    }

    #[test]
    fn a_failed_replace_takes_the_new_files_back() {
        let fixture = Fixture::new();
        let built = fixture.file("built.ytd", b"new");
        let target = fixture.0.join("new.ytd");
        let missing = fixture.0.join("gone.ytd");
        let result = apply_write(
            &[(target.clone(), built.clone())],
            &[(missing, built.clone())],
            "20261019-101500",
        );
        assert!(result.is_err());
        assert!(!target.exists());
        let existing = fixture.file("old.ytd", b"old");
        let (made, replaced) = apply_write(
            &[(target.clone(), built.clone())],
            &[(existing.clone(), built.clone())],
            "20261019-101501",
        )
        .unwrap();
        assert_eq!(made, vec![target.clone()]);
        assert_eq!(std::fs::read(&existing).unwrap(), b"new");
        assert_eq!(std::fs::read(&replaced[0].backup).unwrap(), b"old");
        assert!(apply_write(&[(target, built)], &[], "20261019-101502").is_err());
    }

    #[test]
    fn a_build_writes_only_new_files_from_opened_plain_sources() {
        let fixture = Fixture::new();
        let source = fixture.file(
            "src/res/stream/mp_m_freemode_01_mp_m_a^task_000_u.ydd",
            &resource(165),
        );
        let texture = fixture.file(
            "src/res/stream/mp_m_freemode_01_mp_m_a^task_diff_000_a_uni.ytd",
            &resource(13),
        );
        let out = fixture.0.join("out");
        std::fs::create_dir(&out).unwrap();
        let request = |copies: Vec<(PathBuf, &str)>, name: &str| BuildRequest {
            parent: out.clone(),
            name: name.into(),
            copies: copies
                .into_iter()
                .map(|(from, to)| BuildCopy {
                    from,
                    to: to.into(),
                })
                .collect(),
            creatures: vec![],
            ymts: vec![BuildText {
                to: "stream/mp_m_freemode_01_mp_m_b.ymt".into(),
                text: "<x/>".into(),
            }],
            texts: vec![BuildText {
                to: "fxmanifest.lua".into(),
                text: "fx_version 'cerulean'".into(),
            }],
        };
        let anywhere = |_: &Path| true;
        let good = request(
            vec![
                (
                    source.clone(),
                    "stream/b/mp_m_freemode_01_mp_m_b^task_000_u.ydd",
                ),
                (
                    texture.clone(),
                    "stream/b/mp_m_freemode_01_mp_m_b^task_diff_000_a_uni.ytd",
                ),
            ],
            "my_pack",
        );
        let checked = check_build(&good, anywhere).unwrap();
        assert_eq!(checked.target, out.join("my_pack"));
        assert_eq!(checked.copies.len(), 2);
        assert!(check_build(&good, |_: &Path| false).is_err());

        for (copies, name) in [
            (vec![(source.clone(), "stream/b/x.ydd")], "../up"),
            (vec![(source.clone(), "../x.ydd")], "p"),
            (vec![(source.clone(), "stream/../../x.ydd")], "p"),
            (vec![(source.clone(), "x.ydd")], "p"),
            (vec![(source.clone(), "stream/b/x.ytd")], "p"),
            (
                vec![
                    (source.clone(), "stream/a.ydd"),
                    (texture.clone(), "stream/A.ydd"),
                ],
                "p",
            ),
        ] {
            assert!(check_build(&request(copies, name), anywhere).is_err());
        }
        std::fs::create_dir(out.join("taken")).unwrap();
        assert!(check_build(
            &request(vec![(source.clone(), "stream/b/x.ydd")], "taken"),
            anywhere
        )
        .is_err());

        let encrypted = fixture.file("src/res/stream/enc^task_001_u.ydd", b"FXAP0000");
        assert!(check_build(&request(vec![(encrypted, "stream/b/x.ydd")], "p"), anywhere).is_err());
        // Cloth is legacy at version 8 only.
        let cloth = fixture.file("src/res/stream/c^task_000_u.yld", &resource(8));
        let newer = fixture.file("src/res/stream/d^task_000_u.yld", &resource(9));
        assert!(check_build(&request(vec![(cloth, "stream/b/x.yld")], "p"), anywhere).is_ok());
        assert!(check_build(&request(vec![(newer, "stream/b/x.yld")], "p"), anywhere).is_err());
        // Escrow covers every folder below the .fxap, however deep.
        let deep = fixture.file(
            "src/res/a/b/c/d/e/f/g/h/i/j/x^task_000_u.ydd",
            &resource(165),
        );
        assert!(check_build(
            &request(vec![(deep.clone(), "stream/b/x.ydd")], "p"),
            anywhere
        )
        .is_ok());
        fixture.file("src/res/.fxap", b"escrow");
        assert!(check_build(&good, anywhere).is_err());
        assert!(check_build(
            &request(vec![(deep.clone(), "stream/b/x.ydd")], "p"),
            anywhere
        )
        .is_err());
        let scan = scan_clothing_folder(deep.parent().unwrap()).unwrap();
        assert!(scan.files.iter().all(|file| file.escrowed));
    }

    #[test]
    fn game_and_fivem_files_are_never_sources() {
        let fixture = Fixture::new();
        let game = fixture.file("gta/GTA5.exe", b"");
        let inside = fixture.file("gta/mods/x.ydd", &resource(165));
        assert_eq!(protected_source(&inside), Some("the GTA V install"));
        let _ = game;
        let cache = fixture.file("FiveM/FiveM.app/data/cache/x.ydd", &resource(165));
        assert_eq!(protected_source(&cache), Some("FiveM's own files"));
        let own = fixture.file("mine/x.ydd", &resource(165));
        assert_eq!(protected_source(&own), None);
    }

    #[test]
    fn identical_files_share_a_group() {
        let fixture = Fixture::new();
        let paths = vec![
            fixture.file("a.ydd", b"same model"),
            fixture.file("b.ydd", b"other mode"),
            fixture.file("c.ydd", b"same model"),
            fixture.file("d.ydd", b"short"),
        ];
        let groups = identical_groups(&paths).unwrap();
        assert_eq!(groups.get(&0), groups.get(&2));
        assert!(groups.contains_key(&0));
        assert!(!groups.contains_key(&1));
        assert!(!groups.contains_key(&3));
    }
}
