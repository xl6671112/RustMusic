//! Explicit QR login, driven through the existing provider API without UI input.
use super::*;
use base64::Engine as _;
use serde_json::json;
use std::{fs, path::PathBuf, time::{Duration, Instant}};

#[test]
#[ignore = "requires the user to scan a QR code; saves the authorized login to the current player"]
fn qr_login_to_current_player() {
    let folder = PathBuf::from(std::env::var_os("RUSTMUSIC_QR_OUTPUT").expect("QR output directory"));
    let database = PathBuf::from(std::env::var_os("RUSTMUSIC_QR_DATABASE").expect("current library.db"));
    assert!(folder.is_absolute() && folder.is_dir());
    assert!(database.is_absolute() && database.is_file());
    assert_eq!(database.file_name().unwrap(), "library.db");
    let status_path = folder.join("status.json");
    let status = |value: serde_json::Value| {
        fs::write(&status_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    };
    let (key, qr) = netease::qr_create().expect("create NetEase login QR");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(qr.strip_prefix("data:image/png;base64,").expect("PNG QR")).unwrap();
    let image = folder.join("netease-login.png");
    fs::write(&image, bytes).unwrap();
    status(json!({"status":"waiting","image":image,"database":database}));
    let started = Instant::now();
    let mut last_error = None;
    while started.elapsed() < Duration::from_secs(240) {
        match netease::qr_check(&key) {
            Ok(result) if result.status == "success" => {
                let token = result.music_u.expect("QR returned session credential");
                let uid = netease::resolve_uid(&token).expect("validate scanned account identity");
                let conn = rusqlite::Connection::open(&database).expect("current player database");
                conn.busy_timeout(Duration::from_secs(5)).unwrap();
                // Match the production QR command: save only to the system credential vault.
                crate::credentials::set("netease_music_u", &token).expect("save authorized session");
                db::set_setting(&conn, "netease_uid", &uid.to_string());
                if let Some(nickname) = &result.nickname {
                    db::set_setting(&conn, "netease_nickname", nickname);
                }
                status(json!({"status":"success","uid":uid,"nickname":result.nickname,
                    "credentialSavedToSystemVault":true,"database":database}));
                return;
            }
            Ok(result) if result.status == "expired" => {
                status(json!({"status":"expired","image":image}));
                panic!("QR expired before confirmation");
            }
            Ok(result) => {
                status(json!({"status":result.status,"image":image,"elapsedSeconds":started.elapsed().as_secs()}));
            }
            Err(_) => {
                // Do not write raw authentication responses or session data into artifacts.
                last_error = Some("QR status request temporarily failed");
                status(json!({"status":"retrying","image":image,"error":last_error}));
            }
        }
        std::thread::sleep(Duration::from_millis(1600));
    }
    status(json!({"status":"timed_out","lastError":last_error}));
    panic!("QR login timed out");
}

#[test]
#[ignore = "requires a QR scan; performs only the read-only cloud upload check and never saves credentials"]
fn second_account_hash_check_without_upload_or_saved_login() {
    use md5::Digest;
    let folder = PathBuf::from(std::env::var_os("RUSTMUSIC_QR_OUTPUT").expect("QR output directory"));
    let audio = PathBuf::from(std::env::var_os("RUSTMUSIC_HASH_TEST_AUDIO").expect("existing accompaniment WAV"));
    assert!(folder.is_absolute() && folder.is_dir());
    assert!(audio.is_absolute() && audio.is_file());
    let bytes = fs::read(&audio).expect("Read existing accompaniment");
    let md5 = format!("{:x}", md5::Md5::digest(&bytes));
    let image = folder.join("netease-secondary-hash-test.png");
    let status_path = folder.join("netease-secondary-hash-test.json");
    let status = |value: serde_json::Value| {
        fs::write(&status_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    };
    let (key, qr) = netease::qr_create().expect("create isolated NetEase login QR");
    let png = base64::engine::general_purpose::STANDARD
        .decode(qr.strip_prefix("data:image/png;base64,").expect("PNG QR"))
        .unwrap();
    fs::write(&image, png).unwrap();
    status(json!({"status":"waiting","image":image,"audio":audio}));

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(240) {
        match netease::qr_check(&key) {
            Ok(result) if result.status == "success" => {
                let token = result.music_u.expect("QR returned in-memory session credential");
                let check = netease::api_post(
                    "/api/cloud/upload/check",
                    &json!({
                        "bitrate":"999000", "ext":"", "length":bytes.len(),
                        "md5":md5, "songId":"0", "version":1
                    }).to_string(),
                    &token,
                ).expect("read-only cloud hash check");
                status(json!({
                    "status":"checked",
                    "audio":audio,
                    "md5":md5,
                    "length":bytes.len(),
                    "responseCode":check["code"],
                    "needUpload":check["needUpload"],
                    "audioBytesSent":false,
                    "credentialsSaved":false,
                    "metadataRegistered":false
                }));
                return;
            }
            Ok(result) if result.status == "expired" => {
                status(json!({"status":"expired","image":image}));
                panic!("QR expired before confirmation");
            }
            Ok(result) => {
                status(json!({"status":result.status,"image":image}));
            }
            Err(_) => {
                // Do not write raw authentication responses or session data into artifacts.
                status(json!({"status":"retrying","image":image,"error":"QR status request temporarily failed"}));
            }
        }
        std::thread::sleep(Duration::from_millis(1600));
    }
    status(json!({"status":"timed_out"}));
    panic!("QR login timed out");
}
