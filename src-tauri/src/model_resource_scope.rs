use std::path::{Path, PathBuf};

use tauri_plugin_fs::FsExt;

fn resource_root(model: &Path) -> Result<PathBuf, String> {
    if !model
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("yft")
                || value.eq_ignore_ascii_case("ydd")
                || value.eq_ignore_ascii_case("clmesh")
        })
    {
        return Err("Resource access requires a .yft, .ydd or .clmesh model.".into());
    }
    let model = model
        .canonicalize()
        .map_err(|error| format!("Cannot access model {}: {error}", model.display()))?;
    if !model.is_file() {
        return Err("Resource access requires a model file.".into());
    }
    let directory = model.parent().ok_or("Model has no parent directory.")?;
    if directory.parent().is_none() {
        return Err("Move the model into a resource folder to scan its metadata.".into());
    }

    // Match the metadata scanner's bounded ancestor search. Never grant a
    // drive root or the resources container just to reach a selected file.
    for candidate in directory.ancestors().take(5) {
        if candidate.parent().is_none() {
            break;
        }
        if let Ok(entries) = std::fs::read_dir(candidate) {
            if entries.flatten().any(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                (name.eq_ignore_ascii_case("fxmanifest.lua")
                    || name.eq_ignore_ascii_case("__resource.lua"))
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
            }) {
                return Ok(candidate.to_path_buf());
            }
        }
    }
    if let Some(parent) = directory
        .parent()
        .filter(|parent| parent.parent().is_some())
    {
        if let Ok(entries) = std::fs::read_dir(parent) {
            if entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("data")
                    && entry.file_type().is_ok_and(|kind| kind.is_dir())
            }) {
                return Ok(parent.to_path_buf());
            }
        }
    }
    Ok(directory.to_path_buf())
}

pub fn allow<R: tauri::Runtime>(app: &tauri::AppHandle<R>, model: &Path) -> Result<(), String> {
    let root = resource_root(model)?;
    // The file picker allows only the selected model. Metadata and nearby
    // YTD discovery also need its resource directories, including other drives.
    // This API escapes literal brackets in FiveM folder names such as [extras].
    app.fs_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("Cannot read model resource {}: {error}", root.display()))
}

/// The model resource's `<dict>.ycd`, searching the model's folder first.
/// Add-on convertibles stream their roof dictionary inside the resource; when
/// it is absent the caller falls back to the game files. `dict` must already be
/// a validated identifier, never a path.
pub fn find_animation_dictionary(model: &Path, dict: &str) -> Result<Option<PathBuf>, String> {
    const MAX_DEPTH: usize = 6;
    const MAX_ENTRIES: usize = 20_000;
    let root = resource_root(model)?;
    let wanted = format!("{dict}.ycd");
    let model_dir = model
        .canonicalize()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .ok_or("Model has no parent directory.")?;
    let mut queue = std::collections::VecDeque::from([(model_dir.clone(), 0usize)]);
    if root != model_dir {
        queue.push_back((root.clone(), 0));
    }
    let mut seen = 0usize;
    while let Some((directory, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return Ok(None);
            }
            // file_type does not follow links, so a linked folder cannot lead outside the resource.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH && path != model_dir {
                    queue.push_back((path, depth + 1));
                }
            } else if kind.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&wanted)
            {
                let path = path
                    .canonicalize()
                    .map_err(|error| format!("Cannot access {}: {error}", path.display()))?;
                if path.starts_with(&root) {
                    return Ok(Some(path));
                }
            }
        }
    }
    Ok(None)
}

pub fn validate_meta_file(model: &Path, file: &Path) -> Result<(), String> {
    let root = resource_root(model)?;
    let target = file
        .canonicalize()
        .map_err(|error| format!("Cannot access metadata file {}: {error}", file.display()))?;
    if !target.is_file()
        || !target
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("meta"))
    {
        return Err("Only metadata files can be opened from the Meta panel.".into());
    }
    if !target.starts_with(root) {
        return Err("Metadata file is outside the selected model's resource.".into());
    }
    Ok(())
}

/// The texture dictionaries a model pairs with, as the bridge reads them
/// (EnumerateSiblingYtdPaths): `x_hi.yft` uses `x_hi.ytd`, `x+hi.ytd` and `x.ytd`.
fn sibling_ytd_names(stem: &str) -> Vec<String> {
    let lower = stem.to_ascii_lowercase();
    // The suffixes are ASCII, so cutting three bytes stays on a char boundary.
    let stripped = &stem[..stem.len().saturating_sub(3)];
    if lower.ends_with("_hi") {
        vec![
            format!("{stem}.ytd"),
            format!("{stripped}+hi.ytd"),
            format!("{stripped}.ytd"),
        ]
    } else if lower.ends_with("+hi") {
        vec![
            format!("{stem}.ytd"),
            format!("{stripped}_hi.ytd"),
            format!("{stripped}.ytd"),
        ]
    } else {
        vec![format!("{stem}.ytd"), format!("{stem}+hi.ytd")]
    }
}

/// The model's own texture dictionaries that exist: regular files beside the
/// `.yft`, in the order the bridge reads them.
pub fn model_sibling_ytds(model: &Path) -> Vec<PathBuf> {
    let Some(stem) = model.file_stem().and_then(|value| value.to_str()) else {
        return Vec::new();
    };
    sibling_ytd_names(stem)
        .into_iter()
        .map(|name| model.with_file_name(name))
        .filter(|path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()))
        .collect()
}

/// Checks that `ytd` is one of the model's own texture dictionaries: a regular
/// file beside the `.yft`, named as the bridge pairs them. Pack-wide and game
/// dictionaries are never write targets.
pub fn validate_sibling_ytd(model: &Path, ytd: &Path) -> Result<(), String> {
    let source = model
        .canonicalize()
        .map_err(|error| format!("Cannot access model {}: {error}", model.display()))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|_| {
            source.is_file()
                && source
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("yft"))
        })
        .ok_or("Textures are written only for a .yft model.")?;
    let regular = std::fs::symlink_metadata(ytd).is_ok_and(|meta| meta.is_file());
    let target = ytd
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", ytd.display()))?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !regular
        || target.parent() != source.parent()
        || !sibling_ytd_names(stem)
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
    {
        return Err(format!(
            "{} is not one of the model's own texture dictionaries.",
            ytd.display()
        ));
    }
    Ok(())
}

/// Checks that `source`, the dictionary a lens texture is copied from, is a
/// regular `.ytd` in the model's own resource: under the nearest folder above
/// the model with `fxmanifest.lua` or `__resource.lua`, or beside the model when
/// there is none, as the bridge looks for pack dictionaries. Lens writes never
/// copy a texture from another resource or the game files, and never from a
/// dictionary they write.
/// Returns the resolved path, which is the one to read: the check holds for
/// where links lead, not for the name that was sent.
pub fn validate_lens_copy_source(model: &Path, source: &Path) -> Result<PathBuf, String> {
    let model = model
        .canonicalize()
        .map_err(|error| format!("Cannot access model {}: {error}", model.display()))?;
    let folder = model
        .parent()
        .ok_or("The model has no folder.")?
        .to_path_buf();
    let path = source
        .canonicalize()
        .map_err(|error| format!("Cannot access {}: {error}", source.display()))?;
    let is_ytd = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("ytd"));
    if !path.is_file() || !is_ytd {
        return Err(format!("{} is not a texture dictionary.", source.display()));
    }
    let root = folder
        .ancestors()
        .find(|dir| dir.join("fxmanifest.lua").is_file() || dir.join("__resource.lua").is_file());
    let inside = match root {
        Some(root) => path.starts_with(root),
        None => path.parent() == Some(folder.as_path()),
    };
    if !inside {
        return Err(format!(
            "{} is outside this vehicle's resource, so its textures are not copied into the vehicle.",
            source.display()
        ));
    }
    if validate_sibling_ytd(&model, &path).is_ok() {
        return Err(format!(
            "{} is one of the vehicle's own dictionaries, so nothing is copied from it.",
            source.display()
        ));
    }
    Ok(path)
}

fn valid_stream_name(name: &str, extension: &str) -> bool {
    let candidate = Path::new(name);
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '+' | '-' | '.'))
        && !name.starts_with('.')
        && candidate.file_name().and_then(|value| value.to_str()) == Some(name)
        && candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

/// A failed stream rename. `rolled_back` is true when no file is left under a
/// new name (nothing was renamed, or every earlier rename was undone).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFailure {
    pub message: String,
    pub rolled_back: bool,
}

impl From<String> for RenameFailure {
    /// A failure before any file was touched.
    fn from(message: String) -> Self {
        Self {
            message,
            rolled_back: true,
        }
    }
}

/// Renames a vehicle's stream files for the vehicle renamer. Each source must
/// be a `.yft` or `.ytd` file inside the selected model's resource; each new
/// name stays in its source's folder, keeps its extension, and must not exist.
/// All or nothing: a failed rename puts the earlier ones back, and the error
/// says which files, if any, could not be put back. Returns the new paths,
/// built from the given (non-canonical) source paths.
pub fn rename_stream_files(
    model: &Path,
    renames: &[(PathBuf, String)],
) -> Result<Vec<PathBuf>, RenameFailure> {
    let root = resource_root(model)?;
    let mut planned: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::with_capacity(renames.len());
    for (from, name) in renames {
        let source = from
            .canonicalize()
            .map_err(|error| format!("Cannot access {}: {error}", from.display()))?;
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| value.eq_ignore_ascii_case("yft") || value.eq_ignore_ascii_case("ytd"))
            .ok_or_else(|| {
                format!(
                    "Only .yft and .ytd files can be renamed: {}",
                    from.display()
                )
            })?;
        if !source.is_file() || !source.starts_with(&root) {
            return Err(
                format!("{} is not a file in the model's resource.", from.display()).into(),
            );
        }
        if !valid_stream_name(name, extension) {
            return Err(
                format!("\"{name}\" is not a valid new name for {}.", from.display()).into(),
            );
        }
        let target = source.with_file_name(name);
        if std::fs::symlink_metadata(&target).is_ok()
            || planned.iter().any(|(_, other, _)| other == &target)
        {
            return Err(format!("{} already exists.", target.display()).into());
        }
        planned.push((source, target, from.with_file_name(name)));
    }
    let mut done: Vec<(&PathBuf, &PathBuf)> = Vec::new();
    for (source, target, _) in &planned {
        if let Err(error) = std::fs::rename(source, target) {
            let mut message = format!("Could not rename {}: {error}.", source.display());
            let mut stranded = Vec::new();
            for (back_source, back_target) in done.iter().rev() {
                if let Err(undo) = std::fs::rename(back_target, back_source) {
                    stranded.push(format!(
                        "{} is still named {} ({undo})",
                        back_source.display(),
                        back_target.display()
                    ));
                }
            }
            if !stranded.is_empty() {
                message.push_str(" Putting the earlier renames back also failed: ");
                message.push_str(&stranded.join("; "));
                message.push('.');
            }
            return Err(RenameFailure {
                message,
                rolled_back: stranded.is_empty(),
            });
        }
        done.push((source, target));
    }
    Ok(planned.into_iter().map(|(_, _, shown)| shown).collect())
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
                "cortex-resource-scope-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, path: &str) -> PathBuf {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"").unwrap();
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

    #[test]
    fn selected_file_gains_its_resource_without_allowing_other_resources() {
        let fixture = Fixture::new();
        let model = fixture.file("resources/[extras]/Gator/stream/Gator_hi.yft");
        fixture.file("resources/[extras]/Gator/fxmanifest.lua");
        let meta = fixture.file("resources/[extras]/Gator/data/vehicles.meta");
        let ytd = fixture.file("resources/[extras]/Gator/stream/Gator.ytd");
        let other = fixture.file("resources/[extras]/Other/data/vehicles.meta");
        let app = app();
        let scope = app.fs_scope();
        scope.allow_file(&model).unwrap();
        assert!(scope.is_allowed(&model));
        assert!(!scope.is_allowed(model.parent().unwrap()));
        assert!(!scope.is_allowed(&meta));

        allow(app.handle(), &model).unwrap();
        assert!(scope.is_allowed(model.parent().unwrap()));
        assert!(scope.is_allowed(meta.parent().unwrap()));
        assert!(scope.is_allowed(&meta));
        assert!(scope.is_allowed(&ytd));
        assert!(!scope.is_allowed(&other));
        assert!(!scope.is_allowed(fixture.0.join("resources")));
    }

    #[test]
    fn nearest_resource_wins_and_legacy_manifests_are_supported() {
        let fixture = Fixture::new();
        fixture.file("fxmanifest.lua");
        fixture.file("nested/__resource.lua");
        let model = fixture.file("nested/stream/model.yft");
        assert_eq!(
            resource_root(&model).unwrap(),
            fixture.0.join("nested").canonicalize().unwrap()
        );
    }

    #[test]
    fn unmarked_resources_use_data_or_only_the_model_directory() {
        let fixture = Fixture::new();
        fixture.file("pack/data/vehicles.meta");
        let model = fixture.file("pack/stream/model.yft");
        assert_eq!(
            resource_root(&model).unwrap(),
            fixture.0.join("pack").canonicalize().unwrap()
        );
        let standalone = fixture.file("standalone/model.clmesh");
        assert_eq!(
            resource_root(&standalone).unwrap(),
            standalone.parent().unwrap().canonicalize().unwrap()
        );
    }

    #[test]
    fn invalid_inputs_do_not_expand_scope() {
        let fixture = Fixture::new();
        let text = fixture.file("notes.txt");
        let directory = fixture.0.join("folder.yft");
        std::fs::create_dir(&directory).unwrap();
        let app = app();
        for path in [&text, &directory, &fixture.0.join("missing.yft")] {
            assert!(allow(app.handle(), path).is_err());
        }
        assert!(!app.fs_scope().is_allowed(&text));
    }

    #[test]
    fn metadata_open_accepts_only_files_in_the_models_resource() {
        let fixture = Fixture::new();
        let model = fixture.file("resources/[extras]/Gator/stream/Gator_hi.yft");
        fixture.file("resources/[extras]/Gator/fxmanifest.lua");
        let meta = fixture.file("resources/[extras]/Gator/data/vehicles.META");
        let other = fixture.file("resources/[extras]/Gator-other/data/vehicles.meta");
        assert!(validate_meta_file(&model, &meta).is_ok());
        assert!(validate_meta_file(&model, &other).is_err());
        let traversal = meta
            .parent()
            .unwrap()
            .join("../../Gator-other/data/vehicles.meta");
        assert_eq!(
            traversal.canonicalize().unwrap(),
            other.canonicalize().unwrap()
        );
        assert!(validate_meta_file(&model, &traversal).is_err());
    }

    #[test]
    fn animation_dictionaries_resolve_inside_the_models_resource_only() {
        let fixture = Fixture::new();
        fixture.file("resources/Cabrio/fxmanifest.lua");
        let model = fixture.file("resources/Cabrio/stream/cabrio/cabrio.yft");
        let shared = fixture.file("resources/Cabrio/stream/anims/VA_Cabrio.ycd");
        fixture.file("resources/Other/stream/va_other.ycd");
        assert_eq!(
            find_animation_dictionary(&model, "va_cabrio").unwrap(),
            Some(shared.canonicalize().unwrap())
        );
        assert_eq!(find_animation_dictionary(&model, "va_other").unwrap(), None);
        assert_eq!(
            find_animation_dictionary(&model, "va_missing").unwrap(),
            None
        );

        let beside = fixture.file("resources/Cabrio/stream/cabrio/va_cabrio.ycd");
        assert_eq!(
            find_animation_dictionary(&model, "va_cabrio").unwrap(),
            Some(beside.canonicalize().unwrap()),
            "the model's own folder wins"
        );
    }

    #[test]
    fn metadata_open_rejects_non_meta_files_directories_and_missing_files() {
        let fixture = Fixture::new();
        fixture.file("pack/fxmanifest.lua");
        let model = fixture.file("pack/stream/model.yft");
        let text = fixture.file("pack/data/notes.txt");
        let folder = fixture.0.join("pack/data/folder.meta");
        std::fs::create_dir(&folder).unwrap();
        for path in [&text, &folder, &fixture.0.join("pack/data/missing.meta")] {
            assert!(validate_meta_file(&model, path).is_err());
        }
    }
    #[test]
    fn stream_renames_stay_in_the_resource_and_never_overwrite() {
        let fixture = Fixture::new();
        fixture.file("res/fxmanifest.lua");
        let model = fixture.file("res/stream/fpiu25_hi.yft");
        let ytd = fixture.file("res/stream/fpiu25.ytd");
        let outside = fixture.file("other/fpiu25.ytd");
        let meta = fixture.file("res/data/vehicles.meta");

        let renamed = rename_stream_files(
            &model,
            &[
                (model.clone(), "pd_fpiu_hi.yft".into()),
                (ytd.clone(), "pd_fpiu.ytd".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            renamed,
            vec![
                model.with_file_name("pd_fpiu_hi.yft"),
                ytd.with_file_name("pd_fpiu.ytd")
            ]
        );
        assert!(!model.exists() && renamed[0].is_file() && renamed[1].is_file());

        let model = renamed[0].clone();
        let taken = fixture.file("res/stream/taken.ytd");
        for (from, name) in [
            (outside.clone(), "x.ytd"),
            (meta.clone(), "x.meta"),
            (renamed[1].clone(), "taken.ytd"),
            (renamed[1].clone(), "../escape.ytd"),
            (renamed[1].clone(), "x.yft"),
            (renamed[1].clone(), ""),
        ] {
            assert!(
                rename_stream_files(&model, &[(from, name.into())]).is_err(),
                "{name}"
            );
        }
        assert!(taken.is_file() && renamed[1].is_file() && outside.is_file());
        // Two sources may not land on one name.
        let second = fixture.file("res/stream/b.ytd");
        assert!(rename_stream_files(
            &model,
            &[
                (renamed[1].clone(), "same.ytd".into()),
                (second.clone(), "same.ytd".into())
            ]
        )
        .is_err());
        assert!(second.is_file());
    }

    #[test]
    fn lens_writes_target_only_the_models_own_dictionaries() {
        let fixture = Fixture::new();
        fixture.file("pack/fxmanifest.lua");
        let model = fixture.file("pack/stream/car/Car_hi.yft");
        let low = fixture.file("pack/stream/car/car.ytd");
        let high = fixture.file("pack/stream/car/CAR+hi.ytd");
        let own = fixture.file("pack/stream/car/car_hi.ytd");
        let shared = fixture.file("pack/stream/pack.ytd");
        let other = fixture.file("pack/stream/car/other.ytd");
        let moved = fixture.file("pack/stream/car.ytd");
        for ytd in [&low, &high, &own] {
            assert!(
                validate_sibling_ytd(&model, ytd).is_ok(),
                "{}",
                ytd.display()
            );
        }
        for ytd in [
            &shared,
            &other,
            &moved,
            &fixture.0.join("pack/stream/car/missing.ytd"),
        ] {
            assert!(
                validate_sibling_ytd(&model, ytd).is_err(),
                "{}",
                ytd.display()
            );
        }
        let folder = fixture.0.join("pack/stream/car/car+hi2.ytd");
        std::fs::create_dir(&folder).unwrap();
        assert!(validate_sibling_ytd(&model, &folder).is_err());
        assert!(
            validate_sibling_ytd(&low, &high).is_err(),
            "the model must be a .yft"
        );

        let plain = fixture.file("pack/stream/van/van.yft");
        let plain_high = fixture.file("pack/stream/van/van+hi.ytd");
        assert!(validate_sibling_ytd(&plain, &plain_high).is_ok());
        assert_eq!(
            sibling_ytd_names("car+hi"),
            ["car+hi.ytd", "car_hi.ytd", "car.ytd"]
        );
    }

    #[test]
    fn lens_copies_come_only_from_the_vehicles_own_resource() {
        let fixture = Fixture::new();
        fixture.file("pack/fxmanifest.lua");
        let model = fixture.file("pack/stream/car/car_hi.yft");
        let own = fixture.file("pack/stream/car/car.ytd");
        let shared = fixture.file("pack/stream/pack.ytd");
        let nested = fixture.file("pack/stream/lights/bar.ytd");
        fixture.file("other/fxmanifest.lua");
        let other = fixture.file("other/stream/pack.ytd");
        let neighbour = fixture.file("pack2/stream/pack.ytd");
        let loose = fixture.file("pack.ytd");
        let model_file = fixture.file("pack/stream/pack.ydr");
        let folder = fixture.0.join("pack/stream/folder.ytd");
        std::fs::create_dir_all(&folder).unwrap();
        let upper = fixture.0.join("pack/STREAM/PACK.YTD");
        for source in [&shared, &nested, &upper] {
            let resolved = validate_lens_copy_source(&model, source)
                .unwrap_or_else(|error| panic!("{}: {error}", source.display()));
            assert_eq!(resolved, source.canonicalize().unwrap());
        }
        for source in [
            &other,
            &neighbour,
            &loose,
            &own,
            &model_file,
            &folder,
            &fixture.0.join("pack/stream/missing.ytd"),
            &fixture.0.join("pack/stream/../../other/stream/pack.ytd"),
        ] {
            assert!(
                validate_lens_copy_source(&model, source).is_err(),
                "{}",
                source.display()
            );
        }

        // Without a resource manifest only the model's own folder counts.
        let van = fixture.file("loose/van/van.yft");
        let beside = fixture.file("loose/van/vanpack.ytd");
        let above = fixture.file("loose/vanpack.ytd");
        assert!(validate_lens_copy_source(&van, &beside).is_ok());
        assert!(validate_lens_copy_source(&van, &above).is_err());
    }

    #[test]
    fn rejected_renames_report_that_nothing_changed() {
        let fixture = Fixture::new();
        fixture.file("res/fxmanifest.lua");
        let model = fixture.file("res/stream/car.yft");
        let failure = rename_stream_files(&model, &[(model.clone(), "../x.yft".into())])
            .expect_err("invalid name");
        assert!(failure.rolled_back);
        assert!(model.is_file());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_failed_rename_undoes_the_earlier_ones() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        fixture.file("res/fxmanifest.lua");
        let model = fixture.file("res/stream/car.yft");
        let ytd = fixture.file("res/stream/car.ytd");
        // An open handle without FILE_SHARE_DELETE blocks the second rename.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&ytd)
            .unwrap();
        let failure = rename_stream_files(
            &model,
            &[
                (model.clone(), "new.yft".into()),
                (ytd.clone(), "new.ytd".into()),
            ],
        )
        .expect_err("locked source");
        drop(lock);
        assert!(
            failure.message.starts_with("Could not rename"),
            "{}",
            failure.message
        );
        assert!(failure.rolled_back, "{}", failure.message);
        assert!(model.is_file() && ytd.is_file());
        assert!(!model.with_file_name("new.yft").exists());
    }
}
