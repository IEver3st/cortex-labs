use reqwest::blocking::Client;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const DEFAULT_GATEWAY: &str = "https://api.cortexsoftware.net";
const GATEWAY_ENV: &str = "CORTEX_GATEWAY_URL";
const VAULT_SERVICE: &str = "Cortex Studio Juno";
const TOKEN_KEY: &str = "token";
const DEVICE_KEY: &str = "device";
const PENDING_KEY: &str = "pending-revoke";
const DEVICE_NAME: &str = "Cortex Studio";
const CLIENT: &str = "studio";
const SIREN_ACTION: &str = "siren-pattern";
pub const STUDIO_LIMIT_CODE: &str = "client_daily_limit";
const MAX_ASK_CHARS: usize = 700;
const MAX_ROWS: usize = 32;
const MAX_VEHICLE_CHARS: usize = 380;
const MAX_SETTING_CHARS: usize = 100;
const MAX_POSITIONS_CHARS: usize = 1000;
const MAX_PENDING: usize = 8;
const SHORT: Duration = Duration::from_secs(20);
const REVOKE: Duration = Duration::from_secs(6);
const ACTION: Duration = Duration::from_secs(120);

const SIGNED_OUT: &str =
    "You've been signed out of your Cortex account. Sign in again in Settings > Cortex account.";
const OFFLINE: &str = "Can't reach Juno. Check your connection and try again.";
const BUSY: &str = "Juno is busy right now. Try again later; nothing was used.";

#[derive(Serialize, Debug, Clone)]
pub struct JunoError {
    code: String,
    message: String,
}

impl JunoError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

type Res<T> = Result<T, JunoError>;

#[derive(Default)]
pub struct JunoState {
    sign_in: Arc<Mutex<Option<String>>>,
}

fn gateway() -> String {
    if !cfg!(debug_assertions) {
        return DEFAULT_GATEWAY.to_string();
    }
    std::env::var(GATEWAY_ENV)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_GATEWAY.to_string())
}

fn vault(key: &str) -> Res<keyring::Entry> {
    let base = gateway();
    let user = if base == DEFAULT_GATEWAY {
        key.to_string()
    } else {
        format!("{key}@{base}")
    };
    keyring::Entry::new(VAULT_SERVICE, &user).map_err(vault_error)
}

fn vault_error(error: keyring::Error) -> JunoError {
    JunoError::new(
        "vault",
        format!("Windows Credential Manager couldn't keep the Cortex account sign-in: {error}"),
    )
}

fn vault_read(key: &str) -> Res<Option<String>> {
    match vault(key)?.get_password() {
        Ok(value) => Ok(Some(value).filter(|v| !v.trim().is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(vault_error(error)),
    }
}

fn vault_write(key: &str, value: &str) -> Res<()> {
    vault(key)?.set_password(value).map_err(vault_error)
}

fn vault_forget(key: &str) -> Res<()> {
    match vault(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(vault_error(error)),
    }
}

fn pending_ids() -> Res<Vec<String>> {
    Ok(vault_read(PENDING_KEY)?
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

fn set_pending_ids(ids: &[String]) -> Res<()> {
    if ids.is_empty() {
        vault_forget(PENDING_KEY)
    } else {
        vault_write(PENDING_KEY, &ids.join(","))
    }
}

fn forget_session() -> Res<()> {
    vault_forget(TOKEN_KEY)?;
    vault_forget(DEVICE_KEY)
}

fn client() -> Res<Client> {
    Client::builder()
        .user_agent(format!(
            "{}/{}",
            env!("CARGO_PKG_NAME"),
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| JunoError::new("offline", OFFLINE))
}

fn send(
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
    timeout: Duration,
) -> Res<Option<Value>> {
    let mut request = client()?
        .request(method, format!("{}{path}", gateway()))
        .timeout(timeout);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .map_err(|_| JunoError::new("offline", OFFLINE))?;
    let status = response.status().as_u16();
    let text = response.text().unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok((!text.trim().is_empty()).then_some(parsed));
    }
    Err(gateway_error(status, &parsed))
}

fn authed(method: Method, path: &str, body: Option<Value>, timeout: Duration) -> Res<Value> {
    let token = vault_read(TOKEN_KEY)?.ok_or_else(|| JunoError::new("unauthorized", SIGNED_OUT))?;
    match send(method, path, Some(&token), body, timeout) {
        Ok(value) => Ok(value.unwrap_or(Value::Null)),
        Err(error) if error.code == "unauthorized" => {
            forget_session()?;
            Err(error)
        }
        Err(error) => Err(error),
    }
}

fn gateway_error(status: u16, body: &Value) -> JunoError {
    let err = &body["error"];
    let code = match err["code"].as_str() {
        Some(code) => code.to_string(),
        None if status == 401 => "unauthorized".into(),
        None if status == 404 => "not_found".into(),
        None if status >= 500 => "offline".into(),
        None => "http_error".into(),
    };
    let message = match code.as_str() {
        "unauthorized" => SIGNED_OUT.to_string(),
        "usage_limit" | "insufficient_credits" => match month_day(&err["balance"]["monthly_resets_at"]) {
            Some(date) => format!("You've used this month's Juno allowance. It resets on {date}."),
            None => "You've used this month's Juno allowance.".to_string(),
        },
        "daily_limit" => "You've used today's Juno allowance. It resets at midnight UTC.".to_string(),
        c if c == STUDIO_LIMIT_CODE => "Juno has reached today's limit for Cortex Studio. It resets at midnight UTC; nothing was used.".to_string(),
        "ai_busy" | "provider_unavailable" => BUSY.to_string(),
        "offline" | "internal_error" => OFFLINE.to_string(),
        "ai_unavailable" | "ai_not_open" => "Juno isn't open yet. Nothing was used.".to_string(),
        "rate_limited" | "slow_down" => "Too many requests at once. Wait a minute and try again.".to_string(),
        "account_disabled" => "This Cortex account is disabled, so Juno can't run. Studio's own tools still work.".to_string(),
        "plan_not_allowed" | "unknown_action" | "unknown_field" => "Juno can't write siren patterns for Cortex Studio yet. Nothing was used.".to_string(),
        _ => match err["message"].as_str() {
            Some(text) if !text.trim().is_empty() => format!("Juno couldn't do that: {}.", text.trim().trim_end_matches('.')),
            _ => format!("Juno answered with an error ({status}). Try again."),
        },
    };
    JunoError { code, message }
}

fn month_day(at: &Value) -> Option<String> {
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let date = at.as_str()?.get(..10)?;
    let month: usize = date.get(5..7)?.parse().ok()?;
    let day: u32 = date.get(8..10)?.parse().ok()?;
    Some(format!("{} {day}", MONTHS.get(month.checked_sub(1)?)?))
}

fn clipped(text: &str, max: usize) -> String {
    text.trim()
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

fn origin(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&url[..url.len() - rest.len() + host_end])
}

fn open_in_browser(url: &str) -> Res<()> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| {
        JunoError::new(
            "browser",
            format!("Couldn't open your browser. Open {url} to continue."),
        )
    })
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| JunoError::new("error", "Juno stopped unexpectedly. Try again."))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunoLocal {
    signed_in: bool,
    custom_gateway: bool,
}

#[tauri::command]
pub async fn juno_local() -> Res<JunoLocal> {
    blocking(|| {
        Ok(JunoLocal {
            signed_in: vault_read(TOKEN_KEY)?.is_some(),
            custom_gateway: gateway() != DEFAULT_GATEWAY,
        })
    })
    .await
}

#[tauri::command]
pub async fn juno_status() -> Res<Value> {
    blocking(|| {
        let status = send(
            Method::GET,
            "/v1/status",
            None,
            None,
            Duration::from_secs(8),
        )?
        .unwrap_or(Value::Null);
        Ok(json!({
            "ai": status["ai"].as_str().unwrap_or("soon"),
            "busy": status["busy"].as_bool().unwrap_or(false),
        }))
    })
    .await
}

#[tauri::command]
pub async fn juno_open(page: String) -> Res<()> {
    let path = match page.as_str() {
        "terms" => "/terms",
        "privacy" => "/privacy",
        _ => return Err(JunoError::new("bad_request", "Unknown page.")),
    };
    blocking(move || open_in_browser(&format!("{}{path}", gateway()))).await
}

#[tauri::command]
pub async fn juno_sign_in_start(state: tauri::State<'_, JunoState>) -> Res<Value> {
    let slot = state.sign_in.clone();
    blocking(move || {
        let started = send(
            Method::POST,
            "/v1/auth/device",
            None,
            Some(json!({ "name": DEVICE_NAME, "client": CLIENT })),
            SHORT,
        )?
        .unwrap_or(Value::Null);
        let device_code = started["device_code"]
            .as_str()
            .filter(|code| !code.is_empty())
            .ok_or_else(|| {
                JunoError::new(
                    "bad_response",
                    "Juno sent a sign-in Studio can't read. Try again.",
                )
            })?;
        let user_code = started["user_code"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let base = gateway();
        let offered = started["verification_uri_complete"]
            .as_str()
            .unwrap_or_default();
        let url = if origin(offered).is_some() && origin(offered) == origin(&base) {
            offered.to_string()
        } else {
            format!("{base}/link?code={user_code}")
        };
        *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some(device_code.to_string());
        let opened = open_in_browser(&url).is_ok();
        Ok(json!({
            "userCode": user_code,
            "url": url,
            "opened": opened,
            "interval": started["interval"].as_u64().unwrap_or(5).clamp(2, 30),
            "expiresIn": started["expires_in"].as_u64().unwrap_or(600),
        }))
    })
    .await
}

#[tauri::command]
pub async fn juno_sign_in_reopen(url: String) -> Res<()> {
    blocking(move || {
        if origin(&url).is_none() || origin(&url) != origin(&gateway()) {
            return Err(JunoError::new(
                "bad_request",
                "That isn't a Cortex sign-in page.",
            ));
        }
        open_in_browser(&url)
    })
    .await
}

#[tauri::command]
pub fn juno_sign_in_cancel(state: tauri::State<'_, JunoState>) {
    *state
        .sign_in
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[tauri::command]
pub async fn juno_sign_in_poll(state: tauri::State<'_, JunoState>) -> Res<Value> {
    let slot = state.sign_in.clone();
    blocking(move || {
        let Some(device_code) = slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return Err(JunoError::new("cancelled", "Sign-in was cancelled."));
        };
        let answer = send(
            Method::POST,
            "/v1/auth/device/token",
            None,
            Some(json!({ "device_code": device_code })),
            SHORT,
        );
        let clear = || *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let issued = match answer {
            Ok(value) => value.unwrap_or(Value::Null),
            Err(error) if error.code == "authorization_pending" || error.code == "slow_down" => {
                return Ok(json!({ "status": "pending" }));
            }
            Err(error) if error.code == "offline" => return Ok(json!({ "status": "pending" })),
            Err(error) if error.code == "access_denied" => {
                clear();
                return Err(JunoError::new(
                    "access_denied",
                    "The sign-in was turned down in the browser. Sign in again to retry.",
                ));
            }
            Err(error) if error.code == "expired_token" => {
                clear();
                return Err(JunoError::new(
                    "expired_token",
                    "The sign-in code expired. Sign in again for a new code.",
                ));
            }
            Err(error) => {
                clear();
                return Err(error);
            }
        };
        let token = issued["token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                JunoError::new(
                    "bad_response",
                    "Juno sent a sign-in Studio can't read. Try again.",
                )
            })?;
        {
            let mut current = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if current.as_deref() != Some(device_code.as_str()) {
                return Err(JunoError::new("cancelled", "Sign-in was cancelled."));
            }
            vault_write(TOKEN_KEY, token)?;
            match issued["device_id"].as_str().filter(|id| !id.is_empty()) {
                Some(id) => vault_write(DEVICE_KEY, id)?,
                None => vault_forget(DEVICE_KEY)?,
            }
            *current = None;
        }
        let token = token.to_string();
        std::thread::spawn(move || end_pending_sessions(&token));
        Ok(json!({ "status": "done" }))
    })
    .await
}

fn end_pending_sessions(token: &str) {
    let Ok(ids) = pending_ids() else { return };
    if ids.is_empty() {
        return;
    }
    let left: Vec<String> = ids
        .into_iter()
        .filter(|id| {
            match send(
                Method::DELETE,
                &format!("/v1/me/devices/{id}"),
                Some(token),
                None,
                REVOKE,
            ) {
                Ok(_) => false,
                Err(error) => error.code != "not_found",
            }
        })
        .collect();
    let _ = set_pending_ids(&left);
}

#[tauri::command]
pub async fn juno_sign_out() -> Res<Value> {
    blocking(|| {
        let token = vault_read(TOKEN_KEY)?;
        let device = vault_read(DEVICE_KEY)?;
        let ended = match (token.as_deref(), device.as_deref()) {
            (Some(token), Some(id)) => match send(
                Method::DELETE,
                &format!("/v1/me/devices/{id}"),
                Some(token),
                None,
                REVOKE,
            ) {
                Ok(_) => true,
                Err(error) => error.code == "not_found" || error.code == "unauthorized",
            },
            _ => true,
        };
        forget_session()?;
        if !ended {
            if let Some(id) = device {
                let mut ids = pending_ids().unwrap_or_default();
                ids.retain(|known| known != &id);
                ids.push(id);
                let skip = ids.len().saturating_sub(MAX_PENDING);
                set_pending_ids(&ids[skip..])?;
            }
        }
        Ok(json!({ "offline": !ended }))
    })
    .await
}

#[tauri::command]
pub async fn juno_account() -> Res<Value> {
    blocking(|| {
        let me = authed(Method::GET, "/v1/me", None, SHORT)?;
        let name = me["display_name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| me["discord_username"].as_str())
            .unwrap_or_default();
        let plan = me["plan"].as_str().unwrap_or("free");
        let mut chars = plan.chars();
        let plan = chars
            .next()
            .map(|first| first.to_uppercase().chain(chars).collect::<String>())
            .unwrap_or_default();
        let balance = &me["balance"];
        let used = balance["monthly_left_pct"]
            .as_f64()
            .map(|left| (100.0 - left).clamp(0.0, 100.0));
        Ok(json!({
            "name": name,
            "plan": plan,
            "usedPct": used,
            "resetsOn": month_day(&balance["monthly_resets_at"]),
        }))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SirenAsk {
    vehicle: String,
    setting: String,
    bpm: u32,
    colors: Vec<String>,
    positions: Vec<String>,
    ask: String,
}

fn is_hex_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_answer(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start)
        .then(|| serde_json::from_str::<Value>(&text[start..=end]).ok())
        .flatten()
        .filter(Value::is_object)
}

fn check_siren(out: &str, rows: usize) -> Result<Value, String> {
    let j = parse_answer(out).ok_or("Answer with one JSON object, as the instructions say.")?;
    let bpm = j["bpm"].as_u64().ok_or("\"bpm\" must be a whole number.")?;
    if !(60..=1500).contains(&bpm) {
        return Err(format!("bpm {bpm} is outside 60 to 1500."));
    }
    let flash = j["flash"]
        .as_array()
        .ok_or("The JSON needs a \"flash\" array.")?;
    if flash.len() != rows {
        return Err(format!(
            "\"flash\" has {} rows; this setting has {rows} lights, so it needs exactly {rows}.",
            flash.len()
        ));
    }
    for (i, row) in flash.iter().enumerate() {
        let s = row.as_str().unwrap_or("");
        if s.len() != 32 || !s.bytes().all(|b| b == b'0' || b == b'1') {
            return Err(format!(
                "flash row {} must be a string of exactly 32 characters, each 0 or 1.",
                i + 1
            ));
        }
    }
    if flash
        .iter()
        .all(|r| r.as_str().is_some_and(|s| !s.contains('1')))
    {
        return Err("Every light is off on every beat. Light some beats.".into());
    }
    if let Some(colors) = j.get("color").filter(|c| !c.is_null()) {
        let list = colors.as_array().ok_or("\"color\" must be an array.")?;
        if list.len() != rows {
            return Err(format!(
                "\"color\" needs exactly {rows} entries, one per light."
            ));
        }
        if let Some(bad) = list.iter().find(|c| !c.as_str().is_some_and(is_hex_color)) {
            return Err(format!("{bad} isn't a color like \"#FF0000\"."));
        }
    }
    Ok(json!({
        "name": j["name"].as_str().map(|s| clipped(s, 60)).unwrap_or_default(),
        "why": j["why"].as_str().map(|s| clipped(s, 300)).unwrap_or_default(),
        "bpm": bpm,
        "flash": flash,
        "color": j.get("color").filter(|c| !c.is_null()).cloned().unwrap_or(Value::Null),
    }))
}

fn failed_checks(reason: &str) -> JunoError {
    JunoError::new(
        "checks_failed",
        format!(
            "Juno's pattern didn't pass Studio's checks, so nothing changed: {}. Try describing it differently.",
            reason.trim().trim_end_matches('.')
        ),
    )
}

#[tauri::command]
pub async fn juno_siren_pattern(request: SirenAsk) -> Res<Value> {
    blocking(move || {
        let ask = request.ask.trim().to_string();
        if ask.is_empty() {
            return Err(JunoError::new("bad_request", "Describe the lights first."));
        }
        if ask.chars().count() > MAX_ASK_CHARS {
            return Err(JunoError::new(
                "bad_request",
                format!("Keep the description to {MAX_ASK_CHARS} characters."),
            ));
        }
        let rows = request.positions.len();
        if !(1..=MAX_ROWS).contains(&rows) {
            return Err(JunoError::new(
                "bad_request",
                format!("Juno writes patterns for settings with 1 to {MAX_ROWS} flashing lights."),
            ));
        }
        let colors: Vec<&str> = request.colors.iter().map(|c| c.trim()).collect();
        let colors = if colors.len() == rows && colors.iter().all(|c| is_hex_color(c)) {
            colors
        } else {
            Vec::new()
        };
        let positions: Vec<String> = request.positions.iter().map(|p| clipped(p, 24)).collect();
        let input = json!({
            "vehicle": clipped(&request.vehicle, MAX_VEHICLE_CHARS),
            "setting": clipped(&request.setting, MAX_SETTING_CHARS),
            "ask": ask,
            "rows": rows.to_string(),
            "bpm": request.bpm.min(6000).to_string(),
            "colors": colors.join(", "),
            "positions": clipped(&positions.join("; "), MAX_POSITIONS_CHARS),
        });
        let job = authed(
            Method::POST,
            &format!("/v1/actions/{SIREN_ACTION}"),
            Some(json!({ "input": input, "client_version": env!("CARGO_PKG_VERSION") })),
            ACTION,
        )?;
        let first = check_siren(job["output"].as_str().unwrap_or_default(), rows);
        let reason = match first {
            Ok(result) => return Ok(result),
            Err(reason) => reason,
        };
        let Some(job_id) = job["job_id"].as_str().filter(|id| !id.is_empty()) else {
            return Err(failed_checks(&reason));
        };
        let retry = authed(
            Method::POST,
            &format!("/v1/jobs/{job_id}/escalate"),
            Some(json!({ "reason": reason })),
            ACTION,
        );
        match retry {
            Ok(next) => check_siren(next["output"].as_str().unwrap_or_default(), rows)
                .map_err(|again| failed_checks(&again)),
            Err(error)
                if error.code == "job_not_escalatable" || error.code == "escalation_limit" =>
            {
                Err(failed_checks(&reason))
            }
            Err(error) => Err(error),
        }
    })
    .await
}
