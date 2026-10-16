//! Base-game vehicles for Photo Mode. Props, peds and animations reuse the
//! existing game asset commands; vehicles need their own catalogue because a
//! vehicle is defined by vehicles.meta, not by a file name.

use super::{app_cache_root, bridge_request, BRIDGE_HEAVY_REQUEST_TIMEOUT};

/// Every vehicle the installed game defines: `{ vehicles: [{ name, gameName,
/// make, vehicleClass, type, pack }], total }`.
#[tauri::command]
pub async fn list_game_vehicles(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bridge_request(
            &app,
            "listGameVehicles",
            serde_json::json!({}),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join vehicle listing task: {e}"))?
}

/// Extracts a game vehicle into `vehicle-cache/<name>/` (a minimal resource:
/// fxmanifest.lua, data/vehicles.meta, stream/) and returns `{ path, name,
/// rpfPath }` where `path` is the fragment to pass to `parse_yft`.
#[tauri::command]
pub async fn export_game_vehicle(
    name: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = validate_model_name(&name)?;
        let output_dir = app_cache_root(&app, "vehicle-cache")?;
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create vehicle cache dir: {e}"))?;
        bridge_request(
            &app,
            "exportGameVehicle",
            serde_json::json!({
                "name": name,
                "outputDir": output_dir.to_string_lossy().to_string(),
            }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join vehicle export task: {e}"))?
}

/// Extracts the models a game vehicle's mod kits use into its
/// `vehicle-cache/<name>/stream/mods/` folder and returns `{ name, kits,
/// models, written, reused, missing }`. Run on request: a tuner car's kit can
/// be tens of megabytes.
#[tauri::command]
pub async fn export_game_vehicle_mods(
    name: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = validate_model_name(&name)?;
        let output_dir = app_cache_root(&app, "vehicle-cache")?;
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create vehicle cache dir: {e}"))?;
        bridge_request(
            &app,
            "exportGameVehicleMods",
            serde_json::json!({
                "name": name,
                "outputDir": output_dir.to_string_lossy().to_string(),
            }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join vehicle mod export task: {e}"))?
}

/// The game's English text for label hashes (joaat of the label key):
/// `{ texts: { "<hash>": "text" } }`. Mod kit labels such as `SULTAN_WING4`
/// resolve to the names the game shows.
#[tauri::command]
pub async fn lookup_game_text(
    hashes: Vec<u32>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if hashes.len() > MAX_TEXT_LOOKUPS {
        return Err(format!(
            "At most {MAX_TEXT_LOOKUPS} labels can be looked up at once."
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        bridge_request(
            &app,
            "lookupGameText",
            serde_json::json!({ "hashes": hashes }),
            BRIDGE_HEAVY_REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|e| format!("Failed to join game text task: {e}"))?
}

const MAX_TEXT_LOOKUPS: usize = 2048;

/// Game model names are identifiers, never paths.
fn validate_model_name(value: &str) -> Result<String, String> {
    let name = value.trim().to_ascii_lowercase();
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-');
    if name.is_empty() || name.len() > 128 || !name.chars().all(allowed) {
        return Err("Vehicle name must be 1-128 characters of a-z, 0-9, _, -.".to_string());
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::validate_model_name;

    #[test]
    fn accepts_game_identifiers() {
        assert_eq!(validate_model_name(" Adder ").unwrap(), "adder");
        assert_eq!(validate_model_name("police3").unwrap(), "police3");
    }

    #[test]
    fn rejects_paths_and_empty_names() {
        assert!(validate_model_name("").is_err());
        assert!(validate_model_name("../adder").is_err());
        assert!(validate_model_name("a\\b").is_err());
        assert!(validate_model_name("c:adder").is_err());
    }
}
