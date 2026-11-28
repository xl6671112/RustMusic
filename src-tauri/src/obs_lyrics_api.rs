use crate::{obs_lyrics, AppState};
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{json, Value};
use std::{io::{Read, Write}, net::TcpListener, sync::{Mutex, OnceLock}, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};

const ADDRESS: &str = "127.0.0.1:17844";
const API_URL: &str = "http://127.0.0.1:17844";
const MAX_BODY: usize = 8 * 1024 * 1024;
static SERVER_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
const DEFAULT_SETTINGS: &str = include_str!("../../docs/obs-lyrics-api-defaults.json");
const FOLIA_CATALOG: &str = include_str!("../../docs/obs-lyrics-api-folia.json");
const STYLE_FIELDS: &[&str] = &["htmlTuningEnabled","size","width","color","weight","align","font","fontFile","fontName","stroke","strokeWidth","shadow","lineHeight","letterSpacing","translationSize","rows","offsetY","rawEffectsEnabled","rawShadow","rawAccent","rawGlow","rawStroke","rawStrokeWidth"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInfo { url: &'static str, api_key: String, enabled: bool, error: Option<String> }

fn setting(conn: &rusqlite::Connection, name: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [name], |r| r.get(0)).optional().map_err(|e| e.to_string())
}
fn write_setting(conn: &rusqlite::Connection, name: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [name, value]).map_err(|e| e.to_string())?;
    Ok(())
}
fn new_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn api_info(state: &AppState) -> Result<ApiInfo, String> {
    let conn = state.db.lock();
    let key = match setting(&conn, "obs_lyrics_api_key")? {
        Some(key) => key,
        None => { let key = new_key(); write_setting(&conn, "obs_lyrics_api_key", &key)?; key }
    };
    Ok(ApiInfo { url: API_URL, api_key: key, enabled: setting(&conn, "obs_lyrics_api_enabled")?.as_deref() != Some("false"),
        error: SERVER_ERROR.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|e| e.clone()) })
}

#[tauri::command]
pub fn get_obs_lyrics_api(state: State<'_, AppState>) -> Result<ApiInfo, String> { api_info(&state) }
#[tauri::command]
pub fn set_obs_lyrics_api_enabled(state: State<'_, AppState>, enabled: bool) -> Result<ApiInfo, String> {
    write_setting(&state.db.lock(), "obs_lyrics_api_enabled", if enabled { "true" } else { "false" })?;
    api_info(&state)
}
#[tauri::command]
pub fn rotate_obs_lyrics_api_key(state: State<'_, AppState>) -> Result<ApiInfo, String> {
    write_setting(&state.db.lock(), "obs_lyrics_api_key", &new_key())?;
    api_info(&state)
}

pub fn start(app: AppHandle) {
    let start = || -> Result<TcpListener, String> {
        api_info(&app.state::<AppState>())?;
        TcpListener::bind(ADDRESS).map_err(|e| format!("本机歌词 API 无法监听 {ADDRESS}：{e}"))
    };
    let listener = match start() {
        Ok(listener) => listener,
        Err(error) => { eprintln!("{error}"); *SERVER_ERROR.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(error); return; }
    };
    thread::Builder::new().name("obs-lyrics-api".into()).spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
            let result = read_request(&mut stream).and_then(|request| dispatch(&app, request));
            match result {
                Ok((mime, body)) => respond(&mut stream, 200, mime, &body),
                Err((status, error)) => respond(&mut stream, status, "application/json; charset=utf-8", &json!({"error":error}).to_string()),
            }
        }
    }).expect("start local lyrics API");
}

type ApiError = (u16, String);
struct Request { method: String, path: String, authorization: String, body: Vec<u8> }
fn read_request(reader: &mut impl Read) -> Result<Request, ApiError> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") { break index + 4; }
        if bytes.len() > 16 * 1024 { return Err((431, "请求头过大".into())); }
        let mut chunk = [0; 4096];
        let size = reader.read(&mut chunk).map_err(|_| (400, "请求读取失败或超时".into()))?;
        if size == 0 { return Err((400, "请求不完整".into())); }
        bytes.extend_from_slice(&chunk[..size]);
    };
    if header_end > 16 * 1024 { return Err((431, "请求头过大".into())); }
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|_| (400, "请求头无效".into()))?;
    let mut lines = headers.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" { return Err((400, "请使用 HTTP/1.1".into())); }
    let method = parts[0].to_string(); let path = parts[1].to_string();
    let mut host = None; let mut authorization = None; let mut length = None;
    let mut content_type = "";
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':').ok_or((400, "请求头无效".into()))?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "host" => { if host.replace(value).is_some() { return Err((400, "重复 Host".into())); } },
            "authorization" => { if authorization.replace(value).is_some() { return Err((400, "重复认证信息".into())); } },
            "content-length" => {
                let parsed = value.parse::<usize>().map_err(|_| (400, "Content-Length 无效".into()))?;
                if length.replace(parsed).is_some() { return Err((400, "重复 Content-Length".into())); }
            },
            "transfer-encoding" => return Err((400, "请使用 Content-Length，不支持分块请求".into())),
            "origin" => return Err((403, "仅接受本机工具直接调用".into())),
            "content-type" => content_type = value,
            _ => {}
        }
    }
    if !matches!(host, Some("127.0.0.1:17844" | "localhost:17844")) { return Err((403, "Host 无效".into())); }
    let size = length.unwrap_or(0);
    if size > MAX_BODY { return Err((413, "请求最大 8 MB".into())); }
    if size > 0 && content_type.split(';').next() != Some("application/json") { return Err((415, "请发送 application/json".into())); }
    let authorization = authorization.unwrap_or("").to_string();
    let mut body = bytes[header_end..].to_vec();
    if body.len() > size { return Err((400, "请求长度不匹配".into())); }
    let received = body.len(); body.resize(size, 0);
    reader.read_exact(&mut body[received..]).map_err(|_| (400, "请求正文不完整或超时".into()))?;
    Ok(Request { method, path, authorization, body })
}
fn respond(stream: &mut impl Write, status: u16, mime: &str, body: &str) {
    let reason = match status { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 409 => "Conflict", 413 => "Content Too Large", 415 => "Unsupported Media Type", 431 => "Request Header Fields Too Large", 503 => "Service Unavailable", _ => "Internal Server Error" };
    let auth = if status == 401 { "WWW-Authenticate: Bearer\r\n" } else { "" };
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'\r\n{auth}Connection: close\r\n\r\n{body}", body.len());
}
fn authorized(header: &str, key: &str) -> bool {
    let Some(value) = header.strip_prefix("Bearer ") else { return false; };
    value.len() == key.len() && value.bytes().zip(key.bytes()).fold(0u8, |different, (a,b)| different | (a ^ b)) == 0
}
fn saved_json(state: &AppState, name: &str, default: &str) -> Result<Value, ApiError> {
    let raw = setting(&state.db.lock(), name).map_err(|e| (500, e))?;
    serde_json::from_str(raw.as_deref().filter(|s| !s.is_empty()).unwrap_or(default)).map_err(|_| (500, "已保存数据格式无效".into()))
}
fn merge(value: &mut Value, patch: Value) {
    if let (Some(target), Some(source)) = (value.as_object_mut(), patch.as_object()) {
        for (key, next) in source { merge(target.entry(key).or_insert(Value::Null), next.clone()); }
    } else { *value = patch; }
}
fn update_style_values(settings: &mut Value) {
    let active = settings.get("localStyleId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(|id| format!("local:{id}"))
        .or_else(|| settings.get("officialStyleId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(|id| format!("official:{id}")))
        .unwrap_or_else(|| match settings["preset"].as_str().unwrap_or("classic") { "particle-dissolve" => "classic", preset => preset }.to_string());
    let values = STYLE_FIELDS.iter().filter_map(|field| settings.get(*field).cloned().map(|value| (field.to_string(), value))).collect::<serde_json::Map<_,_>>();
    if !settings["styleSettings"].is_object() { settings["styleSettings"] = json!({}); }
    settings["styleSettings"][active] = Value::Object(values);
}
fn template_settings(mut settings: Value) -> Result<Value, ApiError> {
    let fields = settings.as_object_mut().ok_or((400, "模板设置必须是 JSON 对象".into()))?;
    fields.remove("localStyleId");
    fields.remove("styleSettings");
    if settings["preset"] == "custom-html" { settings["preset"] = json!("classic"); settings["customHtmlEnabled"] = json!(true); }
    update_style_values(&mut settings);
    obs_lyrics::validate_obs_lyrics_template(settings.clone()).map_err(|e| (400, e))?;
    Ok(settings)
}
fn apply_template(settings: Value, current: &Value, id: &str) -> Result<Value, ApiError> {
    let mut settings = template_settings(settings)?;
    settings["localStyleId"] = json!(id);
    settings["styleSettings"] = current.get("styleSettings").filter(|value| value.is_object()).cloned().unwrap_or(json!({}));
    update_style_values(&mut settings);
    Ok(settings)
}
fn patch_settings(mut current: Value, patch: Value) -> Result<Value, ApiError> {
    let changes = patch.as_object().ok_or((400, "设置修改必须是 JSON 对象".into()))?;
    const FIELDS: &str = "preset mode lyricTimeline motion widget css customHtml customHtmlEnabled customHtmlValues size width color weight align font fontFile fontName stroke strokeWidth shadow lineHeight letterSpacing translationSize rows offsetY particleDissolve particleSize particleColor particleColorIntensity particleGlow particleGlowStrength particleHdr particleCount particleLifetime particleSpeed particleFragmentation particleEdgeHighlight lyricGlowStrength rawEffectsEnabled rawShadow rawAccent rawGlow rawStroke rawStrokeWidth bounceTrailType bounceTrailDuration bounceTrailLength htmlTuningEnabled jizura officialCss officialStyleId officialStyleVersion autoUpdateStyles foliaTunings foliaTuningEnabled foliaAppearance foliaAssets";
    for key in changes.keys() {
        if !FIELDS.split_whitespace().any(|field| field == key) { return Err((400, format!("不支持修改字段：{key}"))); }
    }
    merge(&mut current, patch);
    if current["preset"] == "custom-html" { current["preset"] = json!("classic"); current["customHtmlEnabled"] = json!(true); }
    update_style_values(&mut current);
    obs_lyrics::validate_obs_lyrics_template(current.clone()).map_err(|e| (400, e))?;
    Ok(current)
}

fn dispatch(app: &AppHandle, request: Request) -> Result<(&'static str, String), ApiError> {
    if request.method == "GET" && matches!(request.path.as_str(), "/" | "/docs") { return Ok(("text/html; charset=utf-8", DOCS.into())); }
    if request.method == "GET" && request.path == "/openapi.json" { return Ok(("application/json; charset=utf-8", openapi().to_string())); }
    let state = app.state::<AppState>();
    let info = api_info(&state).map_err(|e| (500, e))?;
    if !info.enabled { return Err((503, "本机 AI 歌词控制已关闭".into())); }
    if !authorized(&request.authorization, &info.api_key) { return Err((401, "API Key 无效，请使用 Authorization: Bearer <API Key>".into())); }
    let body = || serde_json::from_slice::<Value>(&request.body).map_err(|_| (400, "JSON 正文无效".into()));
    let output = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/settings") => saved_json(&state, "obs_lyrics_settings", DEFAULT_SETTINGS)?,
        ("PATCH", "/settings") => {
            let settings = patch_settings(saved_json(&state, "obs_lyrics_settings", DEFAULT_SETTINGS)?, body()?)?;
            obs_lyrics::update_settings(&state, settings.to_string()).map_err(|e| (500, e))?;
            app.emit("obs-lyrics-settings-changed", ()).map_err(|e| (500, e.to_string()))?;
            settings
        },
        ("GET", "/catalog/jizura") => serde_json::from_str(include_str!("../../jizura-overlay/dist/catalog.json")).map_err(|e| (500, e.to_string()))?,
        ("GET", "/catalog/folia") => serde_json::from_str(FOLIA_CATALOG).map_err(|e| (500, e.to_string()))?,
        ("GET", "/templates") => saved_json(&state, "obs_lyrics_templates", "[]")?,
        ("POST", "/templates") => {
            let input = body()?;
            let name = input["name"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.chars().count() <= 80).ok_or((400, "模板名称须为 1–80 个字".into()))?;
            let mut templates = saved_json(&state, "obs_lyrics_templates", "[]")?.as_array().cloned().ok_or((500, "已保存模板格式无效".into()))?;
            if templates.iter().any(|template| template["name"] == name) { return Err((409, "已有同名模板，请换一个名称".into())); }
            let settings = template_settings(if let Some(settings) = input.get("settings") { settings.clone() } else { saved_json(&state, "obs_lyrics_settings", DEFAULT_SETTINGS)? })?;
            let template = json!({"id":new_key(),"name":name,"settings":settings});
            templates.push(template.clone());
            save_templates(&state, app, &Value::Array(templates))?;
            template
        },
        _ => {
            let Some(path) = request.path.strip_prefix("/templates/") else { return Err((404, "接口不存在，请先阅读 API 首页".into())); };
            let mut templates = saved_json(&state, "obs_lyrics_templates", "[]")?.as_array().cloned().ok_or((500, "已保存模板格式无效".into()))?;
            let id = path.strip_suffix("/apply").unwrap_or(path);
            let index = templates.iter().position(|template| template["id"] == id).ok_or((404, "找不到模板".into()))?;
            if request.method == "POST" && path.ends_with("/apply") {
                let current = saved_json(&state, "obs_lyrics_settings", DEFAULT_SETTINGS)?;
                let settings = apply_template(templates[index]["settings"].clone(), &current, id)?;
                obs_lyrics::update_settings(&state, settings.to_string()).map_err(|e| (500, e))?;
                app.emit("obs-lyrics-settings-changed", ()).map_err(|e| (500, e.to_string()))?;
                settings
            } else if request.method == "DELETE" && !path.contains('/') {
                templates.remove(index);
                save_templates(&state, app, &Value::Array(templates))?;
                json!({"deleted":id})
            } else { return Err((404, "接口不存在".into())); }
        }
    };
    Ok(("application/json; charset=utf-8", output.to_string()))
}
fn save_templates(state: &AppState, app: &AppHandle, templates: &Value) -> Result<(), ApiError> {
    let raw = templates.to_string();
    obs_lyrics::validate_templates(&raw).map_err(|e| (400, e))?;
    write_setting(&state.db.lock(), "obs_lyrics_templates", &raw).map_err(|e| (500, e))?;
    app.emit("obs-lyrics-templates-changed", ()).map_err(|e| (500, e.to_string()))?;
    Ok(())
}

fn inferred_schema(value: &Value) -> Value {
    match value {
        Value::Object(items) => json!({"type":"object","properties":items.iter().map(|(key,value)| (key.clone(),inferred_schema(value))).collect::<serde_json::Map<_,_>>()}),
        Value::Array(items) => json!({"type":"array","items":items.first().map(inferred_schema).unwrap_or(json!({}))}),
        Value::Bool(_) => json!({"type":"boolean","default":value}),
        Value::Number(_) => json!({"type":"number","default":value}),
        Value::String(_) => json!({"type":"string","default":value}),
        Value::Null => json!({"type":"string","nullable":true}),
    }
}
fn settings_schema() -> Value {
    let mut schema = inferred_schema(&serde_json::from_str::<Value>(DEFAULT_SETTINGS).unwrap());
    let fields = schema["properties"].as_object_mut().unwrap();
    let enumeration = |choices: &str| json!({"type":"string","enum":choices.split_whitespace().collect::<Vec<_>>()});
    let color = json!({"type":"string","pattern":"^#[a-fA-F0-9]{6}$"});
    fields.insert("preset".into(), enumeration("classic karaoke neon minimal stage nowplaying nowplaying-liquid nowplaying-skeuo nowplaying-fly aurora hologram ripple danmaku jizura folia-cadenza folia-cappella folia-claddagh folia-classic folia-diorama folia-fume folia-hanabi folia-lumiere folia-machi folia-metaphor folia-monet folia-nebbia folia-partita folia-pendolo folia-prompt folia-sonnet folia-still folia-tempera folia-tilt"));
    for (field, choices) in [("mode","current current-next multi"),("lyricTimeline","original split"),("align","left center right"),("widget","preset none stars notes bars bounce"),("bounceTrailType","none single double particles")] { fields.insert(field.into(),enumeration(choices)); }
    for (field,min,max) in [("size",12.0,120.0),("width",240.0,3000.0),("strokeWidth",0.0,8.0),("lineHeight",1.0,3.0),("letterSpacing",-2.0,20.0),("translationSize",10.0,80.0),("rows",1.0,8.0),("offsetY",-500.0,500.0),("particleSize",0.2,20.0),("particleCount",1.0,100.0),("particleLifetime",200.0,3000.0),("particleSpeed",0.5,2.5),("particleGlowStrength",0.0,100.0),("particleColorIntensity",0.0,10.0),("particleFragmentation",0.0,100.0),("lyricGlowStrength",0.0,10.0),("bounceTrailDuration",100.0,3000.0),("bounceTrailLength",0.0,500.0)] {
        fields.insert(field.into(),json!({"type":if matches!(field,"size"|"width") {"integer"} else {"number"},"minimum":min,"maximum":max}));
    }
    fields.insert("weight".into(),json!({"type":"integer","enum":[400,600,700,800]}));
    for field in ["color","stroke","particleColor","rawShadow","rawAccent","rawGlow","rawStroke"] { fields.insert(field.into(),color.clone()); }
    fields.insert("css".into(),json!({"type":"string","maxLength":60000}));
    fields.insert("customHtml".into(),json!({"type":"string","maxLength":12000,"description":"须包含 data-rustmusic-slot=current；HTML 控件标记与原歌词编辑器相同"}));
    fields.insert("customHtmlValues".into(),json!({"type":"object","additionalProperties":{"oneOf":[color.clone(),{"type":"number"}]}}));
    fields.insert("htmlTuningEnabled".into(),json!({"type":"boolean"}));
    let font_file = json!({"type":"string","pattern":"^[a-f0-9]{64}\\.(ttf|otf|woff|woff2)$"});
    let mut appearance = json!({"type":"object","properties":{},"additionalProperties":false});
    let a = appearance["properties"].as_object_mut().unwrap();
    for field in ["primaryColor","accentColor","secondaryColor"] { a.insert(field.into(),color.clone()); }
    a.insert("glowColors".into(),json!({"type":"object","maxProperties":20,"additionalProperties":color}));
    for field in ["fontFile","subtitleFontFile"] { a.insert(field.into(),font_file.clone()); }
    for field in ["fontStyle","subtitleFontStyle"] { a.insert(field.into(),enumeration("sans serif mono")); }
    for field in ["fontFamily","subtitleFontFamily"] { a.insert(field.into(),json!({"type":"string"})); }
    for field in ["fontWeight","subtitleFontWeight"] { a.insert(field.into(),json!({"type":"number"})); }
    for field in ["lyricsFontScale","subtitleFontScale"] { a.insert(field.into(),json!({"type":"number","minimum":0.85,"maximum":1.4})); }
    for field in ["visualizerOpacity","subtitleOverlayOpacity"] { a.insert(field.into(),json!({"type":"number","minimum":0.2,"maximum":1.0})); }
    for field in ["showOriginalBackground","subtitleFontInheritsLyrics","subtitleOverlayBackground","subtitleUpcomingLyricsBlur","hideTranslationSubtitle","showHarmonySubtitle","harmonySubtitleBackground"] { a.insert(field.into(),json!({"type":"boolean"})); }
    a.insert("subtitleContentMode".into(),enumeration("translation romanization both none"));
    a.insert("subtitleOverlayLayout".into(),json!({"type":"string","pattern":"^(current|translation|romanization)(\\+(next|translation|romanization)){0,2}(\\|only)?$"}));
    a.insert("renderQuality".into(),json!({"type":"object","properties":{"scale":{"type":"number","enum":[0.5,0.75,1,1.5,2]},"antialias":enumeration("auto on off")}}));
    fields.insert("foliaAppearance".into(),appearance);
    let catalog: Value = serde_json::from_str(FOLIA_CATALOG).unwrap();
    let mut modes = serde_json::Map::new();
    for (mode,item) in catalog.as_object().unwrap() {
        let mut tuning = inferred_schema(&item["defaults"]);
        for (key,field) in item["fields"].as_object().unwrap() {
            tuning["properties"][key] = match field["type"].as_str() {
                Some("number") => { let mut s = json!({"type":"number","minimum":field["min"],"maximum":field["max"]}); if let Some(step) = field.get("step") { s["multipleOf"] = step.clone(); } s },
                Some("boolean") => json!({"type":"boolean"}),
                Some("choice") => json!({"type":"string","enum":field["options"]}),
                _ => inferred_schema(&item["defaults"][key]),
            };
        }
        modes.insert(mode.clone(),tuning);
    }
    fields.insert("foliaTunings".into(),json!({"type":"object","properties":modes,"additionalProperties":false,"description":"字段、默认值与可调整范围来自原版 tuning.ts；GET /catalog/folia 返回原始目录"}));
    fields.insert("foliaTuningEnabled".into(),json!({"type":"object","additionalProperties":{"type":"boolean"}}));
    let image = json!({"type":"array","maxItems":30,"items":{"type":"object","required":["id","name","file"],"properties":{"id":{"type":"string","minLength":1,"maxLength":120},"name":{"type":"string","maxLength":120},"file":{"type":"string","pattern":"^[a-f0-9]{64}\\.(png|jpg|webp|gif)$"}}}});
    fields.insert("foliaAssets".into(),json!({"type":"object","properties":{"monet":image,"emoji":image,"avatar":image,"tempera":image},"additionalProperties":false}));
    let catalog: Value = serde_json::from_str(include_str!("../../jizura-overlay/dist/catalog.json")).unwrap();
    let mut project = inferred_schema(&catalog["defaults"]);
    let p = project["properties"].as_object_mut().unwrap();
    for (field,catalog_field) in [("style","styles"),("mood","moods"),("themeId","themes")] {
        p.insert(field.into(),json!({"type":"string","nullable":field!="style","enum":catalog[catalog_field].as_array().unwrap().iter().map(|item|item["id"].clone()).collect::<Vec<_>>() }));
    }
    for field in ["motion","glitch","chroma","decor","density","texture","bgSwitch"] { p.get_mut("fx").unwrap()["properties"][field] = json!({"type":"number","minimum":0,"maximum":1}); }
    let color = json!({"type":"string","pattern":"^#[a-fA-F0-9]{6}$"});
    p.insert("colors".into(),json!({"type":"object","properties":{"enabled":{"type":"boolean"},"accentOn":{"type":"boolean"},"bg":color,"fg":color,"sub":color,"accent":color,"ghostA":color,"ghostB":color}}));
    let font = json!({"type":"string","description":"GET /catalog/jizura 的 fonts.id 或 project.userFonts[].key，空字符串跟随风格"});
    p.insert("fonts".into(),json!({"type":"object","properties":{"display":font,"serif":font,"body":font,"mono":font}}));
    p.insert("userFonts".into(),json!({"type":"array","items":{"type":"object","required":["key","label","family","weight"],"properties":{"key":{"type":"string"},"label":{"type":"string"},"family":{"type":"string"},"weight":{"type":"number"}}}}));
    fields.insert("jizura".into(),json!({"type":"object","properties":{"transparent":{"type":"boolean"},"project":project,"fontFiles":{"type":"object","maxProperties":100,"additionalProperties":font_file},"sourceTrackKey":{"type":"string"},"lineEffectsTrackKey":{"type":"string"},"analysis":{"type":"object","description":"当前歌曲分析，AI 调整样式时保留原值","properties":{"duration":{"type":"number"},"bpm":{"type":"number"},"energyRate":{"type":"number"},"sourceTrackKey":{"type":"string"},"beats":{"type":"array","maxItems":1000000,"items":{"type":"number"}},"energy":{"type":"array","maxItems":1000000,"items":{"type":"number"}}}}}}));
    fields.insert("officialCss".into(),json!({"type":"string","maxLength":6000}));
    for field in ["officialStyleId","officialStyleVersion"] { fields.insert(field.into(),json!({"type":"string"})); }
    schema["additionalProperties"] = json!(false);
    schema
}

fn openapi() -> Value {
    let security = json!([{"ApiKey":[]}]);
    let operation = |summary: &str| json!({"summary":summary,"security":security,"responses":{"200":{"description":"成功，返回 JSON"},"400":{"description":"参数无效，修改未保存"},"401":{"description":"密钥无效"},"503":{"description":"API 已关闭"}}});
    let mut patch = operation("递归合并并立即保存 OBS 歌词设置；同名数组整体替换");
    patch["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/LyricsSettings"},"example":{"preset":"folia-hanabi","foliaAppearance":{"primaryColor":"#ffffff","accentColor":"#00ddaa","glowColors":{"hanabi":"#33ffaa"}},"foliaTuningEnabled":{"hanabi":true}}}}});
    let mut create = operation("另存歌词模板；不填 settings 时保存当前设置");
    create["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":{"type":"object","required":["name"],"properties":{"name":{"type":"string","minLength":1,"maxLength":80},"settings":{"$ref":"#/components/schemas/LyricsSettings"}}}}}});
    let mut apply = operation("立即应用已保存模板");
    apply["parameters"] = json!([{"name":"id","in":"path","required":true,"schema":{"type":"string"}}]);
    let mut delete = operation("删除一个已保存模板"); delete["parameters"] = apply["parameters"].clone();
    json!({"openapi":"3.0.3","info":{"title":"RustMusic 本机 OBS 歌词 API","version":"1.0.0","description":"只控制本机 OBS 歌词。先 GET /settings，按需 PATCH；所有修改立即持久保存并同步 OBS。HTML、Folia、JIZURA 均支持。详细参数、示例和限制见 API 首页。"},"servers":[{"url":API_URL}],"components":{"securitySchemes":{"ApiKey":{"type":"http","scheme":"bearer"}},"schemas":{"LyricsSettings":settings_schema()}},"paths":{
        "/settings":{"get":operation("读取当前 OBS 歌词设置"),"patch":patch},
        "/catalog/jizura":{"get":operation("读取 JIZURA 默认配置、配色、字体和全部效果组合目录")},
        "/catalog/folia":{"get":operation("读取 Folia 19 种模式的真实默认动画参数、开关、选项与范围")},
        "/templates":{"get":operation("读取已保存模板"),"post":create},
        "/templates/{id}/apply":{"post":apply},"/templates/{id}":{"delete":delete}
    }})
}

const DOCS: &str = include_str!("../../docs/obs-lyrics-api.html");

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn rejects_browser_and_ambiguous_http_requests() {
        for header in ["Origin: https://example.com\r\n", "Host: evil.example\r\n", "Content-Length: 1\r\nContent-Length: 1\r\n", "Transfer-Encoding: chunked\r\n"] {
            let raw = format!("GET /settings HTTP/1.1\r\nHost: {ADDRESS}\r\n{header}\r\n");
            assert!(read_request(&mut Cursor::new(raw)).is_err(), "a website or ambiguous framing must not reach the control API");
        }
    }
    #[test]
    fn reads_the_entire_body_and_rejects_truncated_settings() {
        let data = "{\"customHtml\":\"".to_string() + &"a".repeat(9000) + "\"}";
        let raw = format!("PATCH /settings HTTP/1.1\r\nHost: {ADDRESS}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{data}", data.len());
        assert_eq!(read_request(&mut Cursor::new(raw.as_bytes())).unwrap().body, data.as_bytes(), "large HTML must not be silently truncated to the first read");
        assert!(read_request(&mut Cursor::new(&raw.as_bytes()[..raw.len()-1])).is_err(), "incomplete HTML must never be saved");
    }
    #[test]
    fn bearer_auth_does_not_accept_missing_or_old_keys() {
        assert!(authorized("Bearer new-key", "new-key"));
        assert!(!authorized("Bearer old-key", "new-key"));
        assert!(!authorized("new-key", "new-key"));
    }
    #[test]
    fn nested_visual_edits_preserve_combinations_and_survive_frontend_reload() {
        let mut initial: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap();
        initial["styleSettings"] = json!({"classic":{"color":"#ff0000"}});
        initial["jizura"] = json!({"transparent":true,"project":{"fx":{"motion":0.8,"glitch":0.1},"enabled":{"enter":{"assemble":true}}}});
        let changed = patch_settings(initial, json!({"color":"#11ff22","jizura":{"project":{"fx":{"glitch":0.3}}}})).unwrap();
        assert_eq!(changed["jizura"]["project"]["fx"]["motion"], 0.8);
        assert_eq!(changed["jizura"]["project"]["enabled"]["enter"]["assemble"], true);
        assert_eq!(changed["styleSettings"]["classic"]["color"], "#11ff22", "the editor must not restore a stale per-style color after API changes");
        assert!(patch_settings(changed.clone(), json!({"size":999})).is_err());
        assert!(patch_settings(changed, json!({"account":{}})).is_err(), "the lyrics API must not accept unrelated application settings");
    }
    #[test]
    fn local_style_edits_update_its_cache_without_changing_original_styles() {
        let mut initial: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap();
        initial["localStyleId"] = json!("saved-style");
        initial["officialStyleId"] = json!("official-style");
        initial["styleSettings"] = json!({"local:saved-style":{"color":"#ff0000"},"official:official-style":{"color":"#123456"}});
        let changed = patch_settings(initial, json!({"color":"#11ff22"})).unwrap();
        assert_eq!(changed["styleSettings"]["local:saved-style"]["color"], "#11ff22", "reopening the editor must retain AI changes to the selected saved style");
        assert_eq!(changed["styleSettings"]["official:official-style"]["color"], "#123456", "editing a saved copy must preserve its original style cache");
    }
    #[test]
    fn new_template_discards_source_identity_and_stale_style_caches() {
        let mut initial: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap();
        initial["localStyleId"] = json!("source-style");
        initial["color"] = json!("#11ff22");
        initial["styleSettings"] = json!({"local:source-style":{"color":"#ff0000"},"classic":{"color":"#123456"}});
        let saved = template_settings(initial).unwrap();
        assert!(saved.get("localStyleId").is_none(), "a new template must not retain the editable identity of its source");
        assert_eq!(saved["styleSettings"]["classic"]["color"], "#11ff22", "template reload must use the visible settings rather than a stale original cache");
        assert_eq!(saved["styleSettings"].as_object().unwrap().len(), 1, "unrelated local styles must not be embedded in a new template");
    }
    #[test]
    fn applying_template_selects_its_identity_and_overwrites_only_its_active_cache() {
        let mut template: Value = serde_json::from_str(DEFAULT_SETTINGS).unwrap();
        template["localStyleId"] = json!("source-style");
        template["color"] = json!("#11ff22");
        let current = json!({"styleSettings":{"local:selected-style":{"color":"#ff0000"},"local:other-style":{"color":"#123456"}}});
        let applied = apply_template(template, &current, "selected-style").unwrap();
        assert_eq!(applied["localStyleId"], "selected-style", "saving after API apply must update the selected template rather than create a new copy");
        assert_eq!(applied["styleSettings"]["local:selected-style"]["color"], "#11ff22", "an old selected-style cache must not overwrite the template being applied");
        assert_eq!(applied["styleSettings"]["local:other-style"]["color"], "#123456", "applying a template must preserve other style caches");
    }
    #[test]
    fn key_is_persistent_and_documentation_never_contains_it() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)", []).unwrap();
        let key = new_key(); write_setting(&db, "obs_lyrics_api_key", &key).unwrap();
        assert_eq!(setting(&db, "obs_lyrics_api_key").unwrap().as_deref(), Some(key.as_str()));
        assert_eq!(key.len(), 64);
        assert!(!DOCS.contains(&key)); assert!(!openapi().to_string().contains(&key));
    }
}
