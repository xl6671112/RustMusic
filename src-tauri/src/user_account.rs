//! Account credentials never cross the webview boundary.
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

const TOKEN_KEY: &str = "user_account_token";
static CHANGE: Mutex<()> = Mutex::new(());
// Keep server issuance and local persistence in the same order, including logout.
static AUTH_REQUEST: Mutex<()> = Mutex::new(());
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn current_token() -> Option<String> {
    let _guard = CHANGE.lock().ok()?;
    crate::credentials::get(TOKEN_KEY)
}

fn matches_current(current: Option<&str>, token: &str) -> bool { current == Some(token) }

pub(crate) fn invalidate(token: &str) { let _ = clear(token, true); }
fn clear(token: &str, notify: bool) -> Result<(), String> {
    let result = (|| {
        let _guard = CHANGE.lock().map_err(|_| "帐号状态暂不可用")?;
        if !matches_current(crate::credentials::get(TOKEN_KEY).as_deref(), token) { Ok(false) }
        else { crate::credentials::set(TOKEN_KEY, "")?; Ok(true) }
    })();
    let changed = match result {
        Ok(changed) => changed,
        Err(error) => return Err(error),
    };
    if changed {

        if let Some(app) = APP.get().filter(|_| notify) {
            let _ = app.emit("user-account-invalidated", "帐号已在其他设备登录或登录已过期，请重新登录");
        }
    }
    Ok(())
}

pub(crate) fn request(method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
    let mut req = agent.request(method, &format!("{}{}", crate::updater::WEBSITE, path));
    if let Some(token) = token { req = req.set("Authorization", &format!("Bearer {token}")); }
    if method == "DELETE" {
        if let Some(edit_token) = body.as_ref().and_then(|b| b["editToken"].as_str()) { req = req.set("X-Playlist-Token", edit_token); }
    }
    let response = match body { Some(body) => req.send_json(body), None => req.call() };
    match response {
        Ok(response) => response.into_json().map_err(|_| "服务器返回异常".into()),
        Err(ureq::Error::Status(code, response)) => {
            if code == 401 { if let Some(token) = token { invalidate(token); } }
            let value = response.into_json::<Value>().unwrap_or_default();
            Err(value["error"].as_str().unwrap_or("请求未完成，请重试").to_owned())
        }
        Err(_) => Err("无法连接服务器，请检查网络后重试".into()),
    }
}

fn endpoint(action: &str, body: &Value) -> Result<(&'static str, String), String> {
    let (method, path) = match action {
        "register" => ("POST", "/api/account/register"),
        "login" => ("POST", "/api/account/login"),
        "me" => ("GET", "/api/account/me"),
        "logout" => ("POST", "/api/account/logout"),
        "settings-get" => ("GET", "/api/account/settings"),
        "settings-put" => ("PUT", "/api/account/settings"),
        "pages" => ("GET", "/api/account/pages"),
        "pages-import" => ("POST", "/api/account/pages/import"),
        "playlist-publish" => ("POST", "/api/playlist-pages"),
        "playlist-get" | "playlist-delete" => {
            let slug = body["slug"].as_str().unwrap_or_default();
            if slug.is_empty() || slug.len() > 64 || !slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
                return Err("歌单地址无效".into());
            }
            return if action == "playlist-get" { Ok(("GET", format!("/api/account/pages/{slug}"))) }
                else { Ok(("DELETE", format!("/api/playlist-pages/{slug}"))) };
        }
        _ => return Err("不支持的帐号操作".into()),
    };
    Ok((method, path.into()))
}

#[tauri::command]
pub async fn user_account_request(action: String, body: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&action, body.unwrap_or_else(|| json!({}))))
        .await.map_err(|e| e.to_string())?
}

fn execute(action: &str, body: Value) -> Result<Value, String> {
    if !body.is_object() { return Err("帐号请求格式无效".into()); }
    let (method, path) = endpoint(action, &body)?;
    let signing_in = matches!(action, "register" | "login");
    let _auth_guard = if signing_in || action == "logout" {
        Some(AUTH_REQUEST.lock().map_err(|_| "帐号状态暂不可用")?)
    } else { None };
    if action == "logout" && current_token().is_none() {

        return Ok(json!({ "ok": true }));
    }
    let token = if signing_in { None } else { Some(current_token().ok_or("请先登录帐号")?) };
    let response = request(method, &path, token.as_deref(), if method == "GET" { None } else { Some(body) });
    if action == "logout" {
        if let Some(token) = token { clear(&token, false)?; }
        return Ok(json!({ "ok": true, "remoteLoggedOut": response.is_ok() }));
    }
    let mut value = response?;
    if signing_in {
        let token = value["token"].as_str().filter(|s| !s.is_empty()).ok_or("登录凭据无效")?;
        {
            let _guard = CHANGE.lock().map_err(|_| "帐号状态暂不可用")?;
            crate::credentials::set(TOKEN_KEY, token)?;
        }

    }
    if let Some(object) = value.as_object_mut() { object.remove("token"); }
    Ok(value)
}

pub(crate) fn start_monitor(app: tauri::AppHandle) {
    let _ = APP.set(app);
    std::thread::spawn(|| loop {
        if let Some(token) = current_token() {
            let _ = request("GET", "/api/account/me", Some(&token), None);
        }
        std::thread::sleep(Duration::from_secs(10));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn webview_cannot_route_account_credentials_to_arbitrary_paths() {
        assert!(endpoint("https://other.example", &json!({})).is_err());
        assert!(endpoint("playlist-delete", &json!({"slug":"../account/logout"})).is_err());
        assert_eq!(endpoint("playlist-delete", &json!({"slug":"my-list"})).unwrap().1, "/api/playlist-pages/my-list");
        assert_eq!(endpoint("settings-put", &json!({})).unwrap().0, "PUT");
    }
    #[test]
    fn late_unauthorized_response_cannot_clear_a_new_login() {
        assert!(!matches_current(Some("new-session"), "old-session"));
        assert!(!matches_current(None, "old-session"));
        assert!(matches_current(Some("old-session"), "old-session"));
    }
}




