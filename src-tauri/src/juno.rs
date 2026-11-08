use reqwest::blocking::Client;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const DEFAULT_GATEWAY: &str = "https://api.cortexsoftware.net";
const GATEWAY_ENV: &str = "CORTEX_GATEWAY_URL";
const SITE_ORIGIN: &str = "https://gsdmods.com";
const SITE_ORIGIN_ENV: &str = "CORTEX_SIGNIN_ORIGIN";
const SITE_LINK_PATH: &str = "/cortex/link";
const GATEWAY_LINK_PATH: &str = "/link";
const SIGN_IN_EVENT: &str = "juno-sign-in";
const DEFAULT_POLL_SECS: u64 = 5;
const MAX_POLL_SECS: u64 = 30;
const OFFLINE_NOTICE_AFTER: Duration = Duration::from_secs(30);
const SIGN_IN_FAILURE_SHOWN_FOR: Duration = Duration::from_secs(15 * 60);
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
const PING: Duration = Duration::from_secs(8);
const USAGE_EVENTS: [&str; 6] = ["open", "livery", "template", "eup", "photo", "siren"];
const MAX_USAGE_COUNT: u32 = 500;

const SIGNED_OUT: &str =
    "You've been signed out of your Cortex account. Sign in again in Settings > Cortex account.";
const SIGN_IN_DENIED: &str = "The sign-in was turned down on gsdmods.com. Sign in again to retry.";
const SIGN_IN_EXPIRED: &str = "The sign-in request expired. Sign in again for a new one.";
const SIGN_IN_CANCELLED: &str = "Sign-in was cancelled. Sign in again to retry.";
const SIGN_IN_FAILED: &str = "Sign-in didn't finish on the Cortex server. Sign in again to retry.";
const SIGN_IN_UNREADABLE: &str = "Cortex sent a sign-in Studio can't read. Try again.";
const SIGN_IN_OFFLINE: &str =
    "Can't reach Cortex right now. Studio keeps trying until the request expires.";
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

struct SignIn {
    id: u64,
    device_code: String,
    user_code: String,
    url: String,
    opened: bool,
    offline: bool,
    expires_at: Instant,
}

type SignInSlot = Arc<Mutex<Option<SignIn>>>;
type SignInFailure = Arc<Mutex<Option<(JunoError, Instant)>>>;

#[derive(Default)]
pub struct JunoState {
    sign_in: SignInSlot,
    sign_in_failure: SignInFailure,
    next_sign_in: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

fn site_origin() -> String {
    if cfg!(debug_assertions) {
        if let Some(origin) = std::env::var(SITE_ORIGIN_ENV)
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        {
            return origin;
        }
    }
    SITE_ORIGIN.to_string()
}

fn same_origin(url: &Url, base: &str) -> bool {
    Url::parse(base)
        .map(|base| base.origin() == url.origin())
        .unwrap_or(false)
}

fn sign_in_url_allowed(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    (same_origin(&url, &site_origin()) && url.path() == SITE_LINK_PATH)
        || (same_origin(&url, &gateway()) && url.path() == GATEWAY_LINK_PATH)
}

fn gateway_link(user_code: &str) -> Res<String> {
    Url::parse_with_params(
        &format!("{}{GATEWAY_LINK_PATH}", gateway()),
        [("code", user_code)],
    )
    .map(String::from)
    .map_err(|_| JunoError::new("bad_response", SIGN_IN_UNREADABLE))
}

fn device_name() -> String {
    let computer = clipped(&std::env::var("COMPUTERNAME").unwrap_or_default(), 40);
    if computer.is_empty() {
        DEVICE_NAME.to_string()
    } else {
        format!("{DEVICE_NAME} on {computer}")
    }
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
pub async fn juno_sign_in_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, JunoState>,
) -> Res<Value> {
    let slot = state.sign_in.clone();
    let failure = state.sign_in_failure.clone();
    let id = state.next_sign_in.fetch_add(1, Ordering::Relaxed) + 1;
    *lock(&failure) = None;
    blocking(move || {
        let started = send(
            Method::POST,
            "/v1/auth/device",
            None,
            Some(json!({ "name": device_name(), "client": CLIENT })),
            SHORT,
        )?
        .unwrap_or(Value::Null);
        let unreadable = || JunoError::new("bad_response", SIGN_IN_UNREADABLE);
        let device_code = started["device_code"]
            .as_str()
            .filter(|code| !code.is_empty())
            .ok_or_else(unreadable)?
            .to_string();
        let user_code = started["user_code"]
            .as_str()
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .ok_or_else(unreadable)?
            .to_string();
        let offered = started["verification_uri_complete"]
            .as_str()
            .unwrap_or_default();
        let url = if sign_in_url_allowed(offered) {
            offered.to_string()
        } else {
            gateway_link(&user_code)?
        };
        let interval = started["interval"]
            .as_u64()
            .unwrap_or(DEFAULT_POLL_SECS)
            .clamp(2, MAX_POLL_SECS);
        let expires_in = started["expires_in"]
            .as_u64()
            .unwrap_or(600)
            .clamp(60, 1800);
        *lock(&slot) = Some(SignIn {
            id,
            device_code,
            user_code: user_code.clone(),
            url: url.clone(),
            opened: false,
            offline: false,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
        });
        let opened = open_in_browser(&url).is_ok();
        if let Some(flow) = lock(&slot).as_mut().filter(|flow| flow.id == id) {
            flow.opened = opened;
        }
        let watched = slot.clone();
        std::thread::spawn(move || watch_sign_in(app, watched, failure, id, interval));
        Ok(json!({
            "userCode": user_code,
            "opened": opened,
            "expiresIn": expires_in,
        }))
    })
    .await
}

#[tauri::command]
pub async fn juno_sign_in_state(state: tauri::State<'_, JunoState>) -> Res<Value> {
    Ok(match lock(&state.sign_in).as_ref() {
        Some(flow) if Instant::now() < flow.expires_at => json!({
            "active": true,
            "userCode": flow.user_code,
            "opened": flow.opened,
            "offline": flow.offline,
            "expiresIn": flow.expires_at.saturating_duration_since(Instant::now()).as_secs(),
        }),
        _ => match lock(&state.sign_in_failure).as_ref() {
            Some((error, at)) if at.elapsed() < SIGN_IN_FAILURE_SHOWN_FOR => {
                json!({ "active": false, "error": error })
            }
            _ => json!({ "active": false }),
        },
    })
}

#[tauri::command]
pub async fn juno_sign_in_reopen(state: tauri::State<'_, JunoState>) -> Res<()> {
    let slot = state.sign_in.clone();
    blocking(move || {
        let (id, url) = lock(&slot)
            .as_ref()
            .map(|flow| (flow.id, flow.url.clone()))
            .ok_or_else(|| JunoError::new("cancelled", SIGN_IN_CANCELLED))?;
        open_in_browser(&url)?;
        if let Some(flow) = lock(&slot).as_mut().filter(|flow| flow.id == id) {
            flow.opened = true;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn juno_sign_in_cancel(state: tauri::State<'_, JunoState>) -> Res<()> {
    *lock(&state.sign_in) = None;
    *lock(&state.sign_in_failure) = None;
    Ok(())
}

fn mark_offline(slot: &SignInSlot, id: u64, offline: bool) {
    if let Some(flow) = lock(slot).as_mut().filter(|flow| flow.id == id) {
        flow.offline = offline;
    }
}

fn current_flow(slot: &SignInSlot, id: u64) -> Option<(String, Instant)> {
    lock(slot)
        .as_ref()
        .filter(|flow| flow.id == id)
        .map(|flow| (flow.device_code.clone(), flow.expires_at))
}

fn announce_sign_in(app: &tauri::AppHandle, payload: Value) {
    let _ = app.emit(SIGN_IN_EVENT, payload);
}

fn end_sign_in(
    app: &tauri::AppHandle,
    slot: &SignInSlot,
    failure: &SignInFailure,
    id: u64,
    error: JunoError,
) {
    {
        let mut current = lock(slot);
        if current.as_ref().map(|flow| flow.id) != Some(id) {
            return;
        }
        *current = None;
        *lock(failure) = Some((error.clone(), Instant::now()));
    }
    announce_sign_in(
        app,
        json!({ "status": "error", "code": error.code, "message": error.message }),
    );
}

fn keep_sign_in(slot: &SignInSlot, id: u64, issued: &Value) -> Res<Option<String>> {
    let unreadable = || JunoError::new("bad_response", SIGN_IN_UNREADABLE);
    let token = issued["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(unreadable)?;
    let device = issued["device_id"]
        .as_str()
        .filter(|device| !device.is_empty())
        .ok_or_else(unreadable)?;
    let mut current = lock(slot);
    if current.as_ref().map(|flow| flow.id) != Some(id) {
        return Ok(None);
    }
    vault_write(DEVICE_KEY, device)?;
    if let Err(error) = vault_write(TOKEN_KEY, token) {
        let _ = vault_forget(DEVICE_KEY);
        return Err(error);
    }
    *current = None;
    Ok(Some(token.to_string()))
}

fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

fn watch_sign_in(
    app: tauri::AppHandle,
    slot: SignInSlot,
    failure: SignInFailure,
    id: u64,
    mut interval: u64,
) {
    let mut offline_since: Option<Instant> = None;
    let mut told_offline = false;
    loop {
        std::thread::sleep(Duration::from_secs(interval));
        let Some((device_code, expires_at)) = current_flow(&slot, id) else {
            return;
        };
        if Instant::now() >= expires_at {
            end_sign_in(
                &app,
                &slot,
                &failure,
                id,
                JunoError::new("expired_token", SIGN_IN_EXPIRED),
            );
            return;
        }
        let answer = send(
            Method::POST,
            "/v1/auth/device/token",
            None,
            Some(json!({ "device_code": device_code })),
            SHORT,
        );
        let error = match answer {
            Ok(issued) => {
                match keep_sign_in(&slot, id, &issued.unwrap_or(Value::Null)) {
                    Ok(Some(token)) => {
                        std::thread::spawn(move || end_pending_sessions(&token));
                        bring_to_front(&app);
                        announce_sign_in(&app, json!({ "status": "done" }));
                    }
                    Ok(None) => {}
                    Err(error) => end_sign_in(&app, &slot, &failure, id, error),
                }
                return;
            }
            Err(error) => error,
        };
        match error.code.as_str() {
            "offline" | "internal_error" => {
                let since = *offline_since.get_or_insert_with(Instant::now);
                if !told_offline && since.elapsed() >= OFFLINE_NOTICE_AFTER {
                    told_offline = true;
                    mark_offline(&slot, id, true);
                    announce_sign_in(
                        &app,
                        json!({ "status": "offline", "message": SIGN_IN_OFFLINE }),
                    );
                }
                continue;
            }
            "authorization_pending" => {}
            "slow_down" | "rate_limited" => interval = (interval + 5).min(MAX_POLL_SECS),
            "access_denied" => {
                end_sign_in(
                    &app,
                    &slot,
                    &failure,
                    id,
                    JunoError::new("access_denied", SIGN_IN_DENIED),
                );
                return;
            }
            "expired_token" => {
                end_sign_in(
                    &app,
                    &slot,
                    &failure,
                    id,
                    JunoError::new("expired_token", SIGN_IN_EXPIRED),
                );
                return;
            }
            "account_disabled" | "bad_response" | "vault" => {
                end_sign_in(&app, &slot, &failure, id, error);
                return;
            }
            _ => {
                end_sign_in(
                    &app,
                    &slot,
                    &failure,
                    id,
                    JunoError::new(&error.code, SIGN_IN_FAILED),
                );
                return;
            }
        }
        offline_since = None;
        if told_offline {
            told_offline = false;
            mark_offline(&slot, id, false);
            announce_sign_in(&app, json!({ "status": "waiting" }));
        }
    }
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
pub async fn usage_ping(install_id: String, event: String, count: u32) -> Res<()> {
    let id_ok = install_id.len() == 32
        && install_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !id_ok || count == 0 || !USAGE_EVENTS.contains(&event.as_str()) {
        return Err(JunoError::new("bad_request", "Unknown usage count."));
    }
    let body = json!({
        "client": CLIENT,
        "install_id": install_id,
        "version": env!("CARGO_PKG_VERSION"),
        "event": event,
        "count": count.min(MAX_USAGE_COUNT),
    });
    blocking(move || send(Method::POST, "/v1/usage", None, Some(body), PING).map(|_| ())).await
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
