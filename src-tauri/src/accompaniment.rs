//! CPU accompaniment extraction using the pinned UVR-MDX-NET-Inst_HQ_3 model.
//! The runtime and model are user-provided/bundled assets, never downloaded silently.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::Emitter;
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccompanimentProgress {
    task_id: String,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

fn emit_progress(app: &tauri::AppHandle, task_id: &str, phase: &str) {
    let _ = app.emit(
        "accompaniment://progress",
        AccompanimentProgress {
            task_id: task_id.into(),
            phase: phase.into(),
            percent: None, completed: None, total: None,
        },
    );
}

#[cfg(test)]
const MODEL: &str = "UVR-MDX-NET-Inst_HQ_3.onnx";
const WORKER: &str = include_str!("../ai_runtime/ai_stem_worker_hq3.py");

#[cfg(test)]
#[path = "cloud_upload_recheck.rs"]
mod cloud_upload_recheck;
#[path = "ai_decode.rs"]
mod ai_decode;

fn worker_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn run_worker(mut command: Command, app: &tauri::AppHandle, task_id: &str) -> std::io::Result<std::process::Output> {
    use std::io::{BufRead, Read};
    use std::process::Stdio;
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stderr = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr.read_to_end(&mut bytes);
        result.map(|_| bytes)
    });
    let mut stdout = Vec::new();
    let lines = std::io::BufReader::new(child.stdout.take().unwrap());
    for line in lines.lines() {
        let line = line?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if value["phase"] == "inference" {
                let completed = value["completed"].as_u64();
                let total = value["total"].as_u64().filter(|total| *total > 0);
                if let (Some(done), Some(total)) = (completed, total) {
                    let _ = app.emit("accompaniment://progress", AccompanimentProgress {
                        task_id: task_id.into(), phase: "inference".into(),
                        percent: Some((done.min(total) as f64 / total as f64) * 100.0),
                        completed: Some(done.min(total)), total: Some(total),
                    });
                }
            }
        }
        stdout.extend_from_slice(line.as_bytes()); stdout.push(b'\n');
    }
    let status = child.wait()?;
    let stderr = reader.join().map_err(|_| std::io::Error::other("AI log reader failed"))??;
    Ok(std::process::Output { status, stdout, stderr })
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccompanimentResult {
    pub path: String,
    pub device: String,
    pub model: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub model_version: String,
    pub upload_status: String,
    pub upload_error: Option<String>,
    #[serde(default)]
    pub upload_warning: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source_kind: String,
    pub source_id: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub original_source: Option<String>,
    #[serde(default)]
    pub online: Option<OnlineAccompanimentRequest>,
    #[serde(default)]
    pub cloud_id: Option<i64>,
    #[serde(default)]
    pub cloud_account: Option<String>,
    #[serde(default)]
    pub pending_replace: bool,
    #[serde(default)]
    pub replace_cloud_id: Option<i64>,
    #[serde(default)]
    pub replacement_target: Option<String>,
    #[serde(default)]
    pub vocals_path: Option<String>,
    #[serde(default)]
    pub vocals_cloud_id: Option<i64>,
    #[serde(default)]
    pub stem: String,
    #[serde(default)]
    pub lyrics: Option<serde_json::Value>,
    #[serde(default)]
    pub published_md5: Option<String>,
}

#[path = "accompaniment_library.rs"]
mod library;
#[path = "accompaniment_cloud.rs"]
mod cloud;
#[path = "accompaniment_shared.rs"]
mod shared;

#[tauri::command]
pub async fn list_accompaniments(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<AccompanimentResult>, String> {
    let directory = state.app_data.join("Instrumental");
    let account = crate::db::get_setting(&state.db.lock(), "netease_uid").unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || cloud::list(&directory, &account))
        .await.map_err(|error| error.to_string())?
}

fn finish_accompaniment(mut result: AccompanimentResult, directory: &Path, account: &str, replace: bool) -> Result<AccompanimentResult, String> {
    result.pending_replace = replace;
    // Make the finished local audio visible even while upload is pending/fails.
    library::persist(&result)?;
    if let Err(error) = cloud::publish(&mut result, directory, account, replace) {
        result.upload_status = "failed_local_preserved".into();
        result.upload_error = Some(error);
    }
    if result.upload_status == "uploaded" {
        if let Some(target) = result.replacement_target.clone() {
            let candidate = PathBuf::from(&result.path);
            let target = PathBuf::from(target);
            match fs::rename(&candidate, &target) {
                Ok(()) => {
                    let _ = fs::rename(candidate.with_extension("wav.cache.json"), target.with_extension("wav.cache.json"));
                    let _ = fs::remove_file(candidate.with_extension("wav.result.json"));
                    result.path = target.to_string_lossy().into_owned();
                    result.replacement_target = None;
                }
                Err(error) => result.upload_warning = Some(format!("云盘已更新，本地旧文件正在使用或无法替换；新文件保留：{error}")),
            }
        }
    }
    library::persist(&result)?;
    Ok(result)
}

fn accompaniment_title(title: &str) -> String {
    if title.ends_with("（伴奏）") { title.into() } else { format!("{title}（伴奏）") }
}

fn accompaniment_lyrics_qid(kind: &str, id: &str) -> Option<String> {
    matches!(kind, "qq" | "bilibili" | "navidrome").then(|| id.to_owned())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineAccompanimentRequest {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover: String,
    pub duration_ms: u64,
    pub media_mid: String,
}

#[derive(Serialize, Deserialize)]
struct CacheMetadata {
    input_sha256: String,
    model_sha256: String,
    output_sha256: String,
    output_bytes: u64,
    #[serde(default)]
    output_semantics: String,
}

fn output_semantics(architecture: &str) -> &'static str {
    if architecture == "mdx-karaoke" { "mdx-karaoke-instrumental-v2" } else { "" }
}

fn cache_matches(
    meta: &CacheMetadata,
    input_sha256: &str,
    model_sha256: &str,
    output: &Path,
    semantics: &str,
) -> bool {
    let Ok(bytes) = fs::metadata(output) else {
        return false;
    };
    meta.input_sha256 == input_sha256
        && meta.model_sha256 == model_sha256
        && meta.output_semantics == semantics
        && meta.output_bytes == bytes.len()
        && valid_wav(output)
        && sha256(output).ok().as_deref() == Some(&meta.output_sha256)
}

fn sha256(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn valid_wav(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    bytes.len() > 1024
        && bytes.get(0..4) == Some(b"RIFF")
        && bytes.get(8..12) == Some(b"WAVE")
        && bytes.windows(4).any(|w| w == b"data")
}

trait CloudTransport {
    fn api(
        &mut self,
        path: &str,
        payload: &serde_json::Value,
        cookie: &str,
    ) -> Result<serde_json::Value, String>;
    fn weapi(
        &mut self,
        path: &str,
        payload: &serde_json::Value,
        cookie: &str,
    ) -> Result<serde_json::Value, String>;
    fn lbs(&mut self, bucket: &str) -> Result<serde_json::Value, String>;
    fn nos(&mut self, url: &str, token: &str, md5: &str, bytes: &[u8]) -> Result<(), String>;
}

struct ProductionCloudTransport;
impl CloudTransport for ProductionCloudTransport {
    fn api(
        &mut self,
        path: &str,
        payload: &serde_json::Value,
        cookie: &str,
    ) -> Result<serde_json::Value, String> {
        crate::netease::api_post(path, &payload.to_string(), cookie)
    }
    fn weapi(
        &mut self,
        path: &str,
        payload: &serde_json::Value,
        cookie: &str,
    ) -> Result<serde_json::Value, String> {
        crate::netease::weapi_post(path, &payload.to_string(), Some(cookie))
    }
    fn lbs(&mut self, bucket: &str) -> Result<serde_json::Value, String> {
        ureq::get(&format!(
            "https://wanproxy.127.net/lbs?version=1.0&bucketname={bucket}"
        ))
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|e| format!("网易云 LBS 请求失败: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())
    }
    fn nos(&mut self, url: &str, token: &str, md5: &str, bytes: &[u8]) -> Result<(), String> {
        ureq::post(url)
            .set("x-nos-token", token)
            .set("Content-MD5", md5)
            .set("Content-Type", "audio/wav")
            .set("Content-Length", &bytes.len().to_string())
            .timeout(Duration::from_secs(300))
            .send_bytes(bytes)
            .map(|_| ())
            .map_err(|e| format!("NOS 文件上传失败: {e}"))
    }
}

fn upload_cloud_file_with(
    path: &Path,
    title: &str,
    artist: &str,
    album: &str,
    cookie: &str,
    transport: &mut impl CloudTransport,
) -> Result<i64, String> {
    const BUCKET: &str = "jd-musicrep-privatecloud-audio-public";
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let md5 = format!("{:x}", md5::Md5::digest(&bytes));
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Instrumental.wav");
    let check = transport.api(
        "/api/cloud/upload/check",
        &serde_json::json!({
            "bitrate":"999000", "ext":"", "length":bytes.len(), "md5":md5, "songId":"0", "version":1
        }),
        cookie,
    )?;
    if check["code"].as_i64() != Some(200) {
        return Err(format!("云盘上传检查失败: {}", check["code"]));
    }
    let token = transport.weapi("/weapi/nos/token/alloc", &serde_json::json!({
        "bucket":BUCKET, "ext":"wav", "filename":filename, "local":false, "nos_product":3, "type":"audio", "md5":md5
    }), cookie)?;
    let result = &token["result"];
    let object_key = result["objectKey"]
        .as_str()
        .ok_or("网易云未返回 NOS objectKey")?;
    let upload_token = result["token"].as_str().ok_or("网易云未返回 NOS token")?;
    let resource_id = result["resourceId"].clone();
    let resource_id_valid = resource_id.as_str().is_some_and(|value| !value.is_empty())
        || resource_id.as_u64().is_some_and(|value| value > 0);
    if !resource_id_valid {
        let code = token["code"]
            .as_i64()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "missing".into());
        let field_type = match &resource_id {
            serde_json::Value::Null => "missing",
            serde_json::Value::Bool(_) => "boolean",
            serde_json::Value::Number(_) => "number",
            serde_json::Value::String(_) => "string",
            serde_json::Value::Array(_) => "array",
            serde_json::Value::Object(_) => "object",
        };
        return Err(format!(
            "网易云 token response has invalid resourceId (code={code}, type={field_type})"
        ));
    }
    if check["needUpload"]
        .as_bool()
        .ok_or("云盘检查未返回 needUpload")?
    {
        let lbs = transport.lbs(BUCKET)?;
        let host = lbs["upload"]
            .as_array()
            .and_then(|v| v.first())
            .and_then(|v| v.as_str())
            .ok_or("网易云 LBS 未返回上传主机")?;
        let parsed_host = tauri::Url::parse(host).map_err(|_| "网易云 LBS 上传地址无效")?;
        let host_name = parsed_host.host_str().unwrap_or("");
        let allowed = parsed_host.host_str().is_some_and(|h| {
            h == "127.net" || h.ends_with(".127.net") || h == "126.net" || h.ends_with(".126.net")
        });
        let scheme = parsed_host.scheme();
        let default_port = match scheme {
            "http" => Some(80),
            "https" => Some(443),
            _ => None,
        };
        if default_port.is_none()
            || parsed_host.port_or_known_default() != default_port
            || !allowed
            || !parsed_host.username().is_empty()
            || parsed_host.password().is_some()
        {
            return Err(format!(
                "网易云 LBS upload URL rejected (scheme={scheme}, host={host_name})"
            ));
        }
        let mut upload_url = parsed_host;
        upload_url
            .set_scheme("https")
            .map_err(|_| "无法将 NOS 上传地址规范为 HTTPS")?;
        upload_url
            .set_port(None)
            .map_err(|_| "无法将 NOS 上传地址规范到默认端口")?;
        {
            let mut segments = upload_url
                .path_segments_mut()
                .map_err(|_| "网易云 LBS 上传地址不支持路径")?;
            segments.pop_if_empty().push(BUCKET).push(&object_key);
        }
        upload_url.set_query(Some("offset=0&complete=true&version=1.0"));
        transport.nos(upload_url.as_str(), upload_token, &md5, &bytes)?;
    }
    let info = transport.api(
        "/api/upload/cloud/info/v2",
        &serde_json::json!({
            "md5":md5, "songid":check["songId"], "filename":filename, "song":title,
            "album":if album.is_empty() { "Instrumental" } else { album },
            "artist":if artist.is_empty() { "Unknown Artist" } else { artist },
        "bitrate":"999000", "resourceId":resource_id
        }),
        cookie,
    )?;
    if info["code"].as_i64() != Some(200) {
        let code = info["code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "missing-or-nonnumeric".into());
        return Err(format!(
            "网易云 info response was not successful (code={code})"
        ));
    }
    let song_id = info["songId"].clone();
    let valid_song_id = song_id.as_u64().is_some_and(|id| id > 0)
        || song_id.as_i64().is_some_and(|id| id > 0)
        || song_id
            .as_str()
            .and_then(|id| id.parse::<u64>().ok())
            .is_some_and(|id| id > 0);
    if !valid_song_id {
        let code = info["code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "missing".into());
        let field_type = match &song_id {
            serde_json::Value::Null => "missing",
            serde_json::Value::Bool(_) => "boolean",
            serde_json::Value::Number(_) => "number",
            serde_json::Value::String(_) => "string",
            serde_json::Value::Array(_) => "array",
            serde_json::Value::Object(_) => "object",
        };
        return Err(format!(
            "网易云 info response has invalid songId (code={code}, type={field_type})"
        ));
    }
    let published = transport.api(
        "/api/cloud/pub/v2",
        &serde_json::json!({"songid":song_id}),
        cookie,
    )?;
    if published["code"].as_i64() != Some(200) {
        let code = published["code"]
            .as_i64()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "missing-or-nonnumeric".into());
        return Err(format!(
            "网易云 pub response was not successful (code={code})"
        ));
    }
    song_id.as_i64().or_else(|| song_id.as_str().and_then(|id| id.parse().ok()))
        .ok_or_else(|| "Invalid cloud song ID".into())
}

fn upload_result(path: &Path, title: &str, artist: &str, album: &str) -> (String, Option<String>) {
    let Some(cookie) = crate::credentials::get("netease_music_u") else {
        return ("skipped_not_signed_in".into(), None);
    };
    upload_result_with(
        path,
        title,
        artist,
        album,
        Some(&cookie),
        &mut ProductionCloudTransport,
    )
}

#[cfg(feature = "acceptance-tests")]
pub(crate) fn acceptance_upload_file(
    path: &Path, title: &str, artist: &str, album: &str,
) -> (String, Option<String>) {
    upload_result(path, title, artist, album)
}

fn upload_result_with(
    path: &Path,
    title: &str,
    artist: &str,
    album: &str,
    cookie: Option<&str>,
    transport: &mut impl CloudTransport,
) -> (String, Option<String>) {
    let Some(cookie) = cookie else {
        return ("skipped_not_signed_in".into(), None);
    };
    match upload_cloud_file_with(path, title, artist, album, cookie, transport) {
        Ok(_) => ("uploaded".into(), None),
        Err(error) => ("failed_local_preserved".into(), Some(error)),
    }
}

fn output_path(source: &Path, app_data: &Path, input_sha256: &str) -> Result<PathBuf, String> {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("invalid source filename")?;
    let safe_stem: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    Ok(app_data.join("Instrumental").join(format!(
        "{safe_stem} - {} - Instrumental.wav",
        &input_sha256[..12]
    )))
}

#[tauri::command]
pub async fn extract_accompaniment(
    app: tauri::AppHandle,
    task_id: Option<String>,
    source: Option<String>,
    online: Option<OnlineAccompanimentRequest>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    source_kind: Option<String>,
    source_id: Option<String>,
    force: Option<bool>,
    both: Option<bool>,
    model_id: Option<String>,
) -> Result<AccompanimentResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let task_id = task_id.unwrap_or_default();
        let mut resolved_kind = source_kind.unwrap_or_else(|| "track".into());
        let mut resolved_id = source_id.unwrap_or_default();
        let (mut title, mut artist, mut album) = (title, artist, album);
        let force = force.unwrap_or(false);
        let both = both.unwrap_or(false);
        let original_source = source.clone();
        let original_online = online.clone();
        let app_data = app.state::<crate::AppState>().app_data.clone();
        let directory = app_data.join("Instrumental");
        let account = crate::db::get_setting(&app.state::<crate::AppState>().db.lock(), "netease_uid").unwrap_or_default();
        let mut identity = AccompanimentResult {
            title: title.clone().unwrap_or_default(), artist: artist.clone().unwrap_or_default(),
            album: album.clone().unwrap_or_default(), source_kind: resolved_kind.clone(), source_id: resolved_id.clone(),
            original_source: original_source.clone(), online: original_online.clone(), ..Default::default()
        };
        if let Some(request) = &online {
            identity.title = request.title.clone(); identity.artist = request.artist.clone();
            identity.album = request.album.clone(); identity.cover = request.cover.clone();
            identity.duration_ms = request.duration_ms; identity.source_kind = request.kind.clone(); identity.source_id = request.id.clone();
            identity.lyrics = crate::db::get_lyrics_cache(&app.state::<crate::AppState>().db.lock(), &request.kind, &request.id)
                .and_then(|text| serde_json::from_str(&text).ok());
        } else if let Some(path) = &source {
            let local_track = {
                let state = app.state::<crate::AppState>();
                let connection = state.db.lock();
                crate::db::get_track_by_path(&connection, path).map(|track| {
                    let lrc_path = crate::db::get_lrc_path(&connection, track.id);
                    (track, lrc_path)
                })
            };
            if let Some((track, lrc_path)) = local_track {
                identity.title = track.title; identity.artist = track.artist; identity.album = track.album;
                identity.cover = track.cover; identity.duration_ms = (track.duration.max(0.0) * 1000.0) as u64;
                identity.source_kind = "track".into(); identity.source_id = track.id.to_string();
                identity.lyrics = lrc_path
                    .and_then(|path| crate::commands::read_text_file_decoded(Path::new(&path)))
                    .and_then(|text| { let parsed = crate::lyrics::parse(&text);
                        serde_json::to_value(crate::models::LyricsPayload::new(parsed.synced, parsed.lines)).ok()
                    });
            }
        }
        if title.as_deref().is_none_or(str::is_empty) && !identity.title.is_empty() { title = Some(identity.title.clone()); }
        if artist.as_deref().is_none_or(str::is_empty) && !identity.artist.is_empty() { artist = Some(identity.artist.clone()); }
        if album.as_deref().is_none_or(str::is_empty) && !identity.album.is_empty() { album = Some(identity.album.clone()); }
        let mut cover = identity.cover.clone(); let mut duration_ms = identity.duration_ms;
        resolved_kind = identity.source_kind.clone(); resolved_id = identity.source_id.clone();
        emit_progress(&app, &task_id, "cloud_check");
        if !force && model_id.as_deref().is_none_or(str::is_empty) {
            if let Some(existing) = cloud::reuse(&identity, &directory, &account)? {
                if !both || existing.vocals_path.is_some() || existing.vocals_cloud_id.is_some() { return Ok(existing); }
            }
        }
        let downloaded = if let Some(request) = online {
            emit_progress(&app, &task_id, "download");
            resolved_kind = request.kind.clone();
            resolved_id = request.id.clone();
            title = Some(request.title.clone());
            artist = Some(request.artist.clone());
            album = Some(request.album.clone());
            cover = request.cover.clone();
            duration_ms = request.duration_ms;
            let save = crate::commands::OnlineSaveReq {
                kind: request.kind,
                id: request.id,
                title: request.title,
                artist: request.artist,
                album: request.album,
                cover_url: request.cover,
                duration_ms: request.duration_ms,
                media_mid: request.media_mid,
                album_audio_id: 0,
                hq_hash: String::new(),
                sq_hash: String::new(),
                super_hash: String::new(),
            };
            let info = crate::commands::download_accompaniment_source(&app, save)?;
            info.get("path")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or("online download did not return a file path")?
        } else {
            source.ok_or("source audio or online track is required")?
        };
        emit_progress(&app, &task_id, "processing");
        let src = PathBuf::from(downloaded);
        if !src.is_file() {
            return Err("Source audio file does not exist".to_string());
        }
        let original_source = Some(src.to_string_lossy().into_owned());
        if resolved_kind == "track" {
            let state = app.state::<crate::AppState>();
            let connection = state.db.lock();
            if let Some(original) = crate::db::get_track_by_path(&connection, &src.to_string_lossy()) {
                title = Some(original.title);
                artist = Some(original.artist);
                album = Some(original.album);
                cover = original.cover;
                duration_ms = (original.duration.max(0.0) * 1000.0) as u64;
                resolved_id = original.id.to_string();
            }
        }
        let app_data = app.state::<crate::AppState>().app_data.clone();
        let packaged_exe = std::env::var_os("RUSTMUSIC_AI_EXECUTABLE")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::current_exe().ok().and_then(|p| {
                    p.parent().map(|parent| {
                        parent.join("ai").join(if cfg!(windows) {
                            "audio-separator.exe"
                        } else {
                            "audio-separator"
                        })
                    })
                })
            })
            .filter(|p| p.is_file());
        let root = std::env::current_exe().map_err(|error| error.to_string())?;
        let root = root.parent().ok_or("无法定位程序目录")?;
        let mut runtime_settings = crate::ai_models::settings(&app.state::<crate::AppState>().db.lock());
        if let Some(model_id) = model_id.filter(|id| !id.is_empty()) {
            runtime_settings.model_id = model_id;
        }
        let selected = crate::ai_models::resolve(root, &runtime_settings)?;
        let model_dir = selected.directory.clone();
        let model = selected.model.as_str();
        let cache_semantics = output_semantics(&selected.architecture);
        let model_sha256 = sha256(&model_dir.join(model))?;
        if selected.model_sha256 != model_sha256 {
            return Err("AI 模型校验失败，请重新安装对应模型".into());
        }
        let input_sha256 = sha256(&src)?;
        let song_title = title.unwrap_or_else(|| {
            src.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Track")
                .to_string()
        });
        let song_artist = artist.unwrap_or_default();
        let song_album = album.unwrap_or_default();
        let out = output_path(&src, &app_data, &input_sha256)?;
        fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
        let cache_path = out.with_extension("wav.cache.json");
        if let Some(meta) = fs::read(&cache_path).ok().filter(|_| !force && !both) {
            if let Ok(meta) = serde_json::from_slice::<CacheMetadata>(&meta) {
                if cache_matches(&meta, &input_sha256, &model_sha256, &out, cache_semantics) {
                    if crate::credentials::get("netease_music_u").is_some() {
                        emit_progress(&app, &task_id, "upload");
                    }
                    return finish_accompaniment(AccompanimentResult {
                        path: out.to_string_lossy().into_owned(),
                        device: "cache".into(),
                        model: model.into(), model_id: selected.package_id.clone(),
                        model_name: selected.name.clone(), model_version: selected.version.clone(),
                        upload_status: "local_only".into(),
                        upload_error: None,
                        title: song_title.clone(),
                        artist: song_artist.clone(),
                        album: song_album.clone(),
                        source_kind: resolved_kind.clone(),
                        source_id: resolved_id.clone(),
                        cover: cover.clone(),
                        duration_ms,
                        original_source: original_source.clone(), online: original_online.clone(), lyrics: identity.lyrics.clone(),
                        ..Default::default()
                    }, &directory, &account, false);
                }
            }
        }
        let worker = app_data.join("ai-runtime").join("ai_stem_worker_hq3.py");
        if fs::read(&worker).ok().as_deref() != Some(WORKER.as_bytes()) {
            fs::create_dir_all(worker.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&worker, WORKER).map_err(|e| e.to_string())?;
        }
        let packaged = packaged_exe;
        // Never let a failed inference truncate an existing playable accompaniment.
        let staging = directory.join(".working");
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let generated = staging.join(format!("{}.wav", rand::random::<u64>()));
        let vocals = both.then(|| staging.join(format!("{}-vocals.wav", rand::random::<u64>())));
        emit_progress(&app, &task_id, "decoding");
        let prepared = ai_decode::prepare(&src, &staging)?;
        emit_progress(&app, &task_id, "processing");
        let common_runtime = std::env::var_os("RUSTMUSIC_AI_RUNTIME_ROOT").map(PathBuf::from)
            .unwrap_or_else(|| {
                let common = root.join("ai");
                if common.is_dir() { common } else { model_dir.parent().unwrap_or(&model_dir).to_owned() }
            });
        let embedded_python = Some(common_runtime.join("python/python.exe")).filter(|path| path.is_file())
            .or_else(|| model_dir.parent().map(|dir| dir.join("python/python.exe")).filter(|path| path.is_file()));
        let output = if let Some(python) = embedded_python {
            let mut command = worker_command(python);
            command.arg(&worker).arg(&prepared.path).arg(&generated).arg(&model_dir).arg("GPU")
                .env("RUSTMUSIC_AI_NATIVE_DECODED", "1")
                .env("RUSTMUSIC_AI_OUTPUT_SUBTYPE", prepared.output_subtype)
                .env("RUSTMUSIC_AI_RUNTIME_ROOT", &common_runtime)
                .env("RUSTMUSIC_AI_MODEL_FILE", model)
                .env("RUSTMUSIC_AI_ARCHITECTURE", &selected.architecture)
                .env("RUSTMUSIC_AI_MODEL_SHA256", &model_sha256)
                .env("RUSTMUSIC_AI_GPU_PERCENT", runtime_settings.gpu_percent.to_string())
                .env("RUSTMUSIC_AI_MEMORY_MB", runtime_settings.memory_mb.to_string());
            if let Some(vocals) = &vocals { command.arg(vocals); }
            run_worker(command, &app, &task_id)
        } else if let Some(exe) = packaged {
            if runtime_settings.gpu_percent != 100 || runtime_settings.memory_mb != 0 {
                return Err("当前 AI 环境不支持资源限制，请更新公共运行环境".into());
            }
            if both { return Err("当前AI运行目录缺少双轨运行组件，请使用更新的便携包".into()); }
            // The frozen reference worker searches beside itself and prefers HQ_4.
            // Do not let a different model silently satisfy the fixed HQ_3 contract.
            let runtime_models = exe
                .parent()
                .ok_or("AI runtime has no parent directory")?
                .join("models");
            if runtime_models != model_dir
                || runtime_models.join("UVR-MDX-NET-Inst_HQ_4.onnx").exists()
            {
                return Err("便携 AI 目录必须使用对应 models 目录且仅保留指定 HQ_3 模型".into());
            }
            let gpu = worker_command(&exe).arg(&prepared.path).arg(&generated).arg("GPU").output();
            match gpu {
                Ok(result) if result.status.success() => Ok(result),
                _ => worker_command(&exe).arg(&prepared.path).arg(&generated).arg("CPU").output(),
            }
        } else {
            let python = std::env::var_os("RUSTMUSIC_AI_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }));
            let mut command = worker_command(python);
            command.arg(&worker).arg(&prepared.path).arg(&generated).arg(&model_dir).arg("GPU")
                .env("RUSTMUSIC_AI_NATIVE_DECODED", "1")
                .env("RUSTMUSIC_AI_OUTPUT_SUBTYPE", prepared.output_subtype)
                .env("RUSTMUSIC_AI_RUNTIME_ROOT", &common_runtime)
                .env("RUSTMUSIC_AI_MODEL_FILE", model)
                .env("RUSTMUSIC_AI_ARCHITECTURE", &selected.architecture)
                .env("RUSTMUSIC_AI_MODEL_SHA256", &model_sha256)
                .env("RUSTMUSIC_AI_GPU_PERCENT", runtime_settings.gpu_percent.to_string())
                .env("RUSTMUSIC_AI_MEMORY_MB", runtime_settings.memory_mb.to_string());
            if let Some(vocals) = &vocals { command.arg(vocals); }
            run_worker(command, &app, &task_id)
        }
        .map_err(|e| format!("无法启动 AI 音频分离运行时：{e}"))?;
        drop(prepared);
        if !output.status.success() {
            let details = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "AI separation failed: {}",
                details
                    .lines()
                    .rev()
                    .take(8)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if !String::from_utf8_lossy(&output.stdout).contains(model) {
            return Err(format!("分离运行时没有确认模型 {model}，结果未缓存"));
        }
        if !valid_wav(&generated) {
            return Err("Separator returned without a valid output file".into());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let device = reported_device(&stdout)
            .ok_or("分离运行时没有报告实际设备，结果设备未知")?
            .to_string();
        let replacement_target = force.then(|| out.to_string_lossy().into_owned());
        let vocals_path = if let Some(vocals) = vocals {
            if !valid_wav(&vocals) { return Err("模型没有生成人声音轨，原文件保留".into()); }
            let folder = directory.join("Vocals"); fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let target = folder.join(vocals.file_name().unwrap());
            fs::rename(vocals, &target).map_err(|e| e.to_string())?;
            Some(target.to_string_lossy().into_owned())
        } else { None };
        let final_out = if force { directory.join(format!("replacement-{}.wav", rand::random::<u64>())) } else { out };
        fs::rename(&generated, &final_out).map_err(|e| format!("保存新伴奏失败，原伴奏保留：{e}"))?;
        let cache_path = final_out.with_extension("wav.cache.json");
        let output_bytes = fs::metadata(&final_out).map_err(|e| e.to_string())?.len();
        let metadata = CacheMetadata {
            input_sha256,
            model_sha256,
            output_sha256: sha256(&final_out)?,
            output_bytes,
            output_semantics: cache_semantics.into(),
        };
        let temp = cache_path.with_extension("json.partial");
        fs::write(
            &temp,
            serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temp, cache_path).map_err(|e| e.to_string())?;
        if crate::credentials::get("netease_music_u").is_some() {
            emit_progress(&app, &task_id, "upload");
        }
        finish_accompaniment(AccompanimentResult {
            path: final_out.to_string_lossy().into_owned(),
            device,
            model: model.into(), model_id: selected.package_id.clone(),
            model_name: selected.name.clone(), model_version: selected.version.clone(),
            upload_status: "local_only".into(),
            upload_error: None,
            title: song_title,
            artist: song_artist,
            album: song_album,
            source_kind: resolved_kind,
            source_id: resolved_id,
            cover,
            duration_ms,
            original_source, online: original_online, replacement_target, vocals_path, lyrics: identity.lyrics, ..Default::default()
        }, &directory, &account, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn play_accompaniment(
    state: tauri::State<'_, crate::AppState>,
    path: String,
    title: String,
    artist: String,
    album: String,
    source_kind: String,
    source_id: String,
    cover: Option<String>,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    let cloud_id = path.strip_prefix("cloud:").map(|id| id.parse::<i64>()).transpose().map_err(|_| "云盘伴奏ID无效")?;
    let path = PathBuf::from(path);
    if cloud_id.is_none() && !valid_wav(&path) {
        return Err("伴奏文件不存在或无效".into());
    }
    let numeric_id = source_id.parse::<i64>().ok();
    let local = source_kind == "track";
    let quality = if title.ends_with("（人声）") { "AI 人声" } else { "AI 伴奏" };
    let meta = crate::engine::TrackInfo {
        id: if local { numeric_id } else { None },
        kind: if source_kind.is_empty() { "url".into() } else { source_kind.clone() },
        path: path.to_string_lossy().into_owned(),
        title,
        artist,
        album,
        cover: cover.unwrap_or_default(),
        duration_ms: duration_ms.unwrap_or_default(),
        nid: (source_kind == "netease").then_some(numeric_id.unwrap_or_default()),
        qid: accompaniment_lyrics_qid(&source_kind, &source_id),
        kgid: (source_kind == "kugou").then_some(source_id),
        quality: Some(quality.into()),
    };
    if let Some(id) = cloud_id {
        let engine = state.engine.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let cookie = crate::credentials::get("netease_music_u").ok_or("请先登录云盘账号")?;
            let (url, _, _, _) = crate::netease::song_url(id, Some(&cookie), "lossless")?.ok_or("云盘伴奏暂不可播放")?;
            engine.play_url(url, meta)
        }).await.map_err(|e| e.to_string())?
    } else { state.engine.play_file(meta) }
}

#[tauri::command]
pub async fn regenerate_accompaniment(app: tauri::AppHandle, path: String, task_id: Option<String>) -> Result<AccompanimentResult, String> {
    let (directory, account) = {
        let state = app.state::<crate::AppState>();
        let account = crate::db::get_setting(&state.db.lock(), "netease_uid").unwrap_or_default();
        (state.app_data.join("Instrumental"), account)
    };
    let item = tauri::async_runtime::spawn_blocking(move || cloud::list(&directory, &account)?.into_iter()
        .find(|item| item.path == path).ok_or_else(|| "伴奏记录已不存在".to_string()))
        .await.map_err(|e| e.to_string())??;
    if item.original_source.is_none() && item.online.is_none() { return Err("此旧伴奏没有原曲关联，请从原曲右键选择重新生成".into()); }
    extract_accompaniment(app, task_id, item.original_source, item.online, Some(item.title),
        Some(item.artist), Some(item.album), Some(item.source_kind), Some(item.source_id), Some(true), Some(item.vocals_path.is_some()), None).await
}

#[tauri::command]
pub async fn retry_accompaniment_upload(state: tauri::State<'_, crate::AppState>, path: String) -> Result<AccompanimentResult, String> {
    let directory = state.app_data.join("Instrumental");
    let account = crate::db::get_setting(&state.db.lock(), "netease_uid").unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut local = library::list(&directory)?;
        local.extend(library::list(&directory.join("Vocals"))?);
        let result = local.into_iter().find(|item| item.path == path).ok_or("本地音轨不存在")?;
        let replace = result.pending_replace;
        finish_accompaniment(result, &directory, &account, replace)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_accompaniment(state: tauri::State<'_, crate::AppState>, query: OnlineAccompanimentRequest) -> Result<Option<AccompanimentResult>, String> {
    let directory = state.app_data.join("Instrumental");
    let account = crate::db::get_setting(&state.db.lock(), "netease_uid").unwrap_or_default();
    let original_source = if query.kind == "track" {
        query.id.parse().ok().and_then(|id| crate::db::get_track(&state.db.lock(), id)).map(|track| track.path)
    } else { None };
    tauri::async_runtime::spawn_blocking(move || {
        let original = AccompanimentResult {
            title:query.title.clone(), artist:query.artist.clone(), album:query.album.clone(),
            cover:query.cover.clone(), duration_ms:query.duration_ms, source_kind:query.kind.clone(),
            source_id:query.id.clone(), original_source,
            online:(query.kind != "track").then_some(query), ..Default::default()
        };
        if let Some(local) = find_local_accompaniment(&library::list(&directory)?, &original) { return Ok(Some(local)); }
        cloud::reuse(&original, &directory, &account)
    }).await.map_err(|e| e.to_string())?
}

fn same_recording_metadata(candidate: &AccompanimentResult, original: &AccompanimentResult) -> bool {
    let equal = |left: &str, right: &str| !left.trim().is_empty() && left.trim().eq_ignore_ascii_case(right.trim());
    equal(&candidate.title, &original.title)
        && equal(&candidate.artist, &original.artist)
        && equal(&candidate.album, &original.album)
        && candidate.duration_ms > 0
        && original.duration_ms > 0
        && candidate.duration_ms.abs_diff(original.duration_ms) <= 2500
}

fn find_local_accompaniment(items: &[AccompanimentResult], original: &AccompanimentResult) -> Option<AccompanimentResult> {
    if !original.source_id.is_empty() {
        if let Some(exact) = items.iter().find(|item| item.stem != "vocals"
            && item.source_kind == original.source_kind && item.source_id == original.source_id) {
            return Some(exact.clone());
        }
    }
    let mut matches = items.iter().filter(|item| item.stem != "vocals" && same_recording_metadata(item, original));
    let candidate = matches.next()?.clone();
    matches.next().is_none().then_some(candidate)
}

#[tauri::command]
pub async fn switch_accompaniment(app: tauri::AppHandle, expected_path: String, mut target: crate::engine::TrackInfo, instrumental: Option<bool>) -> Result<crate::engine::PlayStateSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        if let Some(id) = target.path.strip_prefix("cloud:") {
            use std::io::Read;
            let id: i64 = id.parse().map_err(|_| "云盘ID无效")?;
            let directory = state.app_data.join("AccompanimentPlayback");
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let cached = directory.join(format!("cloud-{id}.audio"));
            if !cached.is_file() {
                let cookie = crate::credentials::get("netease_music_u").ok_or("请先登录云盘账号")?;
                let (url, _, _, _) = crate::netease::song_url(id, Some(&cookie), "lossless")?.ok_or("云盘伴奏暂无播放链接")?;
                let response = ureq::get(&url).timeout(Duration::from_secs(120)).call().map_err(|e| e.to_string())?;
                let expected = response.header("Content-Length").and_then(|s| s.parse::<u64>().ok());
                let limit = 512 * 1024 * 1024;
                let temporary = cached.with_extension(format!("{}.partial", rand::random::<u64>()));
                let mut output = fs::File::create(&temporary).map_err(|e| e.to_string())?;
                let copied = std::io::copy(&mut response.into_reader().take(limit + 1), &mut output).map_err(|e| e.to_string())?;
                drop(output);
                if copied < 1024 || copied > limit || expected.is_some_and(|bytes| bytes != copied) {
                    let _ = fs::remove_file(&temporary); return Err("云盘音轨下载不完整，原曲继续播放".into());
                }
                fs::rename(temporary, &cached).map_err(|e| e.to_string())?;
            }
            target.path = cached.to_string_lossy().into_owned();
        }
        let current = state.engine.snapshot().ok_or("当前没有歌曲")?;
        if current.state.info.path != expected_path { return Err("歌曲已切换，已取消本次音轨切换".into()); }
        state.engine.prepare_stem(&expected_path, &target.path, instrumental.unwrap_or(true))?;
        state.engine.snapshot().ok_or_else(|| "无法读取切轨后的状态".into())
    }).await.map_err(|e| e.to_string())?
}

fn reported_device(stdout: &str) -> Option<&str> {
    stdout.lines().find_map(|line| {
        line.strip_prefix("device=")
            .and_then(|s| s.split(';').next())
            .or_else(|| line.strip_prefix("device used: ").map(str::trim))
    })
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn background_worker_does_not_attach_a_console() {
        let script = r#"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; if ([ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 7 }; Write-Output 'no-console'"#;
        let output = super::worker_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output().expect("launch the same hidden worker command used for GPU, CPU and Python");
        assert!(output.status.success(), "Background audio work must not attach a console");
        assert!(String::from_utf8_lossy(&output.stdout).contains("no-console"),
            "Hiding a console must preserve captured worker output");
    }
    use super::*;

    struct MockCloud {
        need_upload: bool,
        fail_nos: bool,
        resource_id: serde_json::Value,
        info_resource_id: Option<serde_json::Value>,
        info_song_id: serde_json::Value,
        published_song_id: Option<serde_json::Value>,
        publish_code: Option<i64>,
        lbs_url: String,
        nos_url: Option<String>,
        calls: Vec<String>,
    }
    impl CloudTransport for MockCloud {
        fn api(
            &mut self,
            path: &str,
            payload: &serde_json::Value,
            _: &str,
        ) -> Result<serde_json::Value, String> {
            self.calls.push(path.into());
            Ok(match path {
                "/api/cloud/upload/check" => {
                    serde_json::json!({"code":200,"needUpload":self.need_upload,"songId":17})
                }
                "/api/upload/cloud/info/v2" => {
                    self.info_resource_id = payload.get("resourceId").cloned();
                    serde_json::json!({"code":200,"songId":self.info_song_id.clone()})
                }
                "/api/cloud/pub/v2" => {
                    self.published_song_id = payload.get("songid").cloned();
                    let mut response = serde_json::json!({});
                    if let Some(code) = self.publish_code {
                        response["code"] = serde_json::json!(code);
                    }
                    response
                }
                _ => serde_json::json!({"code":200}),
            })
        }
        fn weapi(
            &mut self,
            _: &str,
            _: &serde_json::Value,
            _: &str,
        ) -> Result<serde_json::Value, String> {
            self.calls.push("token".into());
            Ok(
                serde_json::json!({"result":{"objectKey":"obj/key","token":"t","resourceId":self.resource_id.clone()}}),
            )
        }
        fn lbs(&mut self, _: &str) -> Result<serde_json::Value, String> {
            self.calls.push("lbs".into());
            Ok(serde_json::json!({"upload":[self.lbs_url.clone()]}))
        }
        fn nos(&mut self, url: &str, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
            self.calls.push("nos".into());
            self.nos_url = Some(url.into());
            if self.fail_nos {
                Err("fixture NOS failure".into())
            } else {
                Ok(())
            }
        }
    }

    struct HashProbeCloud {
        checks: Vec<(String, serde_json::Value)>,
        token_accounts: Vec<String>,
        info_accounts: Vec<String>,
        published_accounts: Vec<String>,
        nos_calls: usize,
    }

    impl CloudTransport for HashProbeCloud {
        fn api(&mut self, path: &str, payload: &serde_json::Value, cookie: &str) -> Result<serde_json::Value, String> {
            match path {
                "/api/cloud/upload/check" => {
                    self.checks.push((cookie.into(), payload.clone()));
                    Ok(serde_json::json!({"code":200,"needUpload":false,"songId":17}))
                }
                "/api/upload/cloud/info/v2" => {
                    self.info_accounts.push(cookie.into());
                    Ok(serde_json::json!({"code":200,"songId":42}))
                }
                "/api/cloud/pub/v2" => {
                    self.published_accounts.push(cookie.into());
                    Ok(serde_json::json!({"code":200}))
                }
                _ => panic!("Unexpected hash-probe API endpoint: {path}"),
            }
        }

        fn weapi(&mut self, path: &str, _: &serde_json::Value, cookie: &str) -> Result<serde_json::Value, String> {
            assert_eq!(path, "/weapi/nos/token/alloc");
            self.token_accounts.push(cookie.into());
            Ok(serde_json::json!({"result":{"objectKey":"fixture","token":"fixture","resourceId":7}}))
        }

        fn lbs(&mut self, _: &str) -> Result<serde_json::Value, String> { panic!("A cached hash must not request an upload host") }
        fn nos(&mut self, _: &str, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
            self.nos_calls += 1;
            panic!("A cached hash must not upload audio bytes")
        }
    }

    fn fixture_wav() -> PathBuf {
        let p = std::env::temp_dir().join(format!("rustmusic-upload-{}-{}.wav", std::process::id(), rand::random::<u64>()));
        let mut wav = vec![0u8; 1200];
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        wav[100..104].copy_from_slice(b"data");
        fs::write(&p, wav).unwrap();
        p
    }
    #[test]
    fn accompaniment_is_saved_separately_from_original() {
        let source = Path::new("song.flac");
        let output = output_path(source, Path::new("appdata"), "0123456789abcdef").unwrap();
        assert_ne!(source, output);
        assert_eq!(
            output.file_name().unwrap(),
            "song - 0123456789ab - Instrumental.wav"
        );
    }

    #[test]
    fn local_accompaniment_reuses_unique_metadata_match_when_provider_identity_differs() {
        let original = AccompanimentResult {
            title: "DRIP".into(), artist: "BABYMONSTER".into(), album: "DRIP".into(),
            duration_ms: 178_880, source_kind: "netease".into(), source_id: "online-id".into(),
            ..Default::default()
        };
        let existing = AccompanimentResult {
            path: "local-drip.wav".into(), title: "DRIP".into(), artist: "BABYMONSTER".into(),
            album: "DRIP".into(), duration_ms: 179_000, source_kind: "track".into(), source_id: "3".into(),
            ..Default::default()
        };
        let unrelated = AccompanimentResult {
            path: "other-version.wav".into(), title: "DRIP".into(), artist: "BABYMONSTER".into(),
            album: "OTHER ALBUM".into(), duration_ms: 178_880, source_kind: "track".into(), source_id: "4".into(),
            ..Default::default()
        };
        assert_eq!(
            find_local_accompaniment(&[existing.clone(), unrelated], &original).map(|item| item.path),
            Some("local-drip.wav".into()),
            "An existing local stem should be reused across provider IDs only when the full recording metadata identifies it uniquely"
        );
        assert!(
            find_local_accompaniment(&[existing.clone(), existing], &original).is_none(),
            "Ambiguous local stems must not be selected automatically"
        );
    }

    #[test]
    fn only_a_nontrivial_riff_wave_is_cacheable() {
        assert!(!valid_wav(Path::new("missing.wav")));
    }

    #[test]
    fn reported_device_is_actual_provider_not_requested_mode() {
        assert_eq!(
            reported_device("device=CPUExecutionProvider;model=HQ3"),
            Some("CPUExecutionProvider")
        );
        assert_eq!(reported_device("runtime: mode: GPU\ndevice used: gpu-directml\ndone: file (1 bytes, HQ3, GPU, gpu-directml)"), Some("gpu-directml"));
        assert_eq!(
            reported_device("done: file (1 bytes, HQ3, GPU, gpu-directml)"),
            None
        );
    }

    #[test]
    fn damaged_or_partial_cache_output_is_never_reused() {
        let path = std::env::temp_dir().join(format!("rustmusic-cache-{}.wav", std::process::id()));
        let mut wav = vec![0u8; 1200];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        wav[100..104].copy_from_slice(b"data");
        fs::write(&path, &wav).unwrap();
        let meta = CacheMetadata {
            input_sha256: "input".into(),
            model_sha256: "model".into(),
            output_sha256: sha256(&path).unwrap(),
            output_bytes: wav.len() as u64,
            output_semantics: String::new(),
        };
        assert!(cache_matches(&meta, "input", "model", &path, ""));
        assert!(!cache_matches(&meta, "input", "model", &path, output_semantics("mdx-karaoke")),
            "A pre-fix Karaoke cache must be regenerated after the stem direction changes");
        fs::write(&path, b"partial").unwrap();
        assert!(!cache_matches(&meta, "input", "model", &path, ""));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cloud_upload_full_flow_skips_only_nos_when_file_already_exists() {
        for need_upload in [true, false] {
            let path = fixture_wav();
            let mut mock = MockCloud {
                need_upload,
                fail_nos: false,
                resource_id: serde_json::json!(987654321),
                info_resource_id: None,
                info_song_id: serde_json::json!(42),
                published_song_id: None,
                publish_code: Some(200),
                lbs_url: "http://nosup-jd1.127.net/".into(),
                nos_url: None,
                calls: vec![],
            };
            let result = upload_result_with(
                &path,
                "title",
                "artist",
                "album",
                Some("fixture-cookie"),
                &mut mock,
            );
            assert_eq!(result.0, "uploaded");
            assert!(mock.calls.contains(&"/api/cloud/upload/check".into()));
            assert!(mock.calls.contains(&"/api/upload/cloud/info/v2".into()));
            assert!(mock.calls.contains(&"/api/cloud/pub/v2".into()));
            assert_eq!(mock.calls.contains(&"nos".into()), need_upload);
            assert_eq!(mock.calls.contains(&"lbs".into()), need_upload);
            assert_eq!(
                mock.info_resource_id,
                Some(serde_json::json!(987654321)),
                "Numeric resourceId must be preserved as a JSON number in the info request"
            );
            assert_eq!(mock.published_song_id, Some(serde_json::json!(42)));
            if need_upload {
                let url = mock.nos_url.as_deref().unwrap();
                assert!(
                    url.starts_with("https://nosup-jd1.127.net/"),
                    "HTTP LBS URL must be upgraded to HTTPS: {url}"
                );
                assert!(
                    url.contains("obj%2Fkey"),
                    "objectKey slash must be escaped as one path segment: {url}"
                );
                assert!(
                    !url.contains(":443/"),
                    "HTTPS default port must remain implicit: {url}"
                );
            }
            assert!(path.exists());
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn same_cloud_hash_can_skip_audio_transfer_but_each_account_still_registers_it() {
        let path = fixture_wav();
        let expected_md5 = format!("{:x}", md5::Md5::digest(fs::read(&path).unwrap()));
        let mut mock = HashProbeCloud {
            checks: Vec::new(), token_accounts: Vec::new(), info_accounts: Vec::new(),
            published_accounts: Vec::new(), nos_calls: 0,
        };

        for account in ["source-account", "target-account"] {
            let result = upload_result_with(
                &path, "title", "artist", "album", Some(account), &mut mock,
            );
            assert_eq!(result.0, "uploaded", "The account needs its own cloud registration");
        }

        assert_eq!(mock.checks.len(), 2);
        assert!(mock.checks.iter().all(|(_, payload)| payload["md5"] == expected_md5));
        assert!(mock.checks.iter().all(|(_, payload)| payload["length"] == 1200));
        assert_eq!(mock.checks.iter().map(|(account, _)| account.as_str()).collect::<Vec<_>>(),
            vec!["source-account", "target-account"]);
        assert_eq!(mock.token_accounts, ["source-account", "target-account"]);
        assert_eq!(mock.info_accounts, ["source-account", "target-account"]);
        assert_eq!(mock.published_accounts, ["source-account", "target-account"]);
        assert_eq!(mock.nos_calls, 0, "If the server confirms a globally cached hash, neither account resends audio");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cloud_failure_preserves_local_file_and_signed_out_skips_transport() {
        let path = fixture_wav();
        let mut mock = MockCloud {
            need_upload: true,
            fail_nos: true,
            resource_id: serde_json::json!(987654321),
            info_resource_id: None,
            info_song_id: serde_json::json!(42),
            published_song_id: None,
            publish_code: Some(200),
            lbs_url: "http://nosup-jd1.127.net/".into(),
            nos_url: None,
            calls: vec![],
        };
        let failed = upload_result_with(
            &path,
            "title",
            "artist",
            "album",
            Some("fixture-cookie"),
            &mut mock,
        );
        assert_eq!(failed.0, "failed_local_preserved");
        assert!(failed.1.unwrap().contains("fixture NOS failure"));
        assert!(path.exists());
        let mut signed_out = MockCloud {
            need_upload: true,
            fail_nos: false,
            resource_id: serde_json::json!(987654321),
            info_resource_id: None,
            info_song_id: serde_json::json!(42),
            published_song_id: None,
            publish_code: Some(200),
            lbs_url: "http://nosup-jd1.127.net/".into(),
            nos_url: None,
            calls: vec![],
        };
        assert_eq!(
            upload_result_with(&path, "title", "artist", "album", None, &mut signed_out).0,
            "skipped_not_signed_in"
        );
        assert!(signed_out.calls.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn info_song_id_string_is_forwarded_unchanged_and_pub_success_code_is_checked() {
        let path = fixture_wav();
        let mut mock = MockCloud {
            need_upload: false,
            fail_nos: false,
            resource_id: serde_json::json!(987654321),
            info_resource_id: None,
            info_song_id: serde_json::json!("42001"),
            published_song_id: None,
            publish_code: Some(200),
            lbs_url: "http://nosup-jd1.127.net/".into(),
            nos_url: None,
            calls: vec![],
        };
        let result = upload_result_with(
            &path,
            "title",
            "artist",
            "album",
            Some("fixture-cookie"),
            &mut mock,
        );
        assert_eq!(result.0, "uploaded");
        assert_eq!(mock.published_song_id, Some(serde_json::json!("42001")));
        assert!(!mock.calls.contains(&"nos".into()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pub_code_500_is_reported_as_upload_failure_and_local_file_is_preserved() {
        let path = fixture_wav();
        let mut mock = MockCloud {
            need_upload: false,
            fail_nos: false,
            resource_id: serde_json::json!(987654321),
            info_resource_id: None,
            info_song_id: serde_json::json!(42),
            published_song_id: None,
            publish_code: Some(500),
            lbs_url: "http://nosup-jd1.127.net/".into(),
            nos_url: None,
            calls: vec![],
        };
        let result = upload_result_with(
            &path,
            "title",
            "artist",
            "album",
            Some("fixture-cookie"),
            &mut mock,
        );
        assert_eq!(result.0, "failed_local_preserved");
        assert_eq!(
            result.1.as_deref(),
            Some("网易云 pub response was not successful (code=500)")
        );
        assert!(path.is_file());
        assert_eq!(mock.published_song_id, Some(serde_json::json!(42)));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pub_response_without_code_is_not_reported_as_uploaded() {
        let path = fixture_wav();
        let mut mock = MockCloud {
            need_upload: false,
            fail_nos: false,
            resource_id: serde_json::json!(987654321),
            info_resource_id: None,
            info_song_id: serde_json::json!(42),
            published_song_id: None,
            publish_code: None,
            lbs_url: "http://nosup-jd1.127.net/".into(),
            nos_url: None,
            calls: vec![],
        };
        let result = upload_result_with(
            &path,
            "title",
            "artist",
            "album",
            Some("fixture-cookie"),
            &mut mock,
        );
        assert_eq!(result.0, "failed_local_preserved");
        assert_eq!(
            result.1.as_deref(),
            Some("网易云 pub response was not successful (code=missing-or-nonnumeric)")
        );
        assert!(path.is_file());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn lbs_rejects_untrusted_scheme_and_nondefault_port() {
        for lbs_url in [
            "https://attacker.example/",
            "ftp://nosup-jd1.127.net/",
            "http://nosup-jd1.127.net:8080/",
        ] {
            let path = fixture_wav();
            let mut mock = MockCloud {
                need_upload: true,
                fail_nos: false,
                resource_id: serde_json::json!(987654321),
                info_resource_id: None,
                info_song_id: serde_json::json!(42),
                published_song_id: None,
                publish_code: Some(200),
                lbs_url: lbs_url.into(),
                nos_url: None,
                calls: vec![],
            };
            let result = upload_result_with(
                &path,
                "title",
                "artist",
                "album",
                Some("fixture-cookie"),
                &mut mock,
            );
            assert_eq!(result.0, "failed_local_preserved", "{lbs_url}");
            let error = result.1.unwrap();
            assert!(
                error.contains("scheme=") && error.contains("host="),
                "{error}"
            );
            assert!(
                !mock.calls.contains(&"nos".into()),
                "Rejected LBS URL must never reach NOS"
            );
            assert!(
                path.exists(),
                "Rejected upload must retain the local accompaniment"
            );
            let _ = fs::remove_file(path);
        }
    }
}
