use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Branding {
    pub name: String,
    pub tagline: String,
    pub logo: Option<String>,
}

fn base() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.join("branding"))
}

pub(crate) fn config() -> Branding {
    let mut value: Branding = base().and_then(|p| std::fs::read(p.join("branding.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if value.name.trim().is_empty() || value.name.chars().count() > 48 { value.name = "RustMusic".into(); }
    if value.tagline.chars().count() > 60 { value.tagline.clear(); }
    // Only a fixed local PNG is loaded; JSON cannot point to arbitrary files or URLs.
    value.logo = base().and_then(|p| std::fs::read(p.join("logo.png")).ok())
        .filter(|b| b.len() <= 2 * 1024 * 1024 && b.starts_with(b"\x89PNG\r\n\x1a\n"))
        .map(|b| format!("data:image/png;base64,{}", STANDARD.encode(b)));
    value
}

pub(crate) fn icon(file: &str) -> Option<tauri::image::Image<'static>> {
    let path = base()?.join(file);
    if std::fs::metadata(&path).ok()?.len() > 2 * 1024 * 1024 { return None; }
    let image = image::open(path).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    Some(tauri::image::Image::new_owned(image.into_raw(), width, height))
}

pub(crate) fn apply(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&config().name);
        if let Some(icon) = icon("app.png") { let _ = window.set_icon(icon); }
    }
}

#[tauri::command]
pub fn get_branding() -> Branding { config() }
