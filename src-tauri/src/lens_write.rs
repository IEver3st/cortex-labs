//! The lens colour write. The renderer sends the recoloured textures in one
//! raw IPC body; each target must be one of the model's own texture
//! dictionaries, and an added texture names the dictionary of the vehicle's
//! resource it was copied from (never another resource or the game files). The bridge rebuilds every dictionary into the app cache
//! first, and only when all of them built does this replace the user's files,
//! each after a stamped backup beside it, rolling back on a failed replace.

use std::path::{Path, PathBuf};

const MAX_DICTIONARIES: usize = 8;
const MAX_TEXTURES: usize = 64;
const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug)]
pub struct TextureWrite {
    pub name: String,
    pub mode: &'static str,
    pub dds: std::ops::Range<usize>,
    /// For "add": the dictionary the texture was copied from.
    pub source: Option<PathBuf>,
}

#[derive(Debug)]
pub struct DictionaryWrite {
    pub path: PathBuf,
    pub textures: Vec<TextureWrite>,
}

#[derive(Debug)]
pub struct WriteRequest {
    pub model: PathBuf,
    pub stamp: String,
    pub dictionaries: Vec<DictionaryWrite>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    model_path: String,
    stamp: String,
    ytds: Vec<HeaderYtd>,
}

#[derive(serde::Deserialize)]
struct HeaderYtd {
    path: String,
    textures: Vec<HeaderTexture>,
}

#[derive(serde::Deserialize)]
struct HeaderTexture {
    name: String,
    mode: String,
    length: usize,
    #[serde(default)]
    source: Option<String>,
}

/// A texture name as dictionaries store it: what the game looks up by hash.
pub(crate) fn valid_texture_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|char| char.is_ascii_graphic() && !matches!(char, '/' | '\\' | ':' | '"'))
}

/// `yyyymmdd-hhmmss`, as the vcf.lua backups use.
pub(crate) fn valid_stamp(stamp: &str) -> bool {
    let digits = |part: &str, count: usize| {
        part.len() == count && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    stamp
        .split_once('-')
        .is_some_and(|(date, time)| digits(date, 8) && digits(time, 6))
}

/// Body: a little-endian u32 header length, the UTF-8 JSON header
/// `{ modelPath, stamp, ytds: [{ path, textures: [{ name, mode, length, source? }] }] }`,
/// then every texture's DDS file back to back in header order. `source` is
/// required for "add" and refused for "replace".
pub fn parse_request(body: &[u8]) -> Result<WriteRequest, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("The lens write is too large.".into());
    }
    let length = body
        .get(..4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .ok_or("The lens write is empty.")?;
    let header_end = 4usize
        .checked_add(length)
        .filter(|end| *end <= body.len())
        .ok_or("The lens write header is truncated.")?;
    let header: Header = serde_json::from_slice(&body[4..header_end])
        .map_err(|error| format!("The lens write header is not valid: {error}"))?;
    if !valid_stamp(&header.stamp) {
        return Err(format!("\"{}\" is not a backup stamp.", header.stamp));
    }
    if header.ytds.is_empty() || header.ytds.len() > MAX_DICTIONARIES {
        return Err("A lens write names 1 to 8 texture dictionaries.".into());
    }
    let mut offset = header_end;
    let mut dictionaries = Vec::with_capacity(header.ytds.len());
    for ytd in header.ytds {
        if ytd.textures.is_empty() || ytd.textures.len() > MAX_TEXTURES {
            return Err(format!("{} lists no textures or too many.", ytd.path));
        }
        let mut textures = Vec::with_capacity(ytd.textures.len());
        for texture in ytd.textures {
            if !valid_texture_name(&texture.name) {
                return Err(format!("\"{}\" is not a texture name.", texture.name));
            }
            let mode = match texture.mode.as_str() {
                "replace" => "replace",
                "add" => "add",
                other => return Err(format!("Unknown texture write mode \"{other}\".")),
            };
            let source = match (mode, texture.source.filter(|path| !path.trim().is_empty())) {
                ("add", Some(path)) => Some(PathBuf::from(path)),
                ("add", None) => {
                    return Err(format!(
                        "{} is added without the dictionary it is copied from.",
                        texture.name
                    ))
                }
                (_, Some(_)) => {
                    return Err(format!(
                        "{} replaces a texture, so it names no source dictionary.",
                        texture.name
                    ))
                }
                (_, None) => None,
            };
            let end = offset
                .checked_add(texture.length)
                .filter(|end| *end <= body.len())
                .ok_or_else(|| format!("The data for {} is truncated.", texture.name))?;
            let dds = &body[offset..end];
            if dds.len() < 128 || &dds[..4] != b"DDS " {
                return Err(format!("The data for {} is not a DDS file.", texture.name));
            }
            textures.push(TextureWrite {
                name: texture.name,
                mode,
                dds: offset..end,
                source,
            });
            offset = end;
        }
        dictionaries.push(DictionaryWrite {
            path: PathBuf::from(ytd.path),
            textures,
        });
    }
    if offset != body.len() {
        return Err("The lens write has data no texture claims.".into());
    }
    Ok(WriteRequest {
        model: PathBuf::from(header.model_path),
        stamp: header.stamp,
        dictionaries,
    })
}

/// A file this write replaced and the backup of what it held.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub path: PathBuf,
    pub backup: PathBuf,
}

fn sibling_name(target: &Path, stamp: &str, suffix: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{} has no file name.", target.display()))?;
    Ok(target.with_file_name(format!("{name}.{stamp}.{suffix}")))
}

pub(crate) fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
    // create_new also refuses a (dangling) link at the name.
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    let copied =
        std::fs::File::open(from).and_then(|mut source| std::io::copy(&mut source, &mut target));
    drop(target);
    if copied.is_err() {
        let _ = std::fs::remove_file(to);
    }
    copied.map(|_| ())
}

/// Puts `from` at `target` in one rename from a copy beside it, so a reader
/// sees the old file or the new one, never a partial one.
fn replace_from(target: &Path, from: &Path, staged: &Path) -> std::io::Result<()> {
    copy_new(from, staged)?;
    std::fs::rename(staged, target).inspect_err(|_| {
        let _ = std::fs::remove_file(staged);
    })
}

/// Replaces each target with its built file, after copying the target to
/// `<name>.<stamp>.bak` beside it. All or nothing: when one fails the earlier
/// ones are put back from their backups, and the message says which could not be.
pub fn replace_with_backups(
    targets: &[(PathBuf, PathBuf)],
    stamp: &str,
) -> Result<Vec<Replaced>, String> {
    let mut planned = Vec::with_capacity(targets.len());
    for (target, built) in targets {
        let backup = sibling_name(target, stamp, "bak")?;
        let staged = sibling_name(target, stamp, "new")?;
        for path in [&backup, &staged] {
            if std::fs::symlink_metadata(path).is_ok() {
                return Err(format!("{} already exists.", path.display()));
            }
        }
        planned.push((target, built, backup, staged));
    }
    let mut done: Vec<&(&PathBuf, &PathBuf, PathBuf, PathBuf)> = Vec::new();
    for step in &planned {
        let (target, built, backup, staged) = step;
        let failure = match copy_new(target, backup) {
            Err(error) => Some(format!("Could not back up {}: {error}.", target.display())),
            Ok(()) => replace_from(target, built, staged).err().map(|error| {
                let _ = std::fs::remove_file(backup);
                format!("Could not replace {}: {error}.", target.display())
            }),
        };
        let Some(mut message) = failure else {
            done.push(step);
            continue;
        };
        let mut stranded = Vec::new();
        for (earlier, _, earlier_backup, earlier_staged) in done.iter().rev() {
            match replace_from(earlier, earlier_backup, earlier_staged) {
                Ok(()) => {
                    let _ = std::fs::remove_file(earlier_backup);
                }
                Err(error) => stranded.push(format!(
                    "{} still holds the new textures; its original is {} ({error})",
                    earlier.display(),
                    earlier_backup.display()
                )),
            }
        }
        if done.is_empty() {
            message.push_str(" Nothing was changed.");
        } else if stranded.is_empty() {
            message.push_str(" The files already written were put back.");
        } else {
            message.push_str(" Putting the earlier files back also failed: ");
            message.push_str(&stranded.join("; "));
            message.push('.');
        }
        return Err(message);
    }
    Ok(planned
        .into_iter()
        .map(|(target, _, backup, _)| Replaced {
            path: target.clone(),
            backup,
        })
        .collect())
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
                "cortex-lens-write-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn body(header: &str, payload: &[u8]) -> Vec<u8> {
        let mut bytes = (header.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn dds(fill: u8) -> Vec<u8> {
        let mut bytes = vec![fill; 160];
        bytes[..4].copy_from_slice(b"DDS ");
        bytes
    }

    #[test]
    fn a_request_names_its_textures_and_their_bytes() {
        let header = r#"{"modelPath":"C:/r/car_hi.yft","stamp":"20261015-153012","ytds":[{"path":"C:/r/car+hi.ytd","textures":[{"name":"nForce_Emis","mode":"add","length":160,"source":"C:/r/pack.ytd"},{"name":"lens","mode":"replace","length":160}]}]}"#;
        let mut payload = dds(1);
        payload.extend(dds(2));
        let bytes = body(header, &payload);
        let request = parse_request(&bytes).unwrap();
        assert_eq!(request.model, PathBuf::from("C:/r/car_hi.yft"));
        let textures = &request.dictionaries[0].textures;
        assert_eq!(textures[0].name, "nForce_Emis");
        assert_eq!(textures[0].mode, "add");
        assert_eq!(textures[0].source, Some(PathBuf::from("C:/r/pack.ytd")));
        assert_eq!(textures[1].source, None);
        assert_eq!(bytes[textures[1].dds.clone()][4], 2);
        assert_eq!(textures[1].dds.end, bytes.len());
    }

    #[test]
    fn malformed_requests_are_refused() {
        let good = r#"{"modelPath":"m.yft","stamp":"20261015-153012","ytds":[{"path":"a.ytd","textures":[{"name":"t","mode":"add","length":160,"source":"p.ytd"}]}]}"#;
        assert!(parse_request(&body(good, &dds(0))).is_ok());
        let cases: Vec<(String, Vec<u8>)> = vec![
            (good.into(), dds(0)[..100].to_vec()),
            (good.into(), [dds(0), vec![0]].concat()),
            (good.into(), vec![0; 160]),
            (good.replace("20261015-153012", "../x"), dds(0)),
            (good.replace("\"add\"", "\"delete\""), dds(0)),
            (good.replace("\"t\"", "\"a/b\""), dds(0)),
            (good.replace("\"t\"", "\"\""), dds(0)),
            // An added texture must say where it was copied from; a replaced one must not.
            (good.replace(",\"source\":\"p.ytd\"", ""), dds(0)),
            (good.replace("\"p.ytd\"", "\" \""), dds(0)),
            (good.replace("\"add\"", "\"replace\""), dds(0)),
            (
                good.replace(
                    "[{\"name\":\"t\",\"mode\":\"add\",\"length\":160,\"source\":\"p.ytd\"}]",
                    "[]",
                ),
                vec![],
            ),
            ("{".into(), vec![]),
        ];
        for (header, payload) in cases {
            assert!(parse_request(&body(&header, &payload)).is_err(), "{header}");
        }
        assert!(parse_request(&[1, 0]).is_err());
        assert!(parse_request(&[255, 255, 255, 0, b'{']).is_err());
    }

    #[test]
    fn replacing_keeps_a_stamped_backup_of_each_file() {
        let fixture = Fixture::new();
        let a = fixture.file("car.ytd", b"old a");
        let b = fixture.file("car+hi.ytd", b"old b");
        let new_a = fixture.file("built-a", b"new a");
        let new_b = fixture.file("built-b", b"new b");
        let replaced =
            replace_with_backups(&[(a.clone(), new_a), (b.clone(), new_b)], "20261015-153012")
                .unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), b"new a");
        assert_eq!(std::fs::read(&b).unwrap(), b"new b");
        assert_eq!(
            replaced[0].backup,
            fixture.0.join("car.ytd.20261015-153012.bak")
        );
        assert_eq!(std::fs::read(&replaced[0].backup).unwrap(), b"old a");
        assert_eq!(std::fs::read(&replaced[1].backup).unwrap(), b"old b");
        assert!(!fixture.0.join("car.ytd.20261015-153012.new").exists());
    }

    #[test]
    fn an_existing_backup_name_stops_the_write_before_any_change() {
        let fixture = Fixture::new();
        let a = fixture.file("car.ytd", b"old a");
        fixture.file("car.ytd.20261015-153012.bak", b"earlier");
        let built = fixture.file("built", b"new");
        let error = replace_with_backups(&[(a.clone(), built)], "20261015-153012").unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(std::fs::read(&a).unwrap(), b"old a");
        assert_eq!(
            std::fs::read(fixture.0.join("car.ytd.20261015-153012.bak")).unwrap(),
            b"earlier"
        );
    }

    #[test]
    fn a_failed_replace_puts_the_earlier_files_back() {
        let fixture = Fixture::new();
        let a = fixture.file("car.ytd", b"old a");
        let b = fixture.file("car+hi.ytd", b"old b");
        let new_a = fixture.file("built-a", b"new a");
        let missing = fixture.0.join("built-b-missing");
        let error = replace_with_backups(
            &[(a.clone(), new_a), (b.clone(), missing)],
            "20261015-153012",
        )
        .unwrap_err();
        assert!(error.starts_with("Could not replace"), "{error}");
        assert!(error.ends_with("were put back."), "{error}");
        assert_eq!(std::fs::read(&a).unwrap(), b"old a");
        assert_eq!(std::fs::read(&b).unwrap(), b"old b");
        let leftovers: Vec<_> = std::fs::read_dir(&fixture.0)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("20261015-153012"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
