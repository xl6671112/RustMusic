use crate::{db, obs_lyrics, AppState};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};
#[cfg(not(windows))]
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder};

static CANVASES: OnceLock<Mutex<Value>> = OnceLock::new();
fn cache() -> &'static Mutex<Value> {
    CANVASES.get_or_init(|| Mutex::new(json!({"enabled":false,"captureEnabled":false,"previewEnabled":false,"activeId":"","presets":[]})))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn validate(value: &Value) -> Result<(), String> {
    if value.to_string().len() > 64 * 1024 * 1024 { return Err("场景配置总大小超过 64 MB".into()); }
    let presets = value["presets"].as_array().ok_or("场景配置格式无效")?;
    let active = value["activeId"].as_str().ok_or("当前场景无效")?;
    if !value["enabled"].is_boolean() || presets.len() > 20 { return Err("最多保存 20 个场景".into()); }
    if value.get("captureEnabled").is_some_and(|enabled| !enabled.is_boolean()) { return Err("窗口捕捉开关无效".into()); }
    if value.get("previewEnabled").is_some_and(|enabled| !enabled.is_boolean()) { return Err("画布预览开关无效".into()); }
    let mut ids = std::collections::HashSet::new();
    let mut count = 0;
    for preset in presets {
        let id = preset["id"].as_str().ok_or("预设编号无效")?;
        let name = preset["name"].as_str().ok_or("预设名称无效")?;
        if !valid_id(id) || !ids.insert(id) || name.trim().is_empty() || name.chars().count() > 80 { return Err("预设编号或名称无效".into()); }
        let canvases = preset["canvases"].as_array().ok_or("歌词画布格式无效")?;
        if canvases.len() > 12 { return Err("每个场景最多 12 张歌词画布".into()); }
        count += canvases.len();
        for canvas in canvases {
            let id = canvas["id"].as_str().ok_or("画布编号无效")?;
            let name = canvas["name"].as_str().ok_or("画布名称无效")?;
            if !valid_id(id) || id == "primary" || !ids.insert(id) || name.trim().is_empty() || name.chars().count() > 80 { return Err("画布编号或名称无效".into()); }
            for field in ["enabled", "visible"] {
                if canvas.get(field).is_some_and(|value| !value.is_boolean()) { return Err("画布开关无效".into()); }
            }
            obs_lyrics::validate_obs_lyrics_template(canvas["settings"].clone())?;
        }
    }
    if count > 100 || (!active.is_empty() && !presets.iter().any(|p| p["id"] == active)) { return Err("请选择有效场景，画布总数最多 100 张".into()); }
    Ok(())
}
pub(crate) fn init(state: &AppState) {
    if let Some(raw) = db::get_setting(&state.db.lock(), "obs_lyrics_canvases") {
        if let Ok(value) = serde_json::from_str(&raw) {
            if validate(&value).is_ok() { if let Ok(mut v) = cache().lock() { *v = value; } }
        }
    }
}
// Preserve disabled layers so browser sources can resume at their original URLs.
pub(crate) fn settings(id: &str) -> Option<(Value, bool)> {
    let data = cache().lock().ok()?;
    settings_from(&data, id)
}
fn settings_from(data: &Value, id: &str) -> Option<(Value, bool)> {
    for preset in data["presets"].as_array()? {
        for canvas in preset["canvases"].as_array()? {
            if canvas["id"] == id {
                return Some((canvas["settings"].clone(), data["enabled"] == true && preset["id"] == data["activeId"] && canvas["enabled"] != false && canvas["visible"] != false));
            }
        }
    }
    None
}
fn window_title(data: &Value, id: &str) -> Option<String> {
    let preset = data["presets"].as_array()?.iter().find(|preset| preset["id"] == data["activeId"])?;
    let (index, canvas) = preset["canvases"].as_array()?.iter().enumerate().find(|(_, canvas)| canvas["id"] == id)?;
    Some(format!("透明歌词 {} - {} - 播放器", index + 1, canvas["name"].as_str()?))
}
fn capture_enabled_for(data: &Value, id: &str) -> bool {
    if id == "primary" { return data["enabled"] != true; }
    data["enabled"] == true && data["presets"].as_array().is_some_and(|presets| presets.iter().any(|preset|
        preset["id"] == data["activeId"] && preset["canvases"].as_array().is_some_and(|canvases| canvases.iter().any(|canvas|
            canvas["id"] == id && canvas["enabled"] != false))))
}
fn capture_enabled(id: &str) -> bool {
    cache().lock().is_ok_and(|data| capture_enabled_for(&data, id))
}
pub(crate) fn uses_audio_visualizer() -> bool {
    let Ok(data) = cache().lock() else { return false };
    data["enabled"] == true && data["presets"].as_array().is_some_and(|presets| presets.iter().any(|preset|
        preset["id"] == data["activeId"] && preset["canvases"].as_array().is_some_and(|canvases|
            canvases.iter().any(|canvas| canvas["enabled"] != false && canvas["visible"] != false && obs_lyrics::uses_audio_visualizer(&canvas["settings"])))))
}
#[tauri::command]
pub fn get_obs_lyrics_canvases() -> Result<String, String> {
    Ok(cache().lock().map_err(|e| e.to_string())?.to_string())
}
#[tauri::command]
pub async fn set_obs_lyrics_canvases(app: AppHandle, state: State<'_, AppState>, canvases: String) -> Result<(), String> {
    let value: Value = serde_json::from_str(&canvases).map_err(|_| "场景配置格式无效")?;
    validate(&value)?;
    state.db.lock().execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ["obs_lyrics_canvases", &canvases]).map_err(|e| e.to_string())?;
    *cache().lock().map_err(|e| e.to_string())? = value;
    let primary = db::get_setting(&state.db.lock(), "obs_lyrics_settings").and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    state.engine.fx.set_obs_enabled(primary.as_ref().is_some_and(obs_lyrics::uses_audio_visualizer) || uses_audio_visualizer());
    #[cfg(windows)]
    for window in crate::lyrics_capture::windows()? {
        if let Some(id) = window["id"].as_str() {
            if !capture_enabled(id) { crate::lyrics_capture::close(&app, id)?; }
            else if id != "primary" {
                let (title, visible) = {
                    let data = cache().lock().map_err(|e| e.to_string())?;
                    (window_title(&data, id), settings_from(&data, id).is_some_and(|(_, visible)| visible))
                };
                if let Some(title) = title { crate::lyrics_capture::title(id, &title)?; }
                if window["visible"] != visible { crate::lyrics_capture::visibility(app.clone(), id.to_owned(), visible).await?; }
            }
        }
    }
    for (label, window) in app.webview_windows() {
        if let Some(id) = label.strip_prefix("lyrics-canvas-") {
            if !capture_enabled(id) { window.close().map_err(|e| e.to_string())?; }
            else if let Some(title) = window_title(&*cache().lock().map_err(|e| e.to_string())?, id) { window.set_title(&title).map_err(|e| e.to_string())?; }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn get_open_obs_lyrics_canvases(app: AppHandle) -> Result<Vec<Value>, String> {
    #[cfg(windows)]
    { let _ = app; return crate::lyrics_capture::windows(); }
    #[cfg(not(windows))]
    app.webview_windows().iter().filter_map(|(label, window)| label.strip_prefix("lyrics-canvas-").map(|id|
        window.is_visible().map(|visible| json!({"id":id,"visible":visible})).map_err(|e| e.to_string())
    )).collect()
}
#[cfg(not(windows))]
fn emit_window_state(app: &AppHandle, id: &str, open: bool, visible: bool) -> Result<(), String> {
    app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":id,"open":open,"visible":visible})).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn set_obs_lyrics_canvas_visibility(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    if !valid_id(&id) { return Err("画布编号无效".into()); }
    if visible && !capture_enabled(&id) { return Err("请先启用画布并切换到对应场景；单歌词窗口仅在场景模式关闭时可用".into()); }
    #[cfg(windows)]
    { return crate::lyrics_capture::visibility(app, id, visible).await; }
    #[cfg(not(windows))]
    {
    let window = app.get_webview_window(&format!("lyrics-canvas-{id}")).ok_or("请先创建透明窗口")?;
    if visible {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    emit_window_state(&app, &id, true, visible)
    }
}
#[tauri::command]
pub fn close_obs_lyrics_canvas(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) { return Err("画布编号无效".into()); }
    #[cfg(windows)]
    { return crate::lyrics_capture::close(&app, &id); }
    #[cfg(not(windows))]
    {
    if let Some(window) = app.get_webview_window(&format!("lyrics-canvas-{id}")) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
    }
}
#[tauri::command]
pub async fn open_obs_lyrics_canvas(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) || !capture_enabled(&id) { return Err("请先启用画布并切换到对应场景；单歌词窗口仅在场景模式关闭时可用".into()); }
    if id != "primary" && !settings(&id).is_some_and(|(_, visible)| visible) { return Err("请先显示该歌词画布".into()); }
    #[cfg(windows)]
    {
        let title = if id == "primary" { "透明歌词 - 播放器".to_owned() }
            else { window_title(&*cache().lock().map_err(|e| e.to_string())?, &id).ok_or("歌词画布不存在")? };
        crate::lyrics_capture::open(app.clone(), id.clone(), title).await?;
        if !capture_enabled(&id) {
            crate::lyrics_capture::close(&app, &id)?;
            return Err("场景已切换，歌词窗口已关闭".into());
        }
        if id != "primary" && !settings(&id).is_some_and(|(_, visible)| visible) {
            crate::lyrics_capture::visibility(app, id, false).await?;
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
    let label = format!("lyrics-canvas-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return emit_window_state(&app, &id, true, true);
    }
    let title = if id == "primary" { "透明歌词 - 播放器".to_owned() }
        else { window_title(&*cache().lock().map_err(|e| e.to_string())?, &id).ok_or("歌词画布不存在")? };
    let path = if id == "primary" { "lyrics".to_owned() } else { format!("canvas/{id}") };
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(format!("http://127.0.0.1:17842/{path}").parse().map_err(|_| "画布地址无效")?))
        .title(title).inner_size(960.0, 540.0).min_inner_size(320.0, 180.0)
        .shadow(false)
        .transparent(true).background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .build().map_err(|e| e.to_string())?;
    let handle = app.clone();
    let closed_id = id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = emit_window_state(&handle, &closed_id, false, false);
        }
    });
    emit_window_state(&app, &id, true, true)?;
    Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scene_layer_visibility_preserves_the_url_and_can_wake_a_dormant_window() {
        let mut data = json!({"enabled":true,"captureEnabled":true,"activeId":"scene-1","presets":[
            {"id":"scene-1","canvases":[{"id":"layer-1","settings":{"preset":"classic"},"enabled":true,"visible":true}]},
            {"id":"scene-2","canvases":[{"id":"layer-2","settings":{"preset":"jizura"}}]}
        ]});
        assert!(settings_from(&data, "layer-1").unwrap().1);
        assert!(!capture_enabled_for(&data, "primary"), "scene mode must close the single-lyrics capture window");
        data["presets"][0]["canvases"][0]["visible"] = json!(false);
        assert!(!settings_from(&data, "layer-1").unwrap().1, "hiding must also clear an already attached browser source");
        assert!(capture_enabled_for(&data, "layer-1"), "a hidden layer must keep its logical window so it can be shown again");
        data["presets"][0]["canvases"][0]["enabled"] = json!(false);
        assert!(!capture_enabled_for(&data, "layer-1"), "disabling a layer closes its capture process");
        assert!(settings_from(&data, "layer-1").is_some(), "disabled layer URLs must retain their saved visual settings");
        data["activeId"] = json!("scene-2");
        assert!(capture_enabled_for(&data, "layer-2"), "legacy layers without flags default to visible and enabled");
        assert!(settings_from(&data, "layer-2").unwrap().1);
        data["enabled"] = json!(false);
        assert!(capture_enabled_for(&data, "primary"), "single-lyrics capture is available outside scene mode");
        assert!(!capture_enabled_for(&data, "layer-2"));
    }
    #[test]
    fn scene_mode_keeps_browser_sources_independent_of_capture_windows() {
        let mut data = json!({"enabled":true,"activeId":"first","presets":[{"id":"first","canvases":[{"id":"a","name":"字幕","settings":{"preset":"classic"}}]}]});
        assert!(capture_enabled_for(&data, "a"), "an explicit window action must work for legacy scenes without the removed capture switch");
        data["captureEnabled"] = json!(true);
        assert!(capture_enabled_for(&data, "a"));
        data["captureEnabled"] = json!(false);
        assert!(capture_enabled_for(&data, "a"), "the removed global capture flag must not disable per-layer window controls");
        assert_eq!(settings_from(&data, "a"), Some((json!({"preset":"classic"}), true)), "turning off native capture must leave the browser source running");
        data["captureEnabled"] = json!(true);
        data["enabled"] = json!(false);
        assert!(!capture_enabled_for(&data, "a"), "the multi-lyrics switch still closes capture windows");
        data["enabled"] = json!(true);
        data["activeId"] = json!("other");
        assert!(!capture_enabled_for(&data, "a"), "a previous preset must not reopen inactive windows");
    }
    #[test]
    fn capture_titles_distinguish_layers_even_when_their_templates_match() {
        let data = json!({"activeId":"first","presets":[{"id":"first","canvases":[{"id":"a","name":"字幕"},{"id":"b","name":"字幕"}]}]});
        assert_eq!(window_title(&data, "a").as_deref(), Some("透明歌词 1 - 字幕 - 播放器"));
        assert_ne!(window_title(&data, "a"), window_title(&data, "b"), "OBS must be able to select two layers using the same style separately");
        assert!(window_title(&data, "missing").is_none());
    }
    #[test]
    fn independent_canvas_ids_and_active_preset_must_be_valid() {
        assert!(validate(&json!({"enabled":false,"activeId":"","presets":[]})).is_ok());
        assert!(validate(&json!({"enabled":true,"activeId":"missing","presets":[]})).is_err());
        assert!(!valid_id("../state"));
        assert!(validate(&json!({"enabled":false,"activeId":"","presets":[{"id":"one","name":"A","canvases":[]},{"id":"one","name":"B","canvases":[]}]})).is_err());
    }
    #[test]
    fn first_enable_can_reveal_settings_before_a_preset_exists() {
        let data = json!({"enabled":true,"activeId":"","presets":[]});
        assert!(validate(&data).is_ok(), "the first enable must reveal the preset editor without creating a preset implicitly");
        assert!(settings_from(&data,"missing").is_none(), "enabling an empty editor must not open or render a canvas");
    }
    #[test]
    fn each_canvas_keeps_its_settings_and_only_the_active_combination_displays() {
        let mut data = json!({"enabled":true,"activeId":"first","presets":[
            {"id":"first","canvases":[{"id":"a","settings":{"preset":"classic","color":"#112233"}},{"id":"b","settings":{"preset":"folia-hanabi"}}]},
            {"id":"second","canvases":[{"id":"c","settings":{"preset":"jizura"}}]}]});
        assert_eq!(settings_from(&data,"a"), Some((json!({"preset":"classic","color":"#112233"}),true)));
        assert_eq!(settings_from(&data,"b"), Some((json!({"preset":"folia-hanabi"}),true)));
        assert_eq!(settings_from(&data,"c"), Some((json!({"preset":"jizura"}),false)));
        data["activeId"] = json!("");
        assert!(!settings_from(&data,"a").unwrap().1, "an enabled editor without a selected preset must not render any canvas");
        data["activeId"] = json!("second");
        assert!(!settings_from(&data,"a").unwrap().1);
        assert!(settings_from(&data,"c").unwrap().1);
        data["enabled"] = json!(false);
        assert!(!settings_from(&data,"c").unwrap().1);
        assert!(settings_from(&data,"missing").is_none(), "unknown URLs must never display the primary lyrics");
    }
}
