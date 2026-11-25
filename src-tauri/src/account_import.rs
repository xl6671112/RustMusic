//! Explicit, read-only import of a selected ListenFree profile's NetEase account.
//! Never enumerate credentials, delete reference data, or replace a different account.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;
use crate::{db, netease, AppState};

#[cfg(test)]
#[path = "account_qr_login.rs"]
mod qr_login;
#[cfg(test)]
#[path = "account_qr_sync.rs"]
mod qr_sync;
fn credential_target(profile: &str) -> String {
    let normalized = profile.replace('\\', "/");
    format!("ListenFree/{}/netease", &hex::encode(Sha256::digest(normalized.as_bytes()))[..24])
}

fn music_u(cookie: &str) -> Result<String, String> {
    cookie.split([';', '\r', '\n'])
        .filter_map(|part| part.trim().strip_prefix("Cookie:").unwrap_or(part.trim()).trim().split_once('='))
        .find_map(|(key, value)| (key.trim() == "MUSIC_U" && !value.trim().is_empty()).then(|| value.trim().to_string()))
        .filter(|value| !value.chars().any(char::is_control))
        .ok_or_else(|| "原账号凭据缺少 MUSIC_U，请先在参考播放器登录".into())
}

#[cfg(windows)]
fn read_reference_cookie(target: &str) -> Result<String, String> {
    use std::{ffi::c_void, ptr, slice};
    #[repr(C)]
    struct Attribute { keyword: *mut u16, flags: u32, size: u32, value: *mut u8 }
    #[repr(C)]
    struct Credential {
        flags: u32, kind: u32, target: *mut u16, comment: *mut u16,
        written: [u32; 2], size: u32, blob: *mut u8, persist: u32,
        count: u32, attributes: *mut Attribute, alias: *mut u16, user: *mut u16,
    }
    #[repr(C)]
    struct Blob { size: u32, data: *mut u8 }
    #[link(name = "Advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, value: *mut *mut Credential) -> i32;
        fn CredFree(value: *mut c_void);
    }
    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob,
            reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" { fn LocalFree(value: *mut c_void) -> *mut c_void; }
    struct CredentialGuard(*mut Credential);
    impl Drop for CredentialGuard {
        fn drop(&mut self) { unsafe { CredFree(self.0.cast()); } }
    }
    let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let mut raw = ptr::null_mut();
    // This is the one explicitly selected profile, not an enumeration of the vault.
    if unsafe { CredReadW(wide.as_ptr(), 1, 0, &mut raw) } == 0 {
        return Err("此原播放器配置目录没有已保存的网易云登录态；请选择实际使用的 data 目录".into());
    }
    let _guard = CredentialGuard(raw);
    let credential = unsafe { &*raw };
    if credential.size == 0 || credential.size > 2560 || credential.count > 64 {
        return Err("原账号凭据长度无效".into());
    }
    let mut bytes = unsafe { slice::from_raw_parts(credential.blob, credential.size as usize).to_vec() };
    if credential.count > 0 {
        let attributes = unsafe { slice::from_raw_parts(credential.attributes, credential.count as usize) };
        for index in 0..credential.count {
            let name: Vec<u16> = format!("ListenFree_CookiePart_{index:02}").encode_utf16().chain(Some(0)).collect();
            let attribute = attributes.iter().find(|attr| {
                if attr.keyword.is_null() { return false; }
                name.iter().enumerate().all(|(i, ch)| unsafe { *attr.keyword.add(i) == *ch })
            }).ok_or("原账号凭据分片缺失")?;
            if attribute.size == 0 || attribute.size > 256 { return Err("原账号凭据分片长度无效".into()); }
            bytes.extend_from_slice(unsafe { slice::from_raw_parts(attribute.value, attribute.size as usize) });
        }
        let input = Blob { size: bytes.len() as u32, data: bytes.as_mut_ptr() };
        let mut output = Blob { size: 0, data: ptr::null_mut() };
        if unsafe { CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) } == 0 {
            bytes.fill(0);
            return Err("无法解密所选原账号的本机凭据".into());
        }
        bytes.fill(0);
        bytes = unsafe { slice::from_raw_parts(output.data, output.size as usize).to_vec() };
        unsafe {
            ptr::write_bytes(output.data, 0, output.size as usize);
            LocalFree(output.data.cast());
        }
    }
    let parsed = std::str::from_utf8(&bytes).map_err(|_| "原账号凭据编码无效".to_string()).and_then(music_u);
    bytes.fill(0);
    parsed
}

#[cfg(not(windows))]
fn read_reference_cookie(_: &str) -> Result<String, String> {
    Err("ListenFree 原账号导入目前仅支持 Windows 凭据管理器".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    uid: i64,
    favorites: usize,
    playlists: usize,
    added_tracks: i64,
    warnings: Vec<String>,
}

fn merge_favorites(conn: &rusqlite::Connection, songs: &[netease::NetSong]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for song in songs {
        let rid = song.id.to_string();
        db::upsert_online_track(&tx, "netease", &rid, &song.name, &song.artist_str(),
            &song.album_name(), &song.cover_url().unwrap_or_default(), song.duration_ms(), "", song.fee == 1 || song.fee == 4);
        // Check the reused helper's write before calling the import successful.
        let _: i64 = tx.query_row("SELECT id FROM online_tracks WHERE kind='netease' AND rid=?1", [&rid], |r| r.get(0)).map_err(|e| e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO liked_online(kind,rid,liked_at) VALUES('netease',?1,strftime('%s','now'))", [&rid]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_reference_account(app: tauri::AppHandle, profile: String) -> Result<ImportResult, String> {
    crate::commands::blocking(move || {
        let path = Path::new(&profile);
        if !path.is_absolute() || !path.join("library.sqlite").is_file() {
            return Err("请选择原播放器包含 library.sqlite 的绝对配置目录".into());
        }
        let token = read_reference_cookie(&credential_target(&profile))?;
        let uid = netease::resolve_uid(&token)?;
        let state = app.state::<AppState>();
        if let Some(current) = crate::credentials::get("netease_music_u") {
            if netease::resolve_uid(&current)? != uid {
                return Err("当前已登录另一个网易云账号。为保留现有账号，请先退出后再导入".into());
            }
        }
        let ids = netease::like_list(uid, &token)?;
        let likes = netease::songs_by_ids(&ids, &token)?;
        let lists = netease::user_playlists(uid, &token)?;
        let mut result = ImportResult { uid, favorites: likes.len(), playlists: 0, added_tracks: 0, warnings: Vec::new() };
        if likes.len() != ids.len() {
            result.warnings.push(format!("收藏共 {} 首，平台仅返回 {} 首详情；缺失项未伪造导入", ids.len(), likes.len()));
        }
        // Validate before saving; do not clear any existing account or collection.
        crate::credentials::set("netease_music_u", &token)?;
        {
            let conn = state.db.lock();
            conn.execute("INSERT INTO settings(key,value) VALUES('netease_uid',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [uid.to_string()]).map_err(|e| e.to_string())?;
            merge_favorites(&conn, &likes)?;
        }
        for list in lists {
            match crate::commands::netease_import_playlist_task(&app, list.id, list.name.clone()) {
                Ok((_, added)) => { result.playlists += 1; result.added_tracks += added; }
                Err(error) => result.warnings.push(format!("歌单「{}」未导入：{error}", list.name)),
            }
        }
        Ok(result)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_values_keep_equals_and_are_not_returned_as_headers() {
        assert_eq!(music_u("other=x; MUSIC_U=abc==; __csrf=z").unwrap(), "abc==");
        assert!(music_u("other=x").is_err());
        assert!(music_u("MUSIC_U=a\tb").is_err());
    }
    #[test]
    fn profile_key_matches_qt_forward_slash_sha256() {
        assert_eq!(credential_target(r"C:\Player\data"), credential_target("C:/Player/data"));
        assert_ne!(credential_target("C:/Player/data"), credential_target("C:/Other/data"));
    }
    #[test]
    fn importing_favorites_merges_without_removing_existing_or_duplicate_rows() {
        let path = std::env::temp_dir().join(format!("rustmusic-account-{}.sqlite", rand::random::<u64>()));
        let conn = db::init(&path).unwrap();
        conn.execute("INSERT INTO liked_online(kind,rid,liked_at) VALUES('qq','old',1)", []).unwrap();
        let song: netease::NetSong = serde_json::from_value(serde_json::json!({"id":42,"name":"real metadata"})).unwrap();
        merge_favorites(&conn, &[song.clone()]).unwrap();
        merge_favorites(&conn, &[song]).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM liked_online", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2, "Import must preserve prior favorites and be idempotent");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "Reads only an explicitly selected reference profile and calls the live provider"]
    fn selected_reference_account_live_read_only() {
        let profile = std::env::var("RUSTMUSIC_REFERENCE_PROFILE").expect("Set the original profile directory explicitly");
        let token = read_reference_cookie(&credential_target(&profile)).expect("Reference saved login");
        let uid = netease::resolve_uid(&token).expect("Live account validation");
        let likes = netease::like_list(uid, &token).expect("Live favorites");
        let lists = netease::user_playlists(uid, &token).expect("Live playlists");
        let songs = netease::songs_by_ids(&likes.iter().copied().take(5).collect::<Vec<_>>(), &token).expect("Live favorite metadata");
        eprintln!("Read-only provider check: {} favorites, {} playlists, {} sampled song details; no credentials or profile data modified", likes.len(), lists.len(), songs.len());
    }
}
