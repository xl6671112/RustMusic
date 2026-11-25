//! Read-only loopback lyrics page for OBS browser sources.
use crate::{db, AppState};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::State;

static LYRICS: OnceLock<Mutex<Value>> = OnceLock::new();
static SETTINGS: OnceLock<Mutex<Value>> = OnceLock::new();
static SERVER_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
const MAX_FONT_BYTES: usize = 20 * 1024 * 1024;
const FOLIA_WORKERS: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/folia-workers.rs"));
const JIZURA_ASSETS: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/jizura-assets.rs"));
const JIZURA_PAGE: &str = include_str!("../../jizura-overlay/dist/lyrics.html");
#[cfg(feature = "acceptance-tests")]
pub static ACCEPTANCE_DROP_STATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(feature = "acceptance-tests")]
pub static ACCEPTANCE_DROPPED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn lyric_cache() -> &'static Mutex<Value> {
    LYRICS.get_or_init(|| Mutex::new(json!({"trackKey":null,"lyrics":null,"title":"","artist":""})))
}
fn settings_cache() -> &'static Mutex<Value> {
    SETTINGS.get_or_init(|| {
        Mutex::new(json!({"preset":"classic","mode":"current-next","motion":true,"css":""}))
    })
}

fn uses_folia_renderer(value: &Value) -> bool {
    value
        .get("preset")
        .and_then(Value::as_str)
        .is_some_and(|preset| preset.starts_with("folia-"))
}
fn uses_audio_visualizer(value: &Value) -> bool {
    uses_folia_renderer(value) || value.get("preset").and_then(Value::as_str) == Some("jizura")
}
const FOLIA_PAGE: &str = r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/folia.css"><title>Folia Lyrics</title></head><body><div id="root"></div><script type="module" src="/folia.js"></script></body></html>"#;
fn regular_lyrics_page() -> &'static str {
    include_str!("../../src/obs-lyrics.html")
}
fn lyrics_page_for_settings(settings: &Value) -> &'static str {
    if uses_folia_renderer(settings) {
        FOLIA_PAGE
    } else if settings.get("preset").and_then(Value::as_str) == Some("jizura") {
        JIZURA_PAGE
    } else {
        regular_lyrics_page()
    }
}
fn server_error() -> &'static Mutex<Option<String>> {
    SERVER_ERROR.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn publish_obs_lyrics(state: State<'_, AppState>, payload: Value) {
    if let Ok(mut cache) = lyric_cache().lock() {
        *cache = payload;
    }
    let _ = &state;
}

#[tauri::command]
pub fn get_obs_lyrics_settings(state: State<'_, AppState>) -> Result<String, String> {
    if let Some(error) = server_error().lock().ok().and_then(|v| v.clone()) {
        return Err(error);
    }
    let conn = state.db.lock();
    let raw = db::get_setting(&conn, "obs_lyrics_settings").unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
        if let Ok(mut cache) = settings_cache().lock() {
            *cache = value;
        }
    }
    Ok(raw)
}

#[tauri::command]
pub fn set_obs_lyrics_settings(state: State<'_, AppState>, settings: String) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(&settings).map_err(|_| "Invalid OBS lyrics settings JSON")?;
    validate_settings(&value)?;
    let conn = state.db.lock();
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ["obs_lyrics_settings", &settings]).map_err(|e| e.to_string())?;
    state.engine.fx.set_obs_enabled(uses_audio_visualizer(&value));
    if let Ok(mut cache) = settings_cache().lock() {
        *cache = value;
    }
    Ok(())
}

#[tauri::command]
pub async fn import_obs_lyrics_font(state: State<'_, AppState>, name: String, data: String) -> Result<Value, String> {
    let directory = state.app_data.join("lyrics-fonts");
    tauri::async_runtime::spawn_blocking(move || store_font(&directory, &name, &data))
        .await.map_err(|e| e.to_string())?
}

fn font_mime(id: &str) -> Option<&'static str> {
    let (hash, extension) = id.split_once('.')?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    match extension {
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

fn store_font(directory: &Path, name: &str, encoded: &str) -> Result<Value, String> {
    if encoded.len() > MAX_FONT_BYTES.div_ceil(3) * 4 { return Err("字体文件不能超过 20 MB".into()); }
    let extension = Path::new(name).extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    let bytes = STANDARD.decode(encoded).map_err(|_| "字体数据无效")?;
    let valid = match extension.as_str() {
        "ttf" => bytes.len() >= 12 && (bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"true")),
        "otf" => bytes.len() >= 12 && bytes.starts_with(b"OTTO"),
        "woff" => bytes.len() >= 44 && bytes.starts_with(b"wOFF"),
        "woff2" => bytes.len() >= 48 && bytes.starts_with(b"wOF2"),
        _ => false,
    };
    if !valid || bytes.len() > MAX_FONT_BYTES { return Err("请选择有效的 TTF、OTF、WOFF 或 WOFF2 字体（最大 20 MB）".into()); }
    let id = format!("{:x}.{extension}", Sha256::digest(&bytes));
    let label: String = Path::new(name).file_stem().and_then(|v| v.to_str()).unwrap_or("自定义字体").chars().take(60).collect();
    fs::create_dir_all(directory).map_err(|e| format!("创建字体目录失败：{e}"))?;
    fs::write(directory.join(&id), bytes).map_err(|e| format!("保存字体失败：{e}"))?;
    Ok(json!({"fontFile": id, "fontName": label}))
}

fn read_font(directory: &Path, id: &str) -> Option<(&'static str, Vec<u8>)> {
    let mime = font_mime(id)?;
    let bytes = fs::read(directory.join(id)).ok()?;
    if bytes.len() > MAX_FONT_BYTES { return None; }
    Some((mime, bytes))
}

fn serve_asset(stream: &mut TcpStream, asset: Option<(&'static str, Vec<u8>)>) {
    if let Some((mime, bytes)) = asset {
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: public, max-age=31536000, immutable\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", bytes.len());
        let _ = stream.write_all(&bytes);
    } else {
        let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
}

const MAX_FOLIA_IMAGE_BYTES: usize = 8 * 1024 * 1024;

fn folia_image_mime(id: &str) -> Option<&'static str> {
    let (hash, extension) = id.split_once('.')?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    match extension {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

#[tauri::command]
pub async fn import_folia_image(state: State<'_, AppState>, data: String) -> Result<String, String> {
    let directory = state.app_data.join("folia-images");
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > MAX_FOLIA_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("Folia 图片最大 8 MB".into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| "图片数据无效")?;
        if bytes.len() > MAX_FOLIA_IMAGE_BYTES { return Err("Folia 图片最大 8 MB".into()); }
        let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "png" }
            else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { "jpg" }
            else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "webp" }
            else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { "gif" }
            else { return Err("请选择 PNG、JPEG、WebP 或 GIF 图片".into()); };
        let id = format!("{:x}.{extension}", Sha256::digest(&bytes));
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        fs::write(directory.join(&id), bytes).map_err(|error| error.to_string())?;
        Ok(id)
    }).await.map_err(|error| error.to_string())?
}

fn validate_settings(v: &Value) -> Result<(), String> {
    let o = v
        .as_object()
        .ok_or("OBS lyrics settings must be an object")?;
    if o.get("officialCss").is_some_and(|v| v.as_str().map_or(true, |s| s.len()>6000 || ["url","@import","expression","image-set","\\","<",">"].iter().any(|x| s.to_lowercase().contains(x)))) { return Err("官网歌词风格无效".into()); }
    if !matches!(
        o.get("preset").and_then(Value::as_str),
        Some("jizura" | "classic" | "karaoke" | "neon" | "minimal" | "stage" | "nowplaying" | "nowplaying-liquid" | "nowplaying-skeuo" | "nowplaying-fly" | "aurora" | "hologram" | "ripple" | "danmaku" | "particle-dissolve" | "folia-cadenza" | "folia-cappella" | "folia-claddagh" | "folia-classic" | "folia-diorama" | "folia-fume" | "folia-hanabi" | "folia-lumiere" | "folia-machi" | "folia-metaphor" | "folia-monet" | "folia-nebbia" | "folia-partita" | "folia-pendolo" | "folia-prompt" | "folia-sonnet" | "folia-still" | "folia-tempera" | "folia-tilt")
    ) {
        return Err("Invalid lyrics preset".into());
    }
    if let Some(jizura) = o.get("jizura") {
        let settings = jizura.as_object().ok_or("Invalid JIZURA settings")?;
        if jizura.to_string().len() > 8 * 1024 * 1024
            || settings.get("transparent").is_some_and(|value| !value.is_boolean())
            || settings.get("project").is_some_and(|value| !value.is_object())
            || settings.get("lineEffectsTrackKey").is_some_and(|value| !value.is_string())
        {
            return Err("Invalid JIZURA project data".into());
        }
        if let Some(fonts) = settings.get("fontFiles") {
            let fonts = fonts.as_object().ok_or("Invalid JIZURA fonts")?;
            if fonts.len() > 100 || fonts.values().any(|value| value.as_str().and_then(font_mime).is_none()) {
                return Err("Invalid JIZURA font file".into());
            }
        }
        if let Some(analysis) = settings.get("analysis") {
            let analysis = analysis.as_object().ok_or("Invalid JIZURA audio analysis")?;
            for key in ["beats", "energy"] {
                if analysis.get(key).is_some_and(|value| {
                    value.as_array().map_or(true, |values| {
                        values.len() > 1_000_000 || values.iter().any(|value| value.as_f64().is_none())
                    })
                }) {
                    return Err("Invalid JIZURA analysis samples".into());
                }
            }
        }
    }
    if let Some(tunings) = o.get("foliaTunings") {
        let values = tunings.as_object().ok_or("Invalid Folia tunings")?;
        if tunings.to_string().len() > 128 * 1024
            || values.iter().any(|(mode, tuning)| {
                !matches!(
                    mode.as_str(),
                    "cadenza" | "cappella" | "claddagh" | "classic" | "diorama" | "fume"
                        | "hanabi" | "lumiere" | "machi" | "metaphor" | "monet" | "nebbia"
                        | "partita" | "pendolo" | "prompt" | "sonnet" | "still" | "tempera" | "tilt"
                ) || !tuning.is_object()
            })
        {
            return Err("Invalid Folia tuning data".into());
        }
    }
    if let Some(appearance) = o.get("foliaAppearance") {
        let appearance = appearance.as_object().ok_or("Folia 外观格式有误")?;
        if appearance.get("glowColors").is_some_and(|colors| colors.as_object().map_or(true, |colors| {
            colors.len() > 20 || colors.values().any(|value| !value.as_str().is_some_and(|color| {
                color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|c| c.is_ascii_hexdigit())
            }))
        })) {
            return Err("Folia 光晕颜色格式有误".into());
        }
        for field in ["fontFile", "subtitleFontFile"] {
            if appearance.get(field).is_some_and(|value| value.as_str().and_then(font_mime).is_none()) {
                return Err("Folia 字体文件格式有误".into());
            }
        }
        for (field, min, max) in [
            ("lyricsFontScale", 0.85, 1.4), ("subtitleFontScale", 0.85, 1.4),
            ("visualizerOpacity", 0.2, 1.0), ("subtitleOverlayOpacity", 0.2, 1.0),
        ] {
            if appearance.get(field).is_some_and(|value| !value.as_f64().is_some_and(|n| (min..=max).contains(&n))) {
                return Err(format!("Folia 设置值超出范围：{field}"));
            }
        }
    }
    if let Some(assets) = o.get("foliaAssets") {
        let assets = assets.as_object().ok_or("Folia 图片列表格式有误")?;
        for (slot, files) in assets {
            if !matches!(slot.as_str(), "monet" | "emoji" | "avatar" | "tempera") {
                return Err("Folia 图片分组有误".into());
            }
            let files = files.as_array().ok_or("Folia 图片列表格式有误")?;
            if files.len() > 30 || files.iter().any(|file| {
                file["file"].as_str().and_then(folia_image_mime).is_none()
                    || !file["id"].as_str().is_some_and(|id| !id.is_empty() && id.len() <= 120)
                    || !file["name"].as_str().is_some_and(|name| name.chars().count() <= 120)
            }) {
                return Err("Folia 图片引用有误".into());
            }
        }
    }
    if !matches!(
        o.get("mode").and_then(Value::as_str),
        Some("current" | "current-next" | "multi")
    ) {
        return Err("Invalid lyrics display mode".into());
    }
    if o.get("motion").and_then(Value::as_bool).is_none()
        || o.get("htmlTuningEnabled").is_some_and(|value| !value.is_boolean())
        || o.get("css")
            .and_then(Value::as_str)
            .map_or(true, |s| s.len() > 60_000)
        || o.get("font")
            .and_then(Value::as_str)
            .map_or(true, |s| s.len() > 120)
        || o.get("shadow")
            .and_then(Value::as_str)
            .map_or(true, |s| s.len() > 160)
    {
        return Err("Invalid motion or CSS setting".into());
    }
    if o.get("fontFile").is_some_and(|v| !v.as_str().is_some_and(|s| s.is_empty() || font_mime(s).is_some()))
        || o.get("fontName").is_some_and(|v| !v.as_str().is_some_and(|s| s.len() <= 240)) {
        return Err("Invalid imported lyrics font".into());
    }
    if o.get("widget").is_some_and(|v| !matches!(v.as_str(), Some("preset" | "none" | "stars" | "notes" | "bars" | "bounce"))) {
        return Err("Invalid lyrics widget".into());
    }
    if !o
        .get("size")
        .and_then(Value::as_u64)
        .is_some_and(|n| (12..=120).contains(&n))
        || !o
            .get("width")
            .and_then(Value::as_u64)
            .is_some_and(|n| (240..=3000).contains(&n))
    {
        return Err("Invalid lyrics size or width".into());
    }
    if !o
        .get("weight")
        .and_then(Value::as_u64)
        .is_some_and(|n| [400, 600, 700, 800].contains(&n))
        || !matches!(
            o.get("align").and_then(Value::as_str),
            Some("left" | "center" | "right")
        )
        || !o.get("color").and_then(Value::as_str).is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err("Invalid lyrics typography setting".into());
    }
    for (key, min, max) in [
        ("strokeWidth", 0.0, 8.0),
        ("lineHeight", 1.0, 3.0),
        ("letterSpacing", -2.0, 20.0),
        ("translationSize", 10.0, 80.0),
        ("rows", 1.0, 8.0),
        ("offsetY", -500.0, 500.0),
    ] {
        if !o
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|n| (min..=max).contains(&n))
        {
            return Err(format!("Invalid lyrics setting: {key}"));
        }
    }
    for (key, min, max) in [
        ("particleSize", 0.2, 20.0),
        ("particleCount", 1.0, 100.0),
        ("particleLifetime", 200.0, 3000.0),
        ("particleSpeed", 0.5, 2.5),
        ("particleGlowStrength", 0.0, 100.0),
        ("particleColorIntensity", 0.0, 10.0),
        ("particleFragmentation", 0.0, 100.0),
        ("lyricGlowStrength", 0.0, 10.0),
        ("danmakuStrokeWidth", 0.0, 8.0),
        ("bounceTrailDuration", 100.0, 3000.0),
        ("bounceTrailLength", 0.0, 500.0),
    ] {
        if o.get(key).is_some_and(|v| {
            !v.as_f64().is_some_and(|n| (min..=max).contains(&n))
        }) {
            return Err(format!("Invalid lyrics setting: {key}"));
        }
    }
    if o.get("particleColor").is_some_and(|v| {
        !v.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    }) || ["danmakuShadow", "danmakuAccent", "danmakuGlow", "danmakuStroke"].iter().any(|key| o.get(*key).is_some_and(|v| {
        !v.as_str().is_some_and(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
    })) || o.get("particleGlow").is_some_and(|v| !v.is_boolean())
        || o.get("particleHdr").is_some_and(|v| !v.is_boolean())
        || o.get("particleEdgeHighlight").is_some_and(|v| !v.is_boolean())
        || o.get("bounceTrailType").is_some_and(|v| !matches!(v.as_str(), Some("none" | "single" | "double" | "particles")))
    {
        return Err("Invalid particle setting".into());
    }
    Ok(())
}

pub fn start_server(engine: std::sync::Arc<crate::engine::Engine>, initial_settings: String, font_directory: PathBuf) {
    if let Ok(value) = serde_json::from_str::<Value>(&initial_settings) {
        if validate_settings(&value).is_ok() {
            engine.fx.set_obs_enabled(uses_audio_visualizer(&value));
            if let Ok(mut cache) = settings_cache().lock() {
                *cache = value;
            }
        }
    }
    thread::Builder::new()
        .name("obs-lyrics-http".into())
        .spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", 17842)) {
                Ok(v) => v,
                Err(e) => {
                    let error = format!("OBS lyrics listener failed on 127.0.0.1:17842: {e}");
                    eprintln!("{error}");
                    if let Ok(mut status) = server_error().lock() {
                        *status = Some(error);
                    }
                    return;
                }
            };
            for stream in listener.incoming().flatten() {
                serve(stream, &engine, &font_directory);
            }
        })
        .expect("start OBS lyrics thread");
}

fn serve(mut stream: TcpStream, engine: &crate::engine::Engine, font_directory: &Path) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");
    let host = lines
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
                .map(|(_, v)| v.trim())
        })
        .unwrap_or("");
    if method != "GET" || !matches!(host, "127.0.0.1:17842" | "localhost:17842") {
        let body = "Forbidden";
        let _ = write!(
            stream,
            "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        return;
    }
    if let Some(id) = path.strip_prefix("/fonts/") {
        serve_asset(&mut stream, read_font(font_directory, id));
        return;
    }
    if let Some(id) = path.strip_prefix("/folia-images/") {
        let asset = folia_image_mime(id).and_then(|mime| {
            let bytes = fs::read(font_directory.with_file_name("folia-images").join(id)).ok()?;
            (bytes.len() <= MAX_FOLIA_IMAGE_BYTES).then_some((mime, bytes))
        });
        serve_asset(&mut stream, asset);
        return;
    }
    if let Some(name) = path.strip_prefix("/assets/") {
        let asset = FOLIA_WORKERS.iter().find(|(worker, _)| *worker == name)
            .map(|(_, bytes)| ("text/javascript; charset=utf-8", bytes.to_vec()));
        serve_asset(&mut stream, asset);
        return;
    }
    if let Some(name) = path.strip_prefix("/jizura-assets/") {
        let asset = JIZURA_ASSETS.iter().find(|(asset, _)| *asset == name)
            .map(|(_, bytes)| {
                let mime = if name.ends_with(".js") {
                    "text/javascript; charset=utf-8"
                } else if name.ends_with(".css") {
                    "text/css; charset=utf-8"
                } else if name.ends_with(".json") {
                    "application/json"
                } else {
                    "text/plain; charset=utf-8"
                };
                (mime, bytes.to_vec())
            });
        if let Some((mime, bytes)) = asset {
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", bytes.len());
            let _ = stream.write_all(&bytes);
        } else {
            let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        return;
    }
    let (mime, body) = match path {
        "/lyrics" | "/lyrics/" => {
            let settings = settings_cache()
                .lock()
                .map(|settings| settings.clone())
                .unwrap_or_else(|_| Value::Null);
            ("text/html; charset=utf-8", lyrics_page_for_settings(&settings).to_string())
        }
        "/lyrics-preview" => (
            "text/html; charset=utf-8",
            regular_lyrics_page().to_string(),
        ),
        "/custom-lyrics" => (
            "text/html; charset=utf-8",
            r#"<!doctype html><html><head><meta charset="utf-8"></head><body><script>const html=decodeURIComponent(location.hash.slice(1));document.open();document.write(html);document.close();</script></body></html>"#.into(),
        ),
        "/folia" | "/folia/" => (
            "text/html; charset=utf-8",
            FOLIA_PAGE.into(),
        ),
        "/jizura" | "/jizura/" => ("text/html; charset=utf-8", JIZURA_PAGE.into()),
        "/folia.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../../folia-overlay/dist/folia.js").to_string(),
        ),
        "/folia.css" => (
            "text/css; charset=utf-8",
            include_str!("../../folia-overlay/dist/folia.css").to_string(),
        ),
        "/state" => {
            #[cfg(feature = "acceptance-tests")]
            if ACCEPTANCE_DROP_STATE.load(std::sync::atomic::Ordering::SeqCst) {
                ACCEPTANCE_DROPPED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return; // Close the real TCP request without a response.
            }
            let mut v = lyric_cache()
                .lock()
                .map(|v| v.clone())
                .unwrap_or_else(|_| json!({}));
            v["settings"] = settings_cache()
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|_| json!({}));
            v["audioSpectrum"] = crate::fx::latest_frame();
            v["playbackRate"] = json!(engine.speed());
            let native = engine.current.read().clone();
            if let Some(t) = native {
                let id =
                    t.id.map(|x| x.to_string())
                        .or_else(|| t.nid.map(|x| x.to_string()))
                        .or(t.qid.clone())
                        .or(t.kgid.clone())
                        .unwrap_or_else(|| t.path.clone());
                let key = format!("{}:{id}", t.kind);
                if v.get("trackKey").and_then(Value::as_str) != Some(key.as_str()) {
                    v["lyrics"] = Value::Null;
                }
                v["trackKey"] = json!(key);
                v["title"] = json!(t.title);
                v["artist"] = json!(t.artist);
                v["durationMs"] = json!(engine.dur_ms.load(std::sync::atomic::Ordering::Relaxed));
                v["positionMs"] = json!(engine.played_pos_ms());
                v["playing"] = json!(
                    !engine
                        .user_paused
                        .load(std::sync::atomic::Ordering::Relaxed)
                        && !engine.stopped.load(std::sync::atomic::Ordering::Relaxed)
                );
            } else {
                v["playing"] = json!(false);
                v["positionMs"] = json!(0);
                v["lyrics"] = Value::Null;
            }
            ("application/json", v.to_string())
        }
        _ => ("text/plain", "Not found".into()),
    };
    let status = if matches!(path, "/lyrics" | "/lyrics/" | "/lyrics-preview" | "/state" | "/custom-lyrics" | "/folia" | "/folia/" | "/folia.js" | "/folia.css" | "/jizura" | "/jizura/") {
        "200 OK"
    } else {
        "404 Not Found"
    };
    let cors = if path == "/state" { "Access-Control-Allow-Origin: *\r\n" } else { "" };
    if path == "/custom-lyrics" {
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src data: blob: http: https:; font-src data: blob: http: https:; connect-src http: https:; media-src data: blob: http: https:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
    } else {
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{cors}Connection: close\r\n\r\n{body}", body.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_settings(preset: &str) -> Value {
        json!({
            "preset": preset, "mode": "current-next", "motion": true, "css": "",
            "font": "Arial, sans-serif", "shadow": "0 2px 3px #000", "size": 42,
            "width": 900, "weight": 700, "align": "center", "color": "#ffffff",
            "strokeWidth": 0, "lineHeight": 1.25, "letterSpacing": 0,
            "translationSize": 23, "rows": 3, "offsetY": 0
        })
    }

    #[test]
    fn jizura_projects_preserve_original_combinations_without_changing_other_styles() {
        let mut settings = test_settings("jizura");
        let project = json!({
            "style": "noir", "seed": 135,
            "enabled": {"enter": {"assemble": true}, "exit": {"explode": true}},
            "overrides": {"2": {"lock": true, "customParameters": {"amount": 1.5}}}
        });
        settings["jizura"] = json!({"project": project, "transparent": true});
        assert!(validate_settings(&settings).is_ok());
        settings["preset"] = json!("folia-hanabi");
        assert!(validate_settings(&settings).is_ok(), "inactive JIZURA settings must survive switching styles");
        settings["jizura"]["transparent"] = json!("true");
        assert!(validate_settings(&settings).is_err());
        settings["jizura"] = json!({"project": "invalid"});
        assert!(validate_settings(&settings).is_err());
        settings["jizura"] = json!({"fontFiles": {"custom": "../secret.ttf"}});
        assert!(validate_settings(&settings).is_err(), "custom fonts must use imported file hashes");
        settings["jizura"] = json!({"analysis": {"beats": ["invalid"]}});
        assert!(validate_settings(&settings).is_err());
        settings["jizura"] = json!({"lineEffectsTrackKey": 12});
        assert!(validate_settings(&settings).is_err(), "per-line effects must be bound to a track key");
    }

    #[test]
    fn jizura_folia_and_html_have_separate_render_documents() {
        let jizura = lyrics_page_for_settings(&test_settings("jizura"));
        assert_eq!(jizura, JIZURA_PAGE);
        assert_ne!(jizura, lyrics_page_for_settings(&test_settings("folia-hanabi")));
        assert_ne!(jizura, regular_lyrics_page());
        assert!(!jizura.contains("/folia.js"));
    }

    #[test]
    fn audio_reactive_lyrics_enable_spectrum_without_enabling_it_for_html() {
        assert!(uses_audio_visualizer(&test_settings("jizura")));
        assert!(uses_audio_visualizer(&test_settings("folia-hanabi")));
        assert!(!uses_audio_visualizer(&test_settings("classic")));
        assert!(!uses_audio_visualizer(&test_settings("custom-html")));
    }

    #[test]
    fn fly_preset_is_accepted_for_persisted_lyrics_settings() {
        assert!(validate_settings(&test_settings("nowplaying-fly")).is_ok());
    }

    #[test]
    fn every_folia_lyrics_style_is_accepted_and_unknown_styles_are_rejected() {
        for preset in [
            "folia-cadenza", "folia-cappella", "folia-claddagh", "folia-classic",
            "folia-diorama", "folia-fume", "folia-hanabi", "folia-lumiere",
            "folia-machi", "folia-metaphor", "folia-monet", "folia-nebbia",
            "folia-partita", "folia-pendolo", "folia-prompt", "folia-sonnet",
            "folia-still", "folia-tempera", "folia-tilt",
        ] {
            assert!(validate_settings(&test_settings(preset)).is_ok(), "{preset} must persist");
        }
        assert!(validate_settings(&test_settings("folia-unknown")).is_err());
    }

    #[test]
    fn folia_tuning_presets_are_stored_separately_and_validated() {
        let mut settings = test_settings("folia-hanabi");
        settings["foliaTunings"] = json!({
            "hanabi": {"sparkAmount": 1.4, "textOnly": true},
            "nebbia": {"rain": "soft"}
        });
        assert!(validate_settings(&settings).is_ok());
        settings["foliaTunings"]["hanabi"] = json!(false);
        assert!(validate_settings(&settings).is_err());
        settings["foliaTunings"] = json!({"unknown": {"enabled": true}});
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn one_lyrics_url_selects_a_separate_folia_or_html_renderer() {
        let folia = lyrics_page_for_settings(&test_settings("folia-hanabi"));
        assert!(folia.contains("src=\"/folia.js\""));
        assert!(folia.contains("id=\"root\""));
        assert!(!folia.contains("obs-preview-settings"));

        let regular = lyrics_page_for_settings(&test_settings("custom-html"));
        assert!(regular.contains("id=\"lyrics\""));
        assert!(regular.contains("obs-preview-settings"));
        assert_ne!(folia, regular, "Folia and editable HTML must use distinct render documents behind the same OBS URL");
    }

    #[test]
    fn regular_preview_stays_available_when_saved_obs_style_is_folia() {
        let saved_folia = lyrics_page_for_settings(&test_settings("folia-partita"));
        let preview = regular_lyrics_page();

        assert!(saved_folia.contains("src=\"/folia.js\""));
        assert!(preview.contains("id=\"lyrics\""));
        assert!(preview.contains("obs-preview-settings"));
        assert!(!preview.contains("src=\"/folia.js\""));
    }

    #[test]
    fn particle_dissolve_is_accepted_without_a_website_style_pack() {
        let mut settings = test_settings("particle-dissolve");
        settings["particleSize"] = json!(5);
        settings["particleColor"] = json!("#ffe5a6");
        settings["particleGlow"] = json!(true);
        settings["particleGlowStrength"] = json!(60);
        settings["particleHdr"] = json!(true);
        settings["particleCount"] = json!(60);
        settings["particleLifetime"] = json!(900);
        settings["particleSpeed"] = json!(1.0);
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn new_effects_and_imported_fonts_persist_without_breaking_old_settings() {
        for preset in ["aurora", "hologram", "ripple", "danmaku"] {
            let mut settings = test_settings(preset);
            assert!(validate_settings(&settings).is_ok(), "old settings do not require a font import");
            settings["fontFile"] = json!(format!("{}.woff2", "a".repeat(64)));
            settings["fontName"] = json!("自选字体");
            assert!(validate_settings(&settings).is_ok());
            for invalid in ["../../private.ttf", "https://example.test/font.woff2", "bad.ttf", ""] {
                settings["fontFile"] = json!(invalid);
                assert_eq!(validate_settings(&settings).is_ok(), invalid.is_empty(), "only opaque local font IDs may persist");
            }
        }
        let mut settings = test_settings("danmaku");
        for widget in ["preset", "none", "stars", "notes", "bars", "bounce"] {
            settings["widget"] = json!(widget);
            assert!(validate_settings(&settings).is_ok());
        }
        settings["widget"] = json!("unknown");
        assert!(validate_settings(&settings).is_err(), "unknown widget IDs must not silently persist");
    }

    #[test]
    fn particle_settings_accept_supported_values_and_reject_out_of_range_values() {
        let mut settings = test_settings("classic");
        settings["particleSize"] = json!(5);
        settings["particleColor"] = json!("#ffe5a6");
        settings["particleGlow"] = json!(true);
        settings["particleGlowStrength"] = json!(60);
        settings["particleHdr"] = json!(true);
        settings["particleCount"] = json!(60);
        settings["particleLifetime"] = json!(900);
        settings["particleSpeed"] = json!(1.0);
        assert!(validate_settings(&settings).is_ok());

        for (key, value) in [
            ("particleSize", json!(21)),
            ("particleSize", json!(0.19)),
            ("particleCount", json!(101)),
            ("particleLifetime", json!(199)),
            ("particleSpeed", json!(2.6)),
            ("particleGlowStrength", json!(101)),
            ("particleColor", json!("red")),
            ("particleGlow", json!("yes")),
            ("particleHdr", json!("yes")),
        ] {
            let mut invalid = settings.clone();
            invalid[key] = value;
            assert!(validate_settings(&invalid).is_err(), "{key} must stay within its UI range");
        }
        settings["particleSize"] = json!(0.2);
        assert!(validate_settings(&settings).is_ok(), "subpixel particles can be saved at the minimum size");
        settings["particleSize"] = json!(5);
        settings["particleGlowStrength"] = json!(0);
        assert!(validate_settings(&settings).is_ok(), "glow intensity can be fully disabled while preserving the particle glow toggle");
        settings["particleGlowStrength"] = json!(100);
        assert!(validate_settings(&settings).is_ok(), "maximum glow intensity can be saved");
    }

    #[test]
    fn custom_animation_and_folia_glow_settings_survive_validation() {
        let mut settings = test_settings("classic");
        settings["htmlTuningEnabled"] = json!(false);
        settings["foliaAppearance"] = json!({"glowColors":{"partita":"#ff2244","monet":"#123abc"}});
        assert!(validate_settings(&settings).is_ok(), "disabling customization must preserve each style's saved colors");
        settings["htmlTuningEnabled"] = json!("false");
        assert!(validate_settings(&settings).is_err(), "a text value must not silently enable customization");
        settings["htmlTuningEnabled"] = json!(true);
        settings["foliaAppearance"]["glowColors"]["partita"] = json!("red");
        assert!(validate_settings(&settings).is_err(), "only colors supported by the picker may be stored");
    }

    #[test]
    fn lyric_dissolve_glow_danmaku_and_bounce_settings_are_bounded() {
        let mut settings = test_settings("danmaku");
        settings["widget"] = json!("bounce");
        settings["particleColorIntensity"] = json!(10);
        settings["particleFragmentation"] = json!(100);
        settings["particleEdgeHighlight"] = json!(true);
        settings["lyricGlowStrength"] = json!(10);
        settings["danmakuShadow"] = json!("#123456");
        settings["danmakuAccent"] = json!("#234567");
        settings["danmakuGlow"] = json!("#345678");
        settings["danmakuStroke"] = json!("#456789");
        settings["danmakuStrokeWidth"] = json!(8);
        settings["bounceTrailType"] = json!("particles");
        settings["bounceTrailDuration"] = json!(3000);
        settings["bounceTrailLength"] = json!(500);
        assert!(validate_settings(&settings).is_ok());

        for (key, value) in [
            ("particleColorIntensity", json!(10.1)),
            ("particleFragmentation", json!(-1)),
            ("particleEdgeHighlight", json!("yes")),
            ("lyricGlowStrength", json!(10.1)),
            ("danmakuShadow", json!("violet")),
            ("danmakuStrokeWidth", json!(8.1)),
            ("bounceTrailType", json!("ribbon")),
            ("bounceTrailDuration", json!(3001)),
            ("bounceTrailLength", json!(501)),
        ] {
            let mut invalid = settings.clone();
            invalid[key] = value;
            assert!(validate_settings(&invalid).is_err(), "{key} must reject values outside the UI contract");
        }

        let mut legacy = test_settings("classic");
        assert!(validate_settings(&legacy).is_ok(), "old settings remain valid when new controls use frontend defaults");
        legacy["widget"] = json!("bounce");
        assert!(validate_settings(&legacy).is_ok(), "the per-character bounce widget persists");
    }

    #[test]
    fn copied_fonts_survive_the_import_call_and_are_served_as_binary() {
        let directory = std::env::temp_dir().join(format!("rustmusic-font-copy-{}", std::process::id()));
        let mut bytes = vec![0xff; 64];
        bytes[..4].copy_from_slice(&[0, 1, 0, 0]);
        let font = store_font(&directory, "中文字体.TTF", &STANDARD.encode(&bytes)).unwrap();
        let id = font["fontFile"].as_str().unwrap().to_owned();
        assert_eq!(font["fontName"], "中文字体");
        assert_eq!(store_font(&directory, "another.ttf", &STANDARD.encode(&bytes)).unwrap()["fontFile"], id);
        assert_eq!(read_font(&directory, &id).unwrap(), ("font/ttf", bytes.clone()));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let font_directory = directory.clone();
        let font_id = id.clone();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            serve_asset(&mut stream, read_font(&font_directory, &font_id));
        });
        let mut client = TcpStream::connect(address).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        worker.join().unwrap();
        let header_end = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let headers = String::from_utf8_lossy(&response[..header_end]);
        assert!(headers.contains("Content-Type: font/ttf"));
        assert!(headers.contains("Access-Control-Allow-Origin: *"));
        assert_eq!(&response[header_end..], bytes, "HTTP must not corrupt non-UTF8 font bytes");
        fs::remove_file(directory.join(id)).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn invalid_fonts_and_path_traversal_never_expose_other_files() {
        let directory = std::env::temp_dir().join(format!("rustmusic-font-reject-{}", std::process::id()));
        for (name, data) in [("fake.ttf", STANDARD.encode(b"not a font")), ("font.exe", STANDARD.encode([0, 1, 0, 0])), ("font.ttf", "!".into())] {
            assert!(store_font(&directory, name, &data).is_err());
        }
        assert!(store_font(&directory, "large.ttf", &"A".repeat(MAX_FONT_BYTES.div_ceil(3) * 4 + 1)).is_err());
        assert!(!directory.exists(), "rejected imports must not create persisted files");
        for id in ["../font.ttf", "..\\font.ttf", "%2e%2e/font.ttf", "C:\\Windows\\Fonts\\arial.ttf", "https://example.test/font.woff2"] {
            assert!(read_font(&directory, id).is_none());
        }
    }
}
