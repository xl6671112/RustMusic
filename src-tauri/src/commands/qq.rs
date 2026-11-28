//! QQ 音乐：搜索 / 播放取链 / 扫码登录 / 歌词 / 榜单歌单

use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::db;
use crate::engine::TrackInfo;
use crate::lyrics;
use crate::models::LyricsPayload;
use crate::AppState;

use super::{engine_clone, notify_quality_fallback};

static QQ_SESSION_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn load_qq_session(state: &State<AppState>) -> Result<crate::qq::QqSession, String> {
    let musicid = {
        let conn = state.db.lock();
        db::get_setting(&conn, "qq_musicid").unwrap_or_default()
    };
    let saved = crate::credentials::get("qq_session")
        .and_then(|json| serde_json::from_str::<crate::qq::QqSession>(&json).ok())
        .filter(|session| session.musicid == musicid && !session.musickey.is_empty());
    let session = saved.unwrap_or_else(|| {
        crate::qq::QqSession::legacy(
            musicid,
            crate::credentials::get("qq_musickey").unwrap_or_default(),
        )
    });
    if session.musicid.is_empty() || session.musickey.is_empty() {
        return Err(crate::i18n::pick(
            "未登录 QQ 音乐账号，无法获取播放链接，请先扫码登录",
            "Not signed in to QQ Music. Scan QR code to sign in first.",
        ).into());
    }
    Ok(session)
}

fn store_qq_session(state: &State<AppState>, session: &crate::qq::QqSession) -> Result<(), String> {
    let json = serde_json::to_string(session).map_err(|e| e.to_string())?;
    // One secure entry keeps the account and all rotating tokens together across restarts.
    crate::credentials::set("qq_session", &json)?;
    let conn = state.db.lock();
    db::set_setting(&conn, "qq_musicid", &session.musicid);
    if crate::credentials::set("qq_musickey", &session.musickey).is_err() {
        eprintln!("[qq] failed to update legacy credential mirror; complete session is saved");
    }
    Ok(())
}

// ---------- QQ 音乐在线曲库 ----------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QqPlayReq {
    pub songmid: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub album_mid: String,
    #[serde(default)]
    pub media_mid: String,
    #[serde(default)]
    pub duration_ms: u64,
    /// 搜索结果里的 VIP 标志，用于播放失败分类（权益不足 vs 真无版权）
    #[serde(default)]
    pub vip: bool,
}

pub(crate) fn qq_credential(state: &State<AppState>) -> Result<(String, String), String> {
    let _guard = QQ_SESSION_LOCK.lock();
    let session = load_qq_session(state)?;
    Ok((session.musicid, session.musickey))
}

pub(crate) fn qq_song_url(
    state: &State<AppState>, songmid: &str, media_mid: &str, quality: &str, vip: bool,
) -> Result<(String, String, &'static str), String> {
    let (session, renewal_attempted) = {
        let _guard = QQ_SESSION_LOCK.lock();
        let session = load_qq_session(state)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_secs();
        if session.refresh_due(now) {
            match session.refresh() {
                Ok(next) => { store_qq_session(state, &next)?; (next, true) }
                Err(_) => {
                    eprintln!("[qq] session renewal failed; retaining stored credentials");
                    (session, true)
                }
            }
        } else { (session, false) }
    };
    crate::qq::with_session_retry(&session, renewal_attempted, |session| {
        crate::qq::song_url_authenticated(songmid, media_mid, &session.musicid, &session.musickey, quality, vip)
    }, |error| {
        let _guard = QQ_SESSION_LOCK.lock();
        let current = load_qq_session(state)?;
        if current.musicid != session.musicid {
            return Err(crate::i18n::pick("QQ 音乐账号已切换，请重新播放", "QQ Music account changed. Please play again.").into());
        }
        if current.musickey != session.musickey {
            Ok(current)
        } else {
            if !current.can_refresh() {
                return Err(error.to_string());
            }
            let next = current.refresh()?;
            store_qq_session(state, &next)?;
            Ok(next)
        }
    })
}

#[tauri::command]
pub async fn qq_search(keyword: String, page: Option<i64>) -> Result<serde_json::Value, String> {
    let songs = super::blocking(move || crate::qq::search(&keyword, 30, page.unwrap_or(1))).await?;
    Ok(json!({ "songs": songs }))
}

#[tauri::command]
pub async fn qq_play(app: AppHandle, track: QqPlayReq) -> Result<(), String> {
    let task_app = app.clone();
    super::blocking(move || qq_play_task(&task_app, track)).await
}

/// 同步任务体：取链是阻塞网络调用（经 blocking 在专用线程池执行）
fn qq_play_task(app: &AppHandle, track: QqPlayReq) -> Result<(), String> {
    let state = app.state::<AppState>();
    let quality_setting = {
        let conn = state.db.lock();
        super::source_quality(&conn, "qq")
    };
    let quality = super::resolve_quality("qq", &quality_setting);
    let (url, _ext, quality_label) = qq_song_url(
        &state,
        &track.songmid,
        &track.media_mid,
        &quality,
        track.vip,
    )?;
    notify_quality_fallback(
        app,
        "QQ 音乐",
        &quality_setting,
        quality_label,
        crate::i18n::pick(
            "账号权益未含该音质或该曲无对应音源版本",
            "membership doesn't include this quality or no matching track version exists",
        ),
    );
    // 封面优先用数据库存的完整 URL（歌单导入时已写入），缺失再拼 album_mid
    let cover = {
        let conn = state.db.lock();
        db::get_online_cover(&conn, "qq", &track.songmid).unwrap_or_else(|| {
            if track.album_mid.is_empty() {
                String::new()
            } else {
                format!(
                    "https://y.gtimg.cn/music/photo_new/T002R300x300M000{}.jpg",
                    track.album_mid
                )
            }
        })
    };
    let info = TrackInfo {
        id: None,
        kind: "qq".into(),
        path: String::new(),
        title: track.title.clone(),
        artist: track.artist.clone(),
        album: track.album.clone(),
        cover: cover.clone(),
        duration_ms: track.duration_ms,
        nid: None,
        qid: Some(track.songmid.clone()),
        kgid: None,
        quality: Some(quality_label.to_string()),
    };
    // 记录到“最近播放”（在线曲目元数据轻量入库）
    super::record_online_play(&state, &info, &track.media_mid, false);
    engine_clone(&state).play_url(url, info)
}

#[tauri::command]
pub async fn qq_lyric(
    app: AppHandle,
    songmid: String,
) -> Result<LyricsPayload, String> {
    let state = app.state::<AppState>();
    let cached = {
        let conn = state.db.lock();
        db::get_lyrics_cache(&conn, "qq", &songmid)
    };
    if let Some(json) = cached.as_deref() {
        if db::lyrics_cache_is_current(json) {
            if let Ok(p) = serde_json::from_str::<LyricsPayload>(json) {
                return Ok(p);
            }
        }
    }
    // 优先逐字歌词（QRC，需登录）；失败回落匿名行级接口
    let task_app = app.clone();
    let songmid_for_task = songmid.clone();
    let payload = super::blocking(move || -> Result<LyricsPayload, String> {
        let state = task_app.state::<AppState>();
        let cred = qq_credential(&state).ok();
        let songmid = songmid_for_task;
        if let Some((musicid, musickey)) = &cred {
            if let Ok(Some((enhanced, trans, roman))) = crate::qq::lyric_qrc(&songmid, musicid, musickey) {
                let mut p = lyrics::parse(&enhanced);
                if p.synced {
                    if let Some(t) = &trans {
                        lyrics::attach_translations(&mut p, t);
                    }
                    if let Some(roman) = &roman {
                        lyrics::attach_romanizations(&mut p, roman);
                    }
                    let mut payload = LyricsPayload::new(p.synced, p.lines);
                    payload.source = Some("逐字 QRC".into());
                    return Ok(payload);
                }
            }
            eprintln!("[qq] {songmid} QRC 不可用（无权益/解密失败），回落行级 LRC");
        }
        let lt = crate::qq::lyric(&songmid)?;
        let Some(lt) = lt else {
            return Ok(LyricsPayload::new(false, vec![]));
        };
        let mut p = lyrics::parse(&lt.lrc);
        if let Some(t) = &lt.trans {
            lyrics::attach_translations(&mut p, t);
        }
        if let Some(roman) = &lt.roman {
            lyrics::attach_romanizations(&mut p, roman);
        }
        let mut payload = LyricsPayload::new(p.synced, p.lines);
        if p.synced {
            payload.source = Some("行级 LRC".into());
        }
        Ok(payload)
    })
    .await;
    let payload = match payload {
        Ok(p) if !p.lines.is_empty() => p,
        result => {
            if let Some(p) = cached.and_then(|json| serde_json::from_str::<LyricsPayload>(&json).ok()) {
                return Ok(p);
            }
            return result;
        }
    };
    if !payload.lines.is_empty() {
        if let Ok(json) = serde_json::to_string(&payload) {
            let conn = state.db.lock();
            db::set_lyrics_cache(&conn, "qq", &songmid, &json);
        }
    }
    Ok(payload)
}
/// 登录成功后把凭证写入本机设置（QQ 扫码与微信扫码共用）
fn save_qq_credential(state: &State<AppState>, r: &crate::qq::QqQrCheck) -> Result<(), String> {
    if r.status != "success" {
        return Ok(());
    }
    if let (Some(musicid), Some(musickey)) = (&r.musicid, &r.musickey) {
        let _guard = QQ_SESSION_LOCK.lock();
        let session = r.session.clone()
            .unwrap_or_else(|| crate::qq::QqSession::legacy(musicid.clone(), musickey.clone()));
        store_qq_session(state, &session).map_err(|e| {
            crate::i18n::pick(
                format!("登录成功但凭据保存失败: {e}"),
                format!("Signed in, but failed to save credentials: {e}"),
            )
        })?;
        let conn = state.db.lock();
        // 拉取“我喜欢/收藏”夹需要加密 uin（登录响应里带，错过就没了）
        db::set_setting(&conn, "qq_encrypt_uin", r.encrypt_uin.as_deref().unwrap_or(""));
        db::set_setting(&conn, "qq_nickname", r.nickname.as_deref().unwrap_or(""));
        db::set_setting(&conn, "qq_wx_refresh_token", "");
        crate::credentials::clear("qq_wx_refresh_token");
    }
    Ok(())
}

#[tauri::command]
pub async fn qq_qr_create() -> Result<serde_json::Value, String> {
    let (qrsig, qr) = super::blocking(crate::qq::qr_create).await?;
    Ok(json!({ "qrsig": qrsig, "qr": qr }))
}

#[tauri::command]
pub async fn qq_qr_check(
    app: AppHandle,
    qrsig: String,
) -> Result<serde_json::Value, String> {
    super::blocking(move || {
        let r = crate::qq::qr_check(&qrsig)?;
        save_qq_credential(&app.state::<AppState>(), &r)?;
        Ok(json!({ "status": r.status, "nickname": r.nickname }))
    }).await
}

#[tauri::command]
pub async fn qq_wx_qr_create() -> Result<serde_json::Value, String> {
    let r = super::blocking(crate::qq::wx_qr_create).await?;
    Ok(json!({ "uuid": r.uuid, "qr": r.qr }))
}

/// 微信扫码状态：一次调用 = 一次长轮询（服务端挂起约 15s），前端循环调用
#[tauri::command]
pub async fn qq_wx_qr_check(
    app: AppHandle,
    uuid: String,
) -> Result<serde_json::Value, String> {
    super::blocking(move || {
        let r = crate::qq::wx_qr_check(&uuid)?;
        save_qq_credential(&app.state::<AppState>(), &r)?;
        Ok(json!({ "status": r.status, "nickname": r.nickname }))
    }).await
}

#[tauri::command]
pub async fn qq_status(app: AppHandle) -> Result<serde_json::Value, String> {
    super::blocking(move || {
        let state = app.state::<AppState>();
        let logged_in = qq_credential(&state).is_ok();
        let conn = state.db.lock();
        let nickname = db::get_setting(&conn, "qq_nickname").unwrap_or_default();
        Ok(json!({ "loggedIn": logged_in, "nickname": nickname }))
    }).await
}

#[tauri::command]
pub async fn qq_logout(app: AppHandle) -> Result<(), String> {
    super::blocking(move || {
        let state = app.state::<AppState>();
        let _guard = QQ_SESSION_LOCK.lock();
        let conn = state.db.lock();
        db::set_setting(&conn, "qq_musicid", "");
        crate::credentials::clear("qq_musickey");
        crate::credentials::clear("qq_session");
        crate::credentials::clear("qq_wx_refresh_token");
        db::set_setting(&conn, "qq_wx_refresh_token", "");
        db::set_setting(&conn, "qq_encrypt_uin", "");
        db::set_setting(&conn, "qq_nickname", "");
        Ok(())
    }).await
}

// ---------- 榜单 / 随机推荐（网易云、QQ，匿名可用） ----------

#[tauri::command]
pub async fn qq_toplists() -> Result<serde_json::Value, String> {
    let toplists = super::blocking(crate::qq::toplists).await?;
    Ok(json!({ "toplists": toplists }))
}

#[tauri::command]
pub async fn qq_toplist_tracks(
    top_id: i64,
    page: Option<i64>,
) -> Result<serde_json::Value, String> {
    let page = page.unwrap_or(1).max(1);
    let songs = super::blocking(move || crate::qq::toplist_tracks(top_id, page)).await?;
    Ok(json!({ "songs": songs, "hasMore": songs.len() as i64 >= 100 }))
}

#[tauri::command]
pub async fn qq_random_playlist() -> Result<crate::qq::QqPublicPlaylist, String> {
    super::blocking(crate::qq::random_playlist).await
}

#[tauri::command]
pub async fn qq_user_playlists(
    app: AppHandle,
) -> Result<Vec<crate::models::UserPlaylistMeta>, String> {
    super::blocking(move || {
        let (musicid, musickey) = qq_credential(&app.state::<AppState>())?;
        crate::qq::user_playlists(&musicid, &musickey)
    }).await
}

/// 导入 QQ 音乐歌单：远程 dissid 拉曲目 → 查找/合并/创建本地播放列表。
/// 语义与网易云版一致：已有列表去重合并、顺序不动，新歌追加末尾。
/// 返回 (本地播放列表 id, 本次实际新增条数)
#[tauri::command]
pub async fn qq_import_playlist(
    app: AppHandle,
    remote_pid: i64,
    name: String,
) -> Result<(i64, i64), String> {
    let task_app = app.clone();
    super::blocking(move || qq_import_playlist_task(&task_app, remote_pid, name)).await
}

/// 同步任务体：歌单拉取是阻塞网络调用（经 blocking 在专用线程池执行）
fn qq_import_playlist_task(
    app: &AppHandle,
    remote_pid: i64,
    name: String,
) -> Result<(i64, i64), String> {
    let state = app.state::<AppState>();
    let (musicid, musickey) = qq_credential(&state)?;
    let stored_euin = {
        let conn = state.db.lock();
        db::get_setting(&conn, "qq_encrypt_uin").unwrap_or_default()
    };
    let songs = crate::qq::playlist_tracks(
        remote_pid,
        &musicid,
        &musickey,
        &crate::qq::encrypt_uin_of(&musicid, &stored_euin),
    )?;
    let rows: Vec<super::playlists::OnlineTrackRow> = songs
        .iter()
        .map(|t| super::playlists::OnlineTrackRow {
            rid: t.id.clone(),
            title: t.name.clone(),
            artist: t.singer.clone(),
            album: t.album.clone(),
            // 封面按 album_mid 拼 CDN 规则 URL（导入时即写入完整地址）
            cover: format!(
                "https://y.gtimg.cn/music/photo_new/T002R300x300M000{}.jpg",
                t.album_mid
            ),
            duration_ms: t.duration_ms as i64,
            media_mid: t.media_mid.clone(),
            vip: t.vip,
        })
        .collect();
    let (list_id, added) = {
        let conn = state.db.lock();
        super::playlists::import_online_tracks(&conn, "qq", &remote_pid.to_string(), &name, &rows)?
    };
    Ok((list_id, added))
}
