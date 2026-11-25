use crate::{commands::{import_online_tracks, OnlineTrackRow}, netease};
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeSet, path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    local_likes: BTreeSet<(i64, i64)>,
    online_likes: BTreeSet<(String, String, i64)>,
    playlists: BTreeSet<(i64, String, i64, i64)>,
    items: BTreeSet<(i64, i64, i64, String, String)>,
}

fn snapshot(conn: &Connection) -> rusqlite::Result<Snapshot> {
    let local_likes = conn.prepare("SELECT track_id,liked_at FROM liked")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let online_likes = conn.prepare("SELECT kind,rid,liked_at FROM liked_online")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let playlists = conn.prepare("SELECT id,name,created_at,sort_pos FROM playlists")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let items = conn.prepare("SELECT playlist_id,track_id,position,kind,online_id FROM playlist_tracks")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Snapshot { local_likes, online_likes, playlists, items })
}

fn preserves(before: &Snapshot, after: &Snapshot) -> bool {
    before.local_likes.is_subset(&after.local_likes)
        && before.online_likes.is_subset(&after.online_likes)
        && before.playlists.is_subset(&after.playlists)
        && before.items.is_subset(&after.items)
}

#[test]
#[ignore = "Requires completed QR login and explicit existing player database; merges live account data"]
fn sync_signed_in_account_into_current_library() {
    let database = PathBuf::from(std::env::var("RUSTMUSIC_QR_DATABASE")
        .expect("Set the existing player library database explicitly"));
    let output = PathBuf::from(std::env::var("RUSTMUSIC_QR_OUTPUT")
        .expect("Set an absolute directory for the non-sensitive report"));
    assert!(database.is_absolute() && database.is_file(), "Existing absolute database required");
    assert!(output.is_absolute(), "Absolute report directory required");
    let login: serde_json::Value = serde_json::from_slice(
        &std::fs::read(output.join("status.json")).expect("QR login status required"),
    ).expect("Valid QR login status");
    assert_eq!(login["status"], "success", "Complete this QR login before merging");
    assert_eq!(login["database"].as_str(), database.to_str(), "QR database must match");
    let token = crate::credentials::get("netease_music_u").expect("Complete QR login first");
    let uid = netease::resolve_uid(&token).unwrap_or_else(|_| panic!("Saved QR login validation failed"));
    assert_eq!(login["uid"].as_i64(), Some(uid), "Saved session must match scanned account");
    let mut warnings = Vec::<String>::new();
    let like_ids = match netease::like_list(uid, &token) {
        Ok(ids) => ids,
        Err(_) => { warnings.push("Favorite ID fetch failed".into()); Vec::new() }
    };
    let likes = match netease::songs_by_ids(&like_ids, &token) {
        Ok(songs) => songs,
        Err(error) => {
            let message = error.replace(&token, "[redacted]");
            warnings.push(format!("Favorite details fetch failed: {message}"));
            Vec::new()
        }
    };
    let returned_ids: BTreeSet<_> = likes.iter().map(|s| s.id).collect();
    if like_ids.iter().any(|id| !returned_ids.contains(id)) {
        warnings.push(format!("Favorite details incomplete: requested {}, returned {}", like_ids.len(), likes.len()));
    }
    let lists = match netease::user_playlists(uid, &token) {
        Ok(lists) => lists,
        Err(_) => { warnings.push("Playlist list fetch failed".into()); Vec::new() }
    };
    let playlist_total = lists.len();
    let mut fetched = Vec::new();
    for list in lists {
        match netease::playlist_tracks(list.id, &token) {
            Ok(songs) => {
                if songs.len() as i64 != list.track_count as i64 {
                    warnings.push(format!("Playlist {} details incomplete: expected {}, returned {}", list.id, list.track_count, songs.len()));
                }
                let tracks: Vec<_> = songs.iter().map(|song| OnlineTrackRow {
                    rid: song.id.to_string(),
                    title: song.name.clone(),
                    artist: song.artist_str(),
                    album: song.album_name(),
                    cover: song.cover_url().unwrap_or_default(),
                    duration_ms: song.duration_ms(),
                    media_mid: String::new(),
                    vip: song.fee == 1 || song.fee == 4,
                }).collect();
                fetched.push((list.id.to_string(), list.name, tracks));
            }
            Err(_) => warnings.push(format!("Playlist {} track fetch failed", list.id)),
        }
    }
    // Opening with READ_WRITE cannot accidentally create a second empty library.
    let conn = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .expect("Open actual player database");
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    let before = snapshot(&conn).expect("Read existing library before modification");
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let backup = database.with_file_name(format!("library.before-qr-sync-{nonce}-{}.db", std::process::id()));
    conn.execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
        .expect("Create consistent unique backup before any writes");
    assert!(backup.is_file(), "Backup must exist before account sync");
    let backup_conn = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert!(snapshot(&backup_conn).unwrap() == before, "Backup must preserve the starting library");
    drop(backup_conn);
    conn.execute(
        "INSERT INTO settings(key,value) VALUES('netease_uid',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [uid.to_string()],
    ).expect("Persist signed-in account UID");
    if super::merge_favorites(&conn, &likes).is_err() {
        warnings.push("Favorite merge failed".into());
    }
    let mut imported = Vec::new();
    let mut added_tracks = 0;
    for (remote_id, name, tracks) in &fetched {
        match import_online_tracks(&conn, "netease", remote_id, name, tracks) {
            Ok((pid, added)) => {
                added_tracks += added;
                imported.push((pid, remote_id, name, tracks));
            }
            Err(_) => warnings.push(format!("Playlist {remote_id} merge failed")),
        }
    }
    let mut missing_favorites = 0;
    for song in &likes {
        let present: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM liked_online l JOIN online_tracks o ON o.kind=l.kind AND o.rid=l.rid WHERE l.kind='netease' AND l.rid=?1)",
            [song.id.to_string()], |r| r.get(0),
        ).unwrap();
        if !present { missing_favorites += 1; }
    }
    if missing_favorites > 0 {
        warnings.push(format!("{missing_favorites} returned favorites were not persisted"));
    }
    let mut missing_playlist_tracks = 0;
    for (pid, _, _, tracks) in &imported {
        for track in tracks.iter() {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM playlist_tracks p JOIN online_tracks o ON o.kind=p.kind AND o.rid=p.online_id WHERE p.playlist_id=?1 AND p.kind='netease' AND p.online_id=?2)",
                rusqlite::params![pid, track.rid], |r| r.get(0),
            ).unwrap();
            if !present { missing_playlist_tracks += 1; }
        }
    }
    if missing_playlist_tracks > 0 {
        warnings.push(format!("{missing_playlist_tracks} returned playlist tracks were not persisted"));
    }
    let after = snapshot(&conn).expect("Read merged library");
    let preserved = preserves(&before, &after);
    // Repeat the exact production merge to prove additions do not duplicate or reorder.
    if super::merge_favorites(&conn, &likes).is_err() {
        warnings.push("Repeated favorite merge failed".into());
    }
    for (_, remote_id, name, tracks) in &imported {
        if import_online_tracks(&conn, "netease", remote_id, name, tracks).is_err() {
            warnings.push(format!("Playlist {remote_id} repeated merge failed"));
        }
    }
    let repeated = snapshot(&conn).expect("Read repeated merge");
    let idempotent = after == repeated;
    drop(conn);
    let reopened = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    reopened.busy_timeout(Duration::from_secs(5)).unwrap();
    let persisted = snapshot(&reopened).expect("Read closed and reopened library") == repeated;
    let saved_uid: String = reopened.query_row(
        "SELECT value FROM settings WHERE key='netease_uid'", [], |r| r.get(0),
    ).unwrap();
    let uid_persisted = saved_uid == uid.to_string();
    std::fs::create_dir_all(&output).unwrap();
    let report = serde_json::json!({
        "uid": uid,
        "status": if warnings.is_empty() && preserved && idempotent && persisted && uid_persisted { "complete" } else { "partial_or_failed" },
        "database": database,
        "backup": backup,
        "backup_matches_starting_library": true,
        "favorites_requested": like_ids.len(),
        "favorites_returned": likes.len(),
        "playlists_listed": playlist_total,
        "playlists_fetched": fetched.len(),
        "playlists_imported": imported.len(),
        "playlist_tracks_added": added_tracks,
        "missing_returned_favorites": missing_favorites,
        "missing_returned_playlist_tracks": missing_playlist_tracks,
        "before": {
            "local_favorites": before.local_likes.len(),
            "online_favorites": before.online_likes.len(),
            "playlists": before.playlists.len(),
            "playlist_items": before.items.len()
        },
        "after": {
            "local_favorites": after.local_likes.len(),
            "online_favorites": after.online_likes.len(),
            "playlists": after.playlists.len(),
            "playlist_items": after.items.len()
        },
        "existing_favorites_names_items_positions_preserved": preserved,
        "repeated_merge_idempotent": idempotent,
        "close_reopen_preserved": persisted,
        "uid_persisted": uid_persisted,
        "warnings": warnings,
    });
    let report_path = output.join(format!("qr-account-sync-{nonce}.json"));
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("QR account sync report: {}", report_path.display());
    assert!(preserved, "Existing library preservation failed; consult report and backup");
    assert!(idempotent, "Repeated merge changed library content; consult report");
    assert!(persisted && uid_persisted, "Reopened database did not preserve sync");
    assert!(warnings.is_empty(), "Account sync was partial; consult non-sensitive report");
}

fn field_issue(
    parent: &serde_json::Value, key: &str, path: String, expected: &str, required: bool,
    issues: &mut Vec<serde_json::Value>,
) {
    let value = parent.get(key);
    let actual = match value {
        None if !required => return,
        None => "missing",
        Some(serde_json::Value::Null) => "null",
        Some(v) if (expected == "string" && v.is_string())
            || (expected == "integer" && v.as_i64().is_some())
            || (expected == "object" && v.is_object())
            || (expected == "array" && v.is_array()) => return,
        Some(serde_json::Value::String(_)) => "string",
        Some(serde_json::Value::Number(_)) => "number",
        Some(serde_json::Value::Bool(_)) => "boolean",
        Some(serde_json::Value::Array(_)) => "array",
        Some(_) => "object",
    };
    issues.push(serde_json::json!({"field": path, "expected": expected, "actual": actual}));
}

fn inspect_song_metadata(song: &serde_json::Value) -> serde_json::Value {
    let mut issues = Vec::new();
    let mut normalized = song.clone();
    for (key, expected, required) in [
        ("id", "integer", true), ("name", "string", true),
        ("ar", "array", false), ("artists", "array", false),
        ("ar_legacy", "array", false), ("al", "object", false),
        ("dt", "integer", false), ("duration", "integer", false),
        ("dt_legacy", "integer", false), ("fee", "integer", false),
    ] {
        field_issue(song, key, key.into(), expected, required, &mut issues);
        if !required && song.get(key).is_some_and(serde_json::Value::is_null) {
            normalized.as_object_mut().unwrap().remove(key);
        }
    }
    for key in ["ar", "artists", "ar_legacy"] {
        if let Some(artists) = song.get(key).and_then(serde_json::Value::as_array) {
            for (i, artist) in artists.iter().enumerate() {
                field_issue(artist, "name", format!("{key}[{i}].name"), "string", false, &mut issues);
                if artist.get("name").is_some_and(serde_json::Value::is_null) {
                    if let Some(object) = normalized.get_mut(key)
                        .and_then(serde_json::Value::as_array_mut)
                        .and_then(|a| a.get_mut(i))
                        .and_then(serde_json::Value::as_object_mut) {
                        object.remove("name");
                    }
                }
            }
        }
    }
    if let Some(album) = song.get("al").filter(|v| v.is_object()) {
        field_issue(album, "name", "al.name".into(), "string", false, &mut issues);
        if album.get("name").is_some_and(serde_json::Value::is_null) {
            normalized.get_mut("al").unwrap().as_object_mut().unwrap().remove("name");
        }
        if album.get("picUrl").is_some_and(|v| !v.is_null()) {
            field_issue(album, "picUrl", "al.picUrl".into(), "string", false, &mut issues);
        }
    }
    serde_json::json!({
        "id": song.get("id").and_then(serde_json::Value::as_i64),
        "returned_by_provider": true,
        "current_model_parses": serde_json::from_value::<netease::NetSong>(song.clone()).is_ok(),
        "parses_after_null_default_normalization": serde_json::from_value::<netease::NetSong>(normalized).is_ok(),
        "real_title_present": song.get("name").and_then(serde_json::Value::as_str).is_some_and(|s| !s.is_empty()),
        "field_issues": issues,
        "playback_availability": "not_tested",
    })
}

#[test]
fn metadata_diagnosis_distinguishes_nullable_optional_fields_from_missing_real_titles() {
    let optional_null = inspect_song_metadata(&serde_json::json!({
        "id": 42, "name": "Real provider title", "al": {"name": null},
    }));
    assert_eq!(optional_null["current_model_parses"], true,
        "The production parser now accepts the observed nullable optional label");
    assert_eq!(optional_null["parses_after_null_default_normalization"], true,
        "A nullable optional album label is a parser compatibility issue, not proof of an unavailable song");
    assert_eq!(optional_null["field_issues"][0]["field"], "al.name");
    let required_null = inspect_song_metadata(&serde_json::json!({"id": 43, "name": null}));
    assert_eq!(required_null["parses_after_null_default_normalization"], false,
        "Diagnosis must not invent a title to make an unavailable record look complete");
}

#[test]
#[ignore = "Read-only live diagnosis of favorites absent from the explicitly selected player database"]
fn diagnose_missing_signed_in_favorite_metadata_read_only() {
    let database = PathBuf::from(std::env::var("RUSTMUSIC_QR_DATABASE").expect("Explicit database required"));
    let output = PathBuf::from(std::env::var("RUSTMUSIC_QR_OUTPUT").expect("Absolute report directory required"));
    assert!(database.is_absolute() && database.is_file() && output.is_absolute());
    let token = crate::credentials::get("netease_music_u").expect("Complete QR login first");
    let uid = netease::resolve_uid(&token).unwrap_or_else(|_| panic!("Saved login validation failed"));
    let ids = netease::like_list(uid, &token).unwrap_or_else(|_| panic!("Favorite ID fetch failed"));
    let conn = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let present: BTreeSet<String> = conn.prepare("SELECT rid FROM liked_online WHERE kind='netease'").unwrap()
        .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    drop(conn);
    let missing: Vec<i64> = ids.iter().copied().filter(|id| !present.contains(&id.to_string())).collect();
    assert!(missing.len() <= 10, "Expected a small diagnostic difference; refusing broad detail fetch");
    let mut findings = Vec::new();
    for id in &missing {
        let payload = serde_json::json!({
            "c": serde_json::to_string(&vec![serde_json::json!({"id": id})]).unwrap(),
            "ids": serde_json::to_string(&vec![id]).unwrap(), "csrf_token": "",
        });
        let response = netease::weapi_post("/weapi/v3/song/detail", &payload.to_string(), Some(&token))
            .unwrap_or_else(|_| panic!("Diagnostic detail request failed; no raw response logged"));
        let code = response.get("code").and_then(serde_json::Value::as_i64);
        let row = response.get("songs").and_then(serde_json::Value::as_array)
            .and_then(|songs| songs.iter().find(|s| s.get("id").and_then(serde_json::Value::as_i64) == Some(*id)));
        findings.push(match row {
            Some(song) => inspect_song_metadata(song),
            None => serde_json::json!({
                "id": id, "returned_by_provider": false, "provider_code": code,
                "classification": "not_returned_by_detail_endpoint",
                "playback_availability": "not_tested",
            }),
        });
    }
    std::fs::create_dir_all(&output).unwrap();
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let report = serde_json::json!({
        "read_only": true, "favorite_ids_count": ids.len(), "missing_ids": missing,
        "findings": findings, "credentials_and_raw_response_saved": false,
    });
    let report_path = output.join(format!("qr-favorite-metadata-diagnosis-{nonce}.json"));
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("Read-only favorite metadata diagnosis: {}", report_path.display());
}
