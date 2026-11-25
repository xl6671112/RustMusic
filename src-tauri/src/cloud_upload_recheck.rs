//! Explicit user-requested retry of the existing screenshot's local accompaniment.
use super::*;

fn listed(token: &str, title: &str) -> Result<Option<serde_json::Value>, String> {
    for offset in (0..2000).step_by(100) {
        let response = crate::netease::weapi_post("/weapi/v1/cloud/get",
            &serde_json::json!({"limit":100,"offset":offset}).to_string(), Some(token))?;
        if response["code"].as_i64() != Some(200) {
            return Err("Cloud listing rejected".into());
        }
        let rows = response["data"].as_array().ok_or("Cloud listing data missing")?;
        if let Some(row) = rows.iter().find(|row| row["songName"].as_str() == Some(title)
            || row.pointer("/simpleSong/name").and_then(serde_json::Value::as_str) == Some(title)) {
            return Ok(Some(row["songId"].clone()));
        }
        if rows.len() < 100 { return Ok(None); }
    }
    Err("Cloud listing exceeds bounded verification range".into())
}

#[test]
#[ignore = "Explicit live retry of the user's existing screenshot accompaniment; may upload once"]
fn retry_screenshot_upload_and_verify_listing() {
    let path = PathBuf::from(std::env::var_os("RUSTMUSIC_RETRY_AUDIO").expect("Explicit existing accompaniment"));
    let report_path = PathBuf::from(std::env::var_os("RUSTMUSIC_RETRY_REPORT").expect("New report path"));
    assert!(path.is_absolute() && path.is_file() && valid_wav(&path));
    assert!(report_path.is_absolute() && !report_path.exists(), "Preserve earlier evidence");
    let token = crate::credentials::get("netease_music_u").expect("Signed-in current account");
    let title = "Stuck In The Middle - Instrumental";
    let hash = sha256(&path).unwrap();
    let before = listed(&token, title).expect("Check existing cloud entry before any upload");
    let started = std::time::Instant::now();
    let (status, error) = if before.is_some() {
        ("already_listed_no_duplicate_upload".to_string(), None)
    } else {
        upload_result(&path, title, "BABYMONSTER", "")
    };
    let mut listing_error = None;
    let mut after = None;
    for _ in 0..3 {
        match listed(&token, title) {
            Ok(Some(id)) => { after = Some(id); break; }
            Ok(None) => {}
            Err(_) => listing_error = Some("Cloud listing request failed; response redacted"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let source_preserved = sha256(&path).unwrap() == hash;
    let report = serde_json::json!({
        "sourcePath":path, "sourceSha256":hash, "sourcePreserved":source_preserved,
        "title":title,"uploadStatus":status,
        "uploadError":error.map(|e| e.replace(&token, "[redacted]")),
        "previouslyListedSongId":before,"cloudSongId":after,
        "cloudListingMatched":after.is_some(),"listingError":listing_error,
        "elapsedSeconds":started.elapsed().as_secs(),
        "scope":"Existing local HQ3 output; no new inference; listing is not a cloud-audio identity or subjective-quality test"
    });
    fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(source_preserved && after.is_some(), "Consult saved upload/listing report");
}

#[test]
#[ignore = "User scans a second account; publishes four existing accompaniments only on confirmed hash hits"]
fn secondary_account_hash_only_batch_publish() {
    use base64::Engine as _;
    use serde_json::json;
    struct HashOnly {
        inner: ProductionCloudTransport,
        need_upload: Option<bool>,
        stage: String,
    }
    impl CloudTransport for HashOnly {
        fn api(&mut self, path: &str, payload: &serde_json::Value, cookie: &str) -> Result<serde_json::Value, String> {
            self.stage = path.into();
            let response = self.inner.api(path, payload, cookie)?;
            if path == "/api/cloud/upload/check" {
                self.need_upload = response["needUpload"].as_bool();
                if response["code"].as_i64() != Some(200) || self.need_upload != Some(false) {
                    return Err("Hash miss or invalid check; no upload allowed".into());
                }
            }
            Ok(response)
        }
        fn weapi(&mut self, path: &str, payload: &serde_json::Value, cookie: &str) -> Result<serde_json::Value, String> {
            self.stage = path.into();
            self.inner.weapi(path, payload, cookie)
        }
        fn lbs(&mut self, _: &str) -> Result<serde_json::Value, String> {
            Err("Audio upload disabled for hash-only test".into())
        }
        fn nos(&mut self, _: &str, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
            Err("Audio upload disabled for hash-only test".into())
        }
    }
    let folder = PathBuf::from(std::env::var_os("RUSTMUSIC_QR_OUTPUT").expect("new isolated output folder"));
    let fixture = PathBuf::from(std::env::var_os("RUSTMUSIC_HASH_FIXTURES").expect("existing fixture folder"));
    let local = PathBuf::from(std::env::var_os("RUSTMUSIC_HASH_INSTRUMENTALS").expect("existing instrumentals folder"));
    let samples = [
        (fixture.join("BABYMONSTER - BATTER UP - b6462341839e - Instrumental.wav"), "BATTER UP - UVR HQ3 - Instrumental", "BABYMONSTER"),
        (fixture.join("Beyond - 海阔天空 - 278f8d8bc3d0 - Instrumental.wav"), "海阔天空 - UVR5 HQ3 试听 - Instrumental", "Beyond"),
        (local.join("BABYMONSTER - Stuck In The Middle - a7339ee3234d - Instrumental.wav"), "Stuck In The Middle - Instrumental", "BABYMONSTER"),
        (local.join("BABYMONSTER - WE GO UP - 1a22414974de - Instrumental.wav"), "WE GO UP - Instrumental", "BABYMONSTER"),
    ];
    assert!(folder.is_absolute() && folder.is_dir());
    assert!(samples.iter().all(|(path, _, _)| path.is_absolute() && path.is_file()));
    let image = folder.join("second-account.png");
    let report = folder.join("result.json");
    assert!(!report.exists(), "Preserve previous evidence");
    let write = |value: serde_json::Value| fs::write(&report, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let (key, qr) = crate::netease::qr_create().expect("Create isolated QR");
    fs::write(&image, base64::engine::general_purpose::STANDARD
        .decode(qr.strip_prefix("data:image/png;base64,").unwrap()).unwrap()).unwrap();
    write(json!({"status":"waiting","image":image}));
    let started = std::time::Instant::now();
    let token = loop {
        assert!(started.elapsed() < Duration::from_secs(240), "QR login timed out");
        match crate::netease::qr_check(&key) {
            Ok(result) if result.status == "success" => break result.music_u.expect("In-memory credential"),
            Ok(result) if result.status == "expired" => {
                write(json!({"status":"expired"}));
                panic!("QR expired");
            }
            Ok(result) => write(json!({"status":result.status,"image":image})),
            Err(_) => write(json!({"status":"retrying","image":image})),
        }
        std::thread::sleep(Duration::from_millis(1600));
    };
    let vault = keyring::Entry::new("RustMusic.HashTransferDebug", "second_account")
        .expect("Create isolated debug credential entry");
    vault.set_password(&token).expect("Save authorized second account to Windows credential vault");
    assert!(vault.get_password().is_ok_and(|saved| saved == token), "Verify isolated credential was saved");
    let _ = fs::remove_file(&image);
    let mut rows = Vec::new();
    for (path, title, artist) in samples {
        let mut transport = HashOnly { inner: ProductionCloudTransport, need_upload: None, stage: "listing_before".into() };
        let before = listed(&token, title);
        let result = match before {
            Ok(Some(id)) => json!({"title":title,"status":"already_listed","songId":id}),
            Err(_) => json!({"title":title,"status":"listing_failed_no_write"}),
            Ok(None) => {
                let hash = sha256(&path).unwrap();
                let outcome = upload_cloud_file_with(&path, title, artist, "", &token, &mut transport);
                let mut after = None;
                for _ in 0..3 {
                    if let Ok(Some(id)) = listed(&token, title) { after = Some(id); break; }
                    std::thread::sleep(Duration::from_secs(2));
                }
                json!({
                    "title":title,"needUpload":transport.need_upload,
                    "status":if outcome.is_ok() { "published" } else if transport.need_upload == Some(true) { "hash_miss_skipped" } else { "failed" },
                    "stage":transport.stage,"songId":outcome.ok(),"listedSongId":after,
                    "sourcePreserved":sha256(&path).unwrap() == hash
                })
            }
        };
        rows.push(result);
        write(json!({"status":"running","audioBytesSent":0,"credentialsSaved":true,"results":rows}));
    }
    write(json!({"status":"completed","audioBytesSent":0,"credentialsSaved":true,"results":rows}));
}
