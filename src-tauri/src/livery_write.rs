//! The livery write: the user's own images written as livery textures
//! (`<prefix>_sign_N`) into the vehicle's own texture dictionaries. A batch of
//! 4K liveries is too large for one IPC body, so the renderer stages each DDS
//! into a session folder in the app cache, then commits the plan. The commit
//! rebuilds every dictionary before any user file is touched and replaces them
//! with backups, as the lens write does (lens_write::replace_with_backups).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::lens_write::{valid_stamp, valid_texture_name};

const MAX_DICTIONARIES: usize = 8;
const MAX_TEXTURES: usize = 128;
const MAX_STAGED: usize = 512;
const MAX_DDS_BYTES: usize = 384 * 1024 * 1024;
const CANCELLED: &str = "This livery write was cancelled. Nothing was changed.";

struct Session {
    token: String,
    model: PathBuf,
    dir: PathBuf,
    staged: HashMap<String, PathBuf>,
}

/// The one livery write in progress, if any.
#[derive(Default)]
pub struct LiveryWriteState(Mutex<Option<Session>>);

/// A committed session's staged files. Dropping it removes the session folder.
pub struct Staged {
    pub model: PathBuf,
    pub dir: PathBuf,
    pub files: HashMap<String, PathBuf>,
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn lock(state: &Mutex<Option<Session>>) -> std::sync::MutexGuard<'_, Option<Session>> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A staged file's id: what the renderer calls it in the commit.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

impl LiveryWriteState {
    /// Starts a write for `model`, staging into a new folder under `root`.
    /// One write runs at a time: an earlier session is dropped with its folder,
    /// and so are folders an earlier run of the app left behind.
    pub fn begin(&self, root: &Path, model: PathBuf) -> Result<String, String> {
        let mut session = lock(&self.0);
        if let Some(previous) = session.take() {
            let _ = std::fs::remove_dir_all(previous.dir);
        }
        let own = format!("{}-", std::process::id());
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let stale = !entry.file_name().to_string_lossy().starts_with(&own);
                if stale && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let token = format!("{own}{nanos}");
        let dir = root.join(&token);
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Cannot prepare the livery write: {error}"))?;
        *session = Some(Session {
            token: token.clone(),
            model,
            dir,
            staged: HashMap::new(),
        });
        Ok(token)
    }

    /// Keeps one texture's DDS for the commit under `id`.
    pub fn stage(&self, token: &str, id: &str, dds: &[u8]) -> Result<(), String> {
        if !valid_id(id) {
            return Err(format!("\"{id}\" is not a staged texture id."));
        }
        let path = {
            let session = lock(&self.0);
            let session = session
                .as_ref()
                .filter(|session| session.token == token)
                .ok_or(CANCELLED)?;
            if session.staged.contains_key(id) {
                return Err(format!("{id} is staged twice."));
            }
            if session.staged.len() >= MAX_STAGED {
                return Err("A livery write holds too many textures.".into());
            }
            session.dir.join(format!("{id}.dds"))
        };
        // Written outside the lock: a large DDS takes a moment.
        std::fs::write(&path, dds)
            .map_err(|error| format!("Cannot prepare livery texture {id}: {error}"))?;
        let mut session = lock(&self.0);
        match session.as_mut().filter(|session| session.token == token) {
            Some(session) => {
                session.staged.insert(id.to_string(), path);
                Ok(())
            }
            None => {
                let _ = std::fs::remove_file(&path);
                Err(CANCELLED.into())
            }
        }
    }

    /// Ends the session for its commit. The token cannot be used again.
    pub fn take(&self, token: &str) -> Result<Staged, String> {
        let mut session = lock(&self.0);
        match session.take() {
            Some(current) if current.token == token => Ok(Staged {
                model: current.model,
                dir: current.dir,
                files: current.staged,
            }),
            other => {
                *session = other;
                Err(CANCELLED.into())
            }
        }
    }

    /// Drops the session and what it staged, when `token` is still current.
    pub fn cancel(&self, token: &str) {
        drop(self.take(token));
    }
}

#[derive(serde::Deserialize)]
struct StageHeader {
    token: String,
    id: String,
}

/// Body of `livery_write_stage`: a little-endian u32 header length, the UTF-8
/// JSON header `{ token, id }`, then one DDS file.
pub fn parse_stage(body: &[u8]) -> Result<(String, String, &[u8]), String> {
    let length = body
        .get(..4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .ok_or("The livery texture is empty.")?;
    let header_end = 4usize
        .checked_add(length)
        .filter(|end| *end <= body.len())
        .ok_or("The livery texture header is truncated.")?;
    let header: StageHeader = serde_json::from_slice(&body[4..header_end])
        .map_err(|error| format!("The livery texture header is not valid: {error}"))?;
    let dds = &body[header_end..];
    if dds.len() > MAX_DDS_BYTES {
        return Err(format!("Livery texture {} is too large.", header.id));
    }
    if dds.len() < 128 || &dds[..4] != b"DDS " {
        return Err(format!("Livery texture {} is not a DDS file.", header.id));
    }
    Ok((header.token, header.id, dds))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub token: String,
    pub stamp: String,
    pub ytds: Vec<CommitYtd>,
}

#[derive(serde::Deserialize)]
pub struct CommitYtd {
    pub path: PathBuf,
    pub textures: Vec<CommitTexture>,
}

#[derive(serde::Deserialize)]
pub struct CommitTexture {
    pub name: String,
    pub mode: String,
    pub id: String,
    /// For "insert": a texture in the same dictionary whose use it takes.
    #[serde(default)]
    pub like: Option<String>,
}

/// Checks a commit against what was staged: valid names, known modes, every
/// texture staged, and no name twice in one dictionary. The dictionaries'
/// places are checked by the caller (validate_sibling_ytd).
pub fn check_commit(
    request: &CommitRequest,
    staged: &HashMap<String, PathBuf>,
) -> Result<(), String> {
    if !valid_stamp(&request.stamp) {
        return Err(format!("\"{}\" is not a backup stamp.", request.stamp));
    }
    if request.ytds.is_empty() || request.ytds.len() > MAX_DICTIONARIES {
        return Err("A livery write names 1 to 8 texture dictionaries.".into());
    }
    for ytd in &request.ytds {
        if ytd.textures.is_empty() || ytd.textures.len() > MAX_TEXTURES {
            return Err(format!(
                "{} lists no textures or too many.",
                ytd.path.display()
            ));
        }
        let mut names = HashSet::new();
        for texture in &ytd.textures {
            if !valid_texture_name(&texture.name) {
                return Err(format!("\"{}\" is not a texture name.", texture.name));
            }
            if !names.insert(texture.name.to_ascii_lowercase()) {
                return Err(format!(
                    "{} is written twice into {}.",
                    texture.name,
                    ytd.path.display()
                ));
            }
            match (texture.mode.as_str(), texture.like.as_deref()) {
                ("replace", None) | ("insert", None) => {}
                ("insert", Some(like)) => {
                    if !valid_texture_name(like) || like.eq_ignore_ascii_case(&texture.name) {
                        return Err(format!(
                            "\"{like}\" cannot be the texture {} is modelled on.",
                            texture.name
                        ));
                    }
                }
                ("replace", Some(_)) => {
                    return Err(format!(
                        "{} replaces a texture, so it is modelled on none.",
                        texture.name
                    ))
                }
                (other, _) => return Err(format!("Unknown texture write mode \"{other}\".")),
            }
            if !staged.contains_key(&texture.id) {
                return Err(format!("{} was never staged.", texture.name));
            }
        }
    }
    Ok(())
}

/// What a DDS header says about its texture.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct DdsInfo {
    pub width: u32,
    pub height: u32,
    pub levels: u32,
    pub format: String,
}

/// Size, mip count and pixel format from the start of a DDS file.
pub fn dds_info(bytes: &[u8]) -> Option<DdsInfo> {
    let word = |offset: usize| {
        bytes
            .get(offset..offset + 4)
            .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
    };
    if bytes.len() < 128 || bytes.get(..4) != Some(b"DDS ") || word(4)? != 124 {
        return None;
    }
    let flags = word(8)?;
    let height = word(12)?;
    let width = word(16)?;
    if width == 0 || height == 0 {
        return None;
    }
    let levels = if flags & 0x20000 != 0 {
        word(28)?.max(1)
    } else {
        1
    };
    let format = if word(80)? & 0x4 != 0 {
        let code = bytes.get(84..88)?;
        if code == b"DX10" {
            match word(128)? {
                71 | 72 => "DXT1".to_string(),
                74 | 75 => "DXT3".to_string(),
                77 | 78 => "DXT5".to_string(),
                80 | 81 => "BC4".to_string(),
                83 | 84 => "BC5".to_string(),
                98 | 99 => "BC7".to_string(),
                28 | 29 => "RGBA".to_string(),
                87 | 91 => "BGRA".to_string(),
                other => format!("DXGI {other}"),
            }
        } else {
            String::from_utf8_lossy(code).trim().to_string()
        }
    } else {
        match word(88)? {
            32 => "BGRA".to_string(),
            bits => format!("{bits}-bit"),
        }
    };
    Some(DdsInfo {
        width,
        height,
        levels,
        format,
    })
}

/// `dds_info` for a file, reading only its header.
pub fn read_dds_info(path: &Path) -> Option<DdsInfo> {
    use std::io::Read;
    let mut header = Vec::with_capacity(148);
    std::fs::File::open(path)
        .ok()?
        .take(148)
        .read_to_end(&mut header)
        .ok()?;
    dds_info(&header)
}

/// True for a legacy GTA V texture dictionary (RSC7 version 13), the only kind
/// the bridge rebuilds.
pub fn is_legacy_ytd(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header[..4] == b"RSC7"
        && u32::from_le_bytes([header[4], header[5], header[6], header[7]]) == 13
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
                "cortex-livery-write-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dds(width: u32, height: u32, mips: u32, code: &[u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0u8; 160];
        bytes[..4].copy_from_slice(b"DDS ");
        bytes[4..8].copy_from_slice(&124u32.to_le_bytes());
        bytes[8..12].copy_from_slice(&(0x1007u32 | 0x20000).to_le_bytes());
        bytes[12..16].copy_from_slice(&height.to_le_bytes());
        bytes[16..20].copy_from_slice(&width.to_le_bytes());
        bytes[28..32].copy_from_slice(&mips.to_le_bytes());
        bytes[80..84].copy_from_slice(&4u32.to_le_bytes());
        bytes[84..88].copy_from_slice(code);
        bytes
    }

    fn stage_body(header: &str, payload: &[u8]) -> Vec<u8> {
        let mut bytes = (header.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn dds_headers_give_size_mips_and_format() {
        assert_eq!(
            dds_info(&dds(2048, 1024, 12, b"DXT5")),
            Some(DdsInfo {
                width: 2048,
                height: 1024,
                levels: 12,
                format: "DXT5".into()
            })
        );
        let mut bc7 = dds(4096, 4096, 1, b"DX10");
        bc7[128..132].copy_from_slice(&98u32.to_le_bytes());
        assert_eq!(dds_info(&bc7).unwrap().format, "BC7");
        assert_eq!(dds_info(&dds(0, 4, 1, b"DXT1")), None);
        assert_eq!(dds_info(&dds(4, 4, 1, b"DXT1")[..100]), None);
        assert_eq!(dds_info(b"PNG"), None);
    }

    #[test]
    fn a_stage_body_carries_its_token_id_and_dds() {
        let texture = dds(4, 4, 1, b"DXT5");
        let body = stage_body(r#"{"token":"1-2","id":"a-0"}"#, &texture);
        let (token, id, bytes) = parse_stage(&body).unwrap();
        assert_eq!((token.as_str(), id.as_str()), ("1-2", "a-0"));
        assert_eq!(bytes, texture.as_slice());
        assert!(parse_stage(&stage_body(r#"{"token":"1-2","id":"a"}"#, b"not dds")).is_err());
        assert!(parse_stage(&stage_body("{", &texture)).is_err());
        assert!(parse_stage(&[9, 0, 0, 0, b'{']).is_err());
        assert!(parse_stage(&[1]).is_err());
    }

    #[test]
    fn a_session_stages_textures_and_hands_them_to_one_commit() {
        let fixture = Fixture::new();
        let state = LiveryWriteState::default();
        let token = state
            .begin(&fixture.0, PathBuf::from("C:/r/car.yft"))
            .unwrap();
        let texture = dds(4, 4, 1, b"DXT5");
        state.stage(&token, "a-0", &texture).unwrap();
        assert!(state.stage(&token, "a-0", &texture).is_err());
        assert!(state.stage(&token, "../x", &texture).is_err());
        assert!(state.stage("other", "b-0", &texture).is_err());

        let staged = state.take(&token).unwrap();
        assert_eq!(std::fs::read(&staged.files["a-0"]).unwrap(), texture);
        assert!(state.take(&token).is_err());
        assert!(state.stage(&token, "b-0", &texture).is_err());
        let dir = staged.dir.clone();
        drop(staged);
        assert!(!dir.exists());
    }

    #[test]
    fn a_new_session_drops_the_last_one_and_older_runs_leftovers() {
        let fixture = Fixture::new();
        // Process id 0 is never an app run's.
        let leftover = fixture.0.join("0-123");
        std::fs::create_dir(&leftover).unwrap();
        let state = LiveryWriteState::default();
        let first = state.begin(&fixture.0, PathBuf::from("a.yft")).unwrap();
        state.stage(&first, "x", &dds(4, 4, 1, b"DXT5")).unwrap();
        let first_dir = fixture.0.join(&first);
        let second = state.begin(&fixture.0, PathBuf::from("b.yft")).unwrap();
        assert!(!first_dir.exists());
        assert!(!leftover.exists());
        assert!(state.take(&first).is_err());
        state.cancel(&second);
        assert!(!fixture.0.join(&second).exists());
    }

    fn request(json: &str) -> CommitRequest {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_commit_names_only_staged_textures_once_per_dictionary() {
        let staged: HashMap<String, PathBuf> = [("a".to_string(), PathBuf::from("a.dds"))].into();
        let good = r#"{"token":"t","stamp":"20261016-101500","ytds":[{"path":"C:/r/car.ytd","textures":[{"name":"car_sign_5","mode":"insert","id":"a","like":"car_sign_1"}]}]}"#;
        assert!(check_commit(&request(good), &staged).is_ok());
        let bad = [
            good.replace("20261016-101500", "today"),
            good.replace("\"insert\"", "\"delete\""),
            good.replace("\"id\":\"a\"", "\"id\":\"b\""),
            good.replace("car_sign_5", "a/b"),
            good.replace("\"car_sign_1\"", "\"CAR_SIGN_5\""),
            good.replace("\"insert\"", "\"replace\""),
            good.replace(
                r#"[{"name":"car_sign_5","mode":"insert","id":"a","like":"car_sign_1"}]"#,
                r#"[{"name":"car_sign_5","mode":"replace","id":"a"},{"name":"CAR_SIGN_5","mode":"replace","id":"a"}]"#,
            ),
            good.replace(
                r#"[{"name":"car_sign_5","mode":"insert","id":"a","like":"car_sign_1"}]"#,
                "[]",
            ),
            r#"{"token":"t","stamp":"20261016-101500","ytds":[]}"#.to_string(),
        ];
        for json in bad {
            assert!(check_commit(&request(&json), &staged).is_err(), "{json}");
        }
        let replace = r#"{"token":"t","stamp":"20261016-101500","ytds":[{"path":"C:/r/car.ytd","textures":[{"name":"car_sign_1","mode":"replace","id":"a"}]}]}"#;
        assert!(check_commit(&request(replace), &staged).is_ok());
    }

    #[test]
    fn only_legacy_dictionaries_are_writable() {
        let fixture = Fixture::new();
        let legacy = fixture.0.join("legacy.ytd");
        std::fs::write(
            &legacy,
            [b"RSC7".as_slice(), &13u32.to_le_bytes(), &[0; 8]].concat(),
        )
        .unwrap();
        let enhanced = fixture.0.join("enhanced.ytd");
        std::fs::write(
            &enhanced,
            [b"RSC7".as_slice(), &5u32.to_le_bytes()].concat(),
        )
        .unwrap();
        assert!(is_legacy_ytd(&legacy));
        assert!(!is_legacy_ytd(&enhanced));
        assert!(!is_legacy_ytd(&fixture.0.join("missing.ytd")));
    }
}
