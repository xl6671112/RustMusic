//! Opt-in native acceptance driver, excluded from normal release builds.
//! Uses real command functions and an isolated database; exposes no test HTTP API.
use serde_json::{json, Value};
use sha2::Digest;
use std::{path::PathBuf, time::Duration};
use tauri::Manager;

pub fn profile_dir(default: PathBuf) -> Result<PathBuf, String> {
    let Some(path) = std::env::var_os("RUSTMUSIC_ACCEPTANCE_PROFILE") else {
        return Ok(default);
    };
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || path.file_name().and_then(|s| s.to_str()) != Some("acceptance-profile")
    {
        return Err(
            "Acceptance profile must be an absolute dedicated acceptance-profile directory".into(),
        );
    }
    Ok(path)
}

fn settings() -> Value {
    json!({
        "preset":"neon","mode":"current-next","motion":true,
        "css":".widgets::before{content:'acceptance-persisted';animation:test-spin 3s linear infinite}@keyframes test-spin{to{transform:rotate(360deg)}}",
        "size":42,"width":900,"color":"#ffffff","weight":700,"align":"center",
        "font":"Arial, sans-serif","stroke":"#111111","strokeWidth":1,
        "shadow":"0 2px 3px #000","lineHeight":1.25,"letterSpacing":0,
        "translationSize":23,"rows":3,"offsetY":0
    })
}

fn snapshot() -> Result<Value, String> {
    ureq::get("http://127.0.0.1:17842/state")
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())
}

fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(hex::encode(sha2::Sha256::digest(bytes)))
}

async fn run_cloud_read_only(
    app: &tauri::AppHandle,
    comparison_title: Option<&str>,
) -> Result<Value, String> {
    use std::io::Read;
    let title = comparison_title.unwrap_or("RustMusic 伴奏验收（测试文件） - Instrumental");
    let expected_duration = if comparison_title.is_some() { 188.18 } else { 25.0 };
    let max_audio_bytes = if comparison_title.is_some() { 64 } else { 32 } * 1024 * 1024;
    let token = crate::credentials::get("netease_music_u")
        .filter(|token| !token.is_empty())
        .ok_or("Cloud read-only acceptance requires an existing NetEase login")?;
    let listing = crate::netease::weapi_post(
        "/weapi/v1/cloud/get",
        r#"{"limit":100,"offset":0}"#,
        Some(&token),
    )
    .map_err(|_| "Cloud listing request failed (details redacted)")?;
    if listing["code"].as_i64() != Some(200) {
        return Err("Cloud listing was rejected".into());
    }
    let item = listing["data"]
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row["songName"].as_str() == Some(title)
                    || row.pointer("/simpleSong/name").and_then(Value::as_str) == Some(title)
            })
        })
        .ok_or("Acceptance cloud upload was not found in the recent listing")?;
    let song_id = item["songId"]
        .as_i64()
        .or_else(|| item["songId"].as_str().and_then(|s| s.parse().ok()))
        .ok_or("Cloud listing item has no valid song identity")?;
    let (url, _, ext, _) = crate::netease::song_url(song_id, Some(&token), "standard")
        .map_err(|_| "Cloud audio URL request failed (details redacted)")?
        .ok_or("Cloud acceptance audio has no playable URL")?;
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|_| "Cloud audio download failed (URL redacted)")?;
    if !matches!(response.status(), 200 | 206) {
        return Err(format!("Cloud audio returned HTTP {}", response.status()));
    }
    if response
        .header("Content-Length")
        .and_then(|n| n.parse::<u64>().ok())
        .is_some_and(|size| size > max_audio_bytes)
    {
        return Err("Cloud audio exceeds the bounded acceptance download limit".into());
    }
    let partial_response = response.status() == 206;
    let range = response.header("Content-Range").map(str::to_owned);
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max_audio_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cloud audio response could not be read")?;
    if bytes.len() as u64 > max_audio_bytes {
        return Err("Cloud audio exceeds the bounded acceptance download limit".into());
    }
    if partial_response && range.is_none() {
        return Err("Cloud audio partial response omitted Content-Range".into());
    }
    if let Some(range) = range {
        let total = range
            .strip_prefix("bytes 0-")
            .and_then(|s| s.split_once('/'))
            .and_then(|(end, total)| end.parse::<u64>().ok().zip(total.parse::<u64>().ok()))
            .filter(|(end, total)| *total > 0 && end.saturating_add(1) == *total)
            .map(|(_, total)| total)
            .ok_or("Cloud audio response was a partial range, not a complete file")?;
        if bytes.len() as u64 != total {
            return Err("Cloud audio response length did not match its complete range".into());
        }
    }
    let profile = app.state::<crate::AppState>().app_data.clone();
    let audio_path = profile.join(format!("acceptance-cloud-{song_id}.{ext}"));
    std::fs::write(&audio_path, &bytes)
        .map_err(|_| "Could not save cloud audio in acceptance profile")?;
    use rodio::Source;
    let decoder = rodio::Decoder::try_from(std::io::Cursor::new(bytes))
        .map_err(|_| "Complete cloud audio could not be decoded")?;
    let sample_rate = decoder.sample_rate().get();
    let channels = decoder.channels().get();
    let mut sample_count = 0u64;
    let mut energy = 0.0f64;
    for sample in decoder {
        if !sample.is_finite() {
            return Err("Cloud audio contains non-finite decoded samples".into());
        }
        sample_count += 1;
        energy += f64::from(sample).powi(2);
    }
    let duration_seconds = sample_count as f64 / f64::from(sample_rate) / f64::from(channels);
    if sample_count == 0 || energy <= 0.0 || (duration_seconds - expected_duration).abs() > 0.5 {
        return Err(
            "Cloud acceptance audio must decode completely to the expected non-silent duration"
                .into(),
        );
    }
    let local_fixture = if comparison_title.is_some() {
        audio_path.to_string_lossy().into_owned()
    } else {
        std::env::var("RUSTMUSIC_ACCEPTANCE_AUDIO").map_err(|e| e.to_string())?
    };
    crate::commands::set_volume(app.state(), 0.0).await?;
    app.state::<crate::AppState>()
        .engine
        .play_file(crate::engine::TrackInfo {
            id: None,
            kind: "netease".into(),
            path: audio_path.to_string_lossy().into_owned(),
            title: title.into(),
            artist: "Acceptance cloud upload".into(),
            album: String::new(),
            cover: String::new(),
            duration_ms: 0,
            nid: Some(song_id),
            qid: None,
            kgid: None,
            quality: Some("standard".into()),
        })?;
    std::thread::sleep(Duration::from_millis(400));
    let first = snapshot()?;
    std::thread::sleep(Duration::from_millis(250));
    let advanced = snapshot()?;
    if advanced["trackKey"] != format!("netease:{song_id}")
        || advanced["positionMs"].as_u64().unwrap_or(0) <= first["positionMs"].as_u64().unwrap_or(0)
    {
        return Err("Downloaded cloud audio did not play with advancing progress".into());
    }
    crate::commands::pause(app.state()).await?;
    // Rodio applies pause on its audio callback, after the command flag is set.
    // Require a bounded stable paused state before testing the longer freeze.
    let mut paused = snapshot()?;
    let mut stable_observations = 0;
    let mut pause_settle_ms = 0;
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(50));
        pause_settle_ms += 50;
        let next = snapshot()?;
        if next["playing"] == false && next["positionMs"] == paused["positionMs"] {
            stable_observations += 1;
        } else {
            stable_observations = 0;
        }
        paused = next;
        if stable_observations >= 3 {
            break;
        }
    }
    if stable_observations < 3 {
        return Err("Cloud playback failed to settle into a stable pause within one second".into());
    }
    std::thread::sleep(Duration::from_millis(250));
    let after_pause = snapshot()?;
    if after_pause["playing"] != false || after_pause["positionMs"] != paused["positionMs"] {
        return Err("Downloaded cloud audio progress did not freeze on pause".into());
    }
    let lyric_id = if comparison_title.is_some() { 2103336805 } else { 347230 };
    let lyric = crate::netease::lyric_yrc(lyric_id, Some(&token))?
        .or(crate::netease::lyric(lyric_id, Some(&token))?)
        .ok_or("Known real NetEase lyric track returned no lyric text")?;
    let parsed = crate::lyrics::parse(&lyric.lrc);
    if !parsed.synced || parsed.lines.is_empty() {
        return Err("Real NetEase lyric text did not parse into synced lines".into());
    }
    let mut parsed = parsed;
    if let Some(trans) = &lyric.trans {
        crate::lyrics::attach_translations(&mut parsed, trans);
    }
    let lyrics = json!({"synced":true,"lines":parsed.lines});
    crate::accompaniment::play_accompaniment(
        app.state(),
        local_fixture,
        "Live lyric verification fixture".into(),
        "Fixture".into(),
        String::new(),
        "netease".into(),
        lyric_id.to_string(), None, None)
    .await?;
    crate::commands::pause(app.state()).await?;
    crate::commands::seek(app.state(), 5000).await?;
    let offset = 375;
    let payload = json!({"trackKey":format!("netease:{lyric_id}"),"title":"Live lyric verification",
        "artist":"NetEase","lyrics":lyrics,"playing":false,"lyricOffsetMs":offset});
    let mut http_state = snapshot()?;
    for _ in 0..10 {
        if http_state["trackKey"] == format!("netease:{lyric_id}")
            && http_state["lyrics"] == lyrics
            && http_state["lyricOffsetMs"] == offset
            && http_state["playing"] == false
            && http_state["positionMs"]
                .as_u64()
                .unwrap_or(0)
                .abs_diff(5000)
                <= 100
        {
            break;
        }
        crate::obs_lyrics::publish_obs_lyrics(app.state(), payload.clone());
        std::thread::sleep(Duration::from_millis(50));
        http_state = snapshot()?;
    }
    let repeated_http_state = snapshot()?;
    if http_state["trackKey"] != format!("netease:{lyric_id}")
        || http_state["lyrics"] != lyrics
        || http_state["lyricOffsetMs"] != offset
        || http_state["playing"] != false
        || http_state["positionMs"]
            .as_u64()
            .unwrap_or(0)
            .abs_diff(5000)
            > 100
        || repeated_http_state != http_state
    {
        return Err(
            "OBS HTTP state did not retain real lyrics, offset, pause, seek, and track association"
                .into(),
        );
    }
    Ok(
        json!({"cloudListingMatched":true,"audioDownloadedCompletely":true,
        "completeDecodeFiniteAndNonSilent":true,"decodedSampleRate":sample_rate,
        "decodedChannels":channels,"decodedDurationSeconds":duration_seconds,
        "pauseSettleObservedMs":pause_settle_ms,"pauseFreezeObservationMs":250,
        "downloadedAudioPlayedAndPaused":true,"playbackTrackKey":format!("netease:{song_id}"),
        "realSyncedLyricsParsed":true,"lyricsHttpTrackKey":http_state["trackKey"],
        "lyricsHttpOffsetMs":offset,"lyricsFixturePauseAndSeekVerified":true,
        "fixtureAudioDoesNotCorrespondToLyricSong":comparison_title.is_none(),
        "cloudTitle":title,"cloudSongId":song_id,"downloadedPath":audio_path,
        "downloadedSha256":file_sha256(&audio_path)?}),
    )
}

async fn run_local_bs_dual(app: &tauri::AppHandle) -> Result<Value, String> {
    use rodio::Source;
    use tauri::Listener;
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let profile = app.state::<crate::AppState>().app_data.clone();
    let input = profile.join("local-bs.wav");
    let lrc = input.with_extension("lrc");
    let fixture = std::env::var_os("RUSTMUSIC_ACCEPTANCE_AUDIO").ok_or("Missing BS audio fixture")?;
    std::fs::copy(fixture, &input).map_err(|e| e.to_string())?;
    std::fs::write(&lrc, "[00:00.50]BS dual-stem original lyric\n").map_err(|e| e.to_string())?;
    let path = input.to_string_lossy().into_owned();
    {
        let state = app.state::<crate::AppState>();
        let conn = state.db.lock();
        conn.execute(
            "INSERT INTO tracks (path, title, artist, duration, lrc_path) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![path, "BS dual-stem fixture", "Fixture", 5.0, lrc.to_string_lossy()],
        ).map_err(|e| e.to_string())?;
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let listener = app.listen("accompaniment://progress", move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            if payload["taskId"] == "acceptance-local-bs-dual" {
                let _ = sender.send(payload);
            }
        }
    });
    let result = crate::accompaniment::extract_accompaniment(
        app.clone(), Some("acceptance-local-bs-dual".into()), Some(path), None,
        None, None, None, None, None, None, Some(true), Some("ai2".into()),
    ).await;
    app.unlisten(listener);
    let result = result?;
    let events: Vec<_> = receiver.try_iter().collect();
    let vocals = result.vocals_path.as_deref().ok_or("BS extraction returned no vocals")?;
    let source_duration = rodio::Decoder::try_from(std::fs::File::open(input).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?.total_duration();
    for path in [&result.path, vocals] {
        let decoder = rodio::Decoder::try_from(std::fs::File::open(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if decoder.total_duration() != source_duration || !decoder.into_iter().any(|sample| sample.abs() > 0.0001) {
            return Err(format!("Stem does not match source length or is silent: {path}"));
        }
    }
    if !events.iter().any(|event| event["phase"] == "cloud_check")
        || !events.iter().any(|event| event["phase"] == "inference" && event["percent"].as_f64().is_some())
        || result.model_id != "bs-roformer-resurrection-instrumental"
        || result.title != "BS dual-stem fixture"
        || result.lyrics.as_ref().and_then(|lyrics| lyrics.pointer("/lines/0/text"))
            != Some(&json!("BS dual-stem original lyric"))
        || result.upload_status != "skipped_not_signed_in"
    {
        return Err(format!("Local BS dual-stem metadata or progress mismatch: {events:?}"));
    }
    Ok(json!({"instrumental":result.path,"vocals":vocals,"device":result.device,
        "lyrics":result.lyrics,"progress":events}))
}

async fn run_ai(app: &tauri::AppHandle) -> Result<Value, String> {
    let real_signed_in_upload = crate::credentials::get("netease_music_u").is_some();
    let fixture = std::env::var("RUSTMUSIC_ACCEPTANCE_AUDIO").map_err(|e| e.to_string())?;
    let fixture = PathBuf::from(fixture);
    let original_hash = file_sha256(&fixture)?;
    let profile = app.state::<crate::AppState>().app_data.clone();
    let input = profile.join(format!("acceptance-ai-{}.wav", std::process::id()));
    std::fs::copy(&fixture, &input).map_err(|e| e.to_string())?;
    struct InputGuard(PathBuf);
    impl Drop for InputGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _guard = InputGuard(input.clone());
    let input_hash = file_sha256(&input)?;
    let first = crate::accompaniment::extract_accompaniment(
        app.clone(),
        Some("acceptance-ai-first".into()),
        Some(input.to_string_lossy().into_owned()),
        None,
        Some("RustMusic 伴奏验收（测试文件）".into()),
        Some("Fixture".into()),
        Some(String::new()),
        Some("netease".into()),
        Some("42".into()),
        None,
        None,
        None,
)
    .await?;
    let first_upload_valid = if real_signed_in_upload {
        matches!(
            first.upload_status.as_str(),
            "uploaded" | "failed_local_preserved"
        )
    } else {
        first.upload_status == "skipped_not_signed_in"
    };
    if first.model != "UVR-MDX-NET-Inst_HQ_3.onnx"
        || first.device == "cache"
        || !first_upload_valid
        || !PathBuf::from(&first.path).is_file()
    {
        return Err(format!("First AI extraction did not meet HQ_3/local/upload-status expectations: model={}, device={}, upload={}", first.model, first.device, first.upload_status));
    }
    if file_sha256(&input)? != input_hash || file_sha256(&fixture)? != original_hash {
        return Err("AI extraction modified the original fixture".into());
    }
    let second = crate::accompaniment::extract_accompaniment(
        app.clone(),
        Some("acceptance-ai-cache".into()),
        Some(input.to_string_lossy().into_owned()),
        None,
        Some("RustMusic 伴奏验收（测试文件）".into()),
        Some("Fixture".into()),
        Some(String::new()),
        Some("netease".into()),
        Some("42".into()),
        None,
        None,
        None,
)
    .await?;
    if second.device != "cache" || second.path != first.path {
        return Err(format!(
            "Repeated extraction did not reuse the same verified cache: {} / {}",
            first.path, second.path
        ));
    }
    let second_upload_valid = if real_signed_in_upload {
        matches!(
            second.upload_status.as_str(),
            "uploaded" | "failed_local_preserved"
        )
    } else {
        second.upload_status == "skipped_not_signed_in"
    };
    if !second_upload_valid {
        return Err(format!(
            "Repeated extraction returned unexpected upload status: {}",
            second.upload_status
        ));
    }
    crate::accompaniment::play_accompaniment(
        app.state(),
        first.path.clone(),
        first.title,
        first.artist,
        first.album,
        "netease".into(),
        "42".into(), None, None)
    .await?;
    let mut state = snapshot()?;
    for _ in 0..20 {
        if state["trackKey"] == "netease:42" {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
        state = snapshot()?;
    }
    crate::commands::pause(app.state()).await?;
    if state["trackKey"] != "netease:42" {
        return Err(format!("AI playback lost original track identity: {state}"));
    }
    let response = ureq::get("http://127.0.0.1:17842/state")
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|e| e.to_string())?;
    if response.status() != 200 {
        return Err(format!(
            "Lyrics HTTP endpoint returned {}",
            response.status()
        ));
    }
    let http_state: Value = response.into_json().map_err(|e| e.to_string())?;
    if http_state["trackKey"] != "netease:42" {
        return Err(
            "HTTP lyrics state does not associate the accompaniment with NetEase track 42".into(),
        );
    }
    Ok(json!({"model":first.model,"device":first.device,
        "realSignedInAccountPresent":real_signed_in_upload,
        "realSignedInUploadVerified":real_signed_in_upload && first.upload_status == "uploaded",
        "cloudUploadStatus":first.upload_status,"cloudUploadError":first.upload_error,
        "cacheCallUploadStatus":second.upload_status,"cacheCallUploadError":second.upload_error,
        "outputExists":true,"sourceUnchanged":true,"repeatUsedCache":true,"sameCachePath":true,
        "playbackTrackKey":state["trackKey"],"lyricsHttpStatus":200,"lyricsHttpTrackKey":http_state["trackKey"]}))
}

async fn verify_online_ai_output(
    app: &tauri::AppHandle,
    result: crate::accompaniment::AccompanimentResult,
    upload_attempted: bool,
) -> Result<Value, String> {
    const SONG_ID: i64 = 347230;
    let token = crate::credentials::get("netease_music_u")
        .filter(|token| !token.is_empty())
        .ok_or("Online AI verification requires an existing NetEase login")?;
    let output = PathBuf::from(&result.path);
    let app_data = app.state::<crate::AppState>().app_data.clone();
    let expected_dir = app_data.join("Instrumental");
    let output_parent = output
        .canonicalize()
        .map_err(|_| "Online AI output file is missing")?
        .parent()
        .ok_or("Online AI output has no parent")?
        .to_path_buf();
    if output_parent
        != expected_dir
            .canonicalize()
            .map_err(|_| "Instrumental output directory is missing")?
        || !output.is_file()
        || result.source_kind != "netease"
        || result.source_id != SONG_ID.to_string()
        || result.model != "UVR-MDX-NET-Inst_HQ_3.onnx"
    {
        return Err(
            "Online AI result failed output location, source identity, or HQ_3 checks".into(),
        );
    }
    if upload_attempted && result.upload_status == "skipped_not_signed_in" {
        return Err(format!("Online AI incomplete: uploadStatus={}, device={}, model={}, localOutputRetained={}, uploadError={:?}",
            result.upload_status, result.device, result.model, output.is_file(), result.upload_error));
    }
    if upload_attempted
        && result.upload_status != "uploaded"
        && result.upload_status != "failed_local_preserved"
    {
        return Err(format!("Online AI incomplete: uploadStatus={}, device={}, model={}, localOutputRetained={}, uploadError={:?}",
            result.upload_status, result.device, result.model, output.is_file(), result.upload_error));
    }

    let title = result.title.clone();
    let artist = result.artist.clone();
    let album = result.album.clone();
    crate::commands::set_volume(app.state(), 0.0).await?;
    crate::accompaniment::play_accompaniment(
        app.state(),
        result.path.clone(),
        title.clone(),
        artist.clone(),
        album,
        "netease".into(),
        SONG_ID.to_string(), None, None)
    .await?;
    std::thread::sleep(Duration::from_millis(350));
    let started = snapshot()?;
    std::thread::sleep(Duration::from_millis(250));
    let advanced = snapshot()?;
    if advanced["trackKey"] != format!("netease:{SONG_ID}")
        || advanced["positionMs"].as_u64().unwrap_or(0)
            <= started["positionMs"].as_u64().unwrap_or(0)
    {
        return Err(
            "Online AI output playback did not advance under the original song identity".into(),
        );
    }
    crate::commands::pause(app.state()).await?;
    let paused = snapshot()?;
    std::thread::sleep(Duration::from_millis(200));
    if paused["playing"] != false || snapshot()?["positionMs"] != paused["positionMs"] {
        return Err("Online AI playback did not remain paused with frozen progress".into());
    }
    crate::commands::seek(app.state(), 5000).await?;
    let lyric = crate::netease::lyric_yrc(SONG_ID, Some(&token))?
        .or(crate::netease::lyric(SONG_ID, Some(&token))?)
        .ok_or("Original online song returned no real lyrics")?;
    let mut parsed = crate::lyrics::parse(&lyric.lrc);
    if !parsed.synced || parsed.lines.is_empty() {
        return Err("Original online song lyrics are not synced or empty".into());
    }
    if let Some(trans) = &lyric.trans {
        crate::lyrics::attach_translations(&mut parsed, trans);
    }
    let translation_available = parsed
        .lines
        .iter()
        .any(|line| line.trans.as_ref().is_some_and(|text| !text.is_empty()));
    let lyrics = json!({"synced":true,"lines":parsed.lines});
    let offset = 250;
    let payload = json!({"trackKey":format!("netease:{SONG_ID}"),"title":title,"artist":artist,
        "lyrics":lyrics,"playing":false,"lyricOffsetMs":offset});
    let mut state = snapshot()?;
    for _ in 0..10 {
        if state["trackKey"] == format!("netease:{SONG_ID}")
            && state["lyrics"] == lyrics
            && state["lyricOffsetMs"] == offset
            && state["playing"] == false
            && state["positionMs"].as_u64().unwrap_or(0).abs_diff(5000) <= 100
        {
            break;
        }
        crate::obs_lyrics::publish_obs_lyrics(app.state(), payload.clone());
        std::thread::sleep(Duration::from_millis(50));
        state = snapshot()?;
    }
    let repeated = snapshot()?;
    if state["trackKey"] != format!("netease:{SONG_ID}")
        || state["lyrics"] != lyrics
        || state["lyricOffsetMs"] != offset
        || state["playing"] != false
        || state["positionMs"].as_u64().unwrap_or(0).abs_diff(5000) > 100
        || repeated != state
    {
        return Err(
            "Online AI HTTP state failed same-track lyric, pause, seek, or offset verification"
                .into(),
        );
    }
    let cloud_upload_succeeded = upload_attempted && result.upload_status == "uploaded";
    let acceptance_complete = !upload_attempted || cloud_upload_succeeded;
    let report_upload_status = if upload_attempted {
        result.upload_status.clone()
    } else {
        "not_repeated".into()
    };
    Ok(
        json!({"sourceSongId":SONG_ID,"sourceKind":result.source_kind,
        "outputPath":result.path,"outputUnderInstrumental":true,"model":result.model,
        "device":result.device,"uploadAttempted":upload_attempted,
        "uploadStatus":report_upload_status,
        "cloudUploadSucceeded":if upload_attempted { json!(cloud_upload_succeeded) } else { Value::Null },
        "acceptanceComplete":acceptance_complete,
        "incompleteAcceptanceItems":if acceptance_complete { json!([]) } else { json!(["cloud upload failed; local output was preserved and verified"]) },
        "uploadError":result.upload_error,"localOutputPreserved":output.is_file(),
        "realLyricsParsed":true,"translationAvailable":translation_available,"httpTrackKey":state["trackKey"],
        "pauseSeekAndOffsetVerified":true,
        "uploadHasRealCloudSideEffect":upload_attempted && cloud_upload_succeeded,
        "subjectiveVocalInstrumentalAlignmentNotAsserted":true}),
    )
}

async fn run_online_ai(app: &tauri::AppHandle) -> Result<Value, String> {
    const SONG_ID: i64 = 347230;
    let token = crate::credentials::get("netease_music_u")
        .filter(|token| !token.is_empty())
        .ok_or("Online AI acceptance requires an existing NetEase login")?;
    let song = crate::netease::songs_by_ids(&[SONG_ID], &token)?
        .pop()
        .filter(|song| song.id == SONG_ID)
        .ok_or("NetEase did not return metadata for the requested lyric track")?;
    let title = song.name.clone();
    let artist = song.artist_str();
    let album = song.album_name();
    let online = crate::accompaniment::OnlineAccompanimentRequest {
        kind: "netease".into(),
        id: SONG_ID.to_string(),
        title: title.clone(),
        artist: artist.clone(),
        album: album.clone(),
        cover: song.cover_url().unwrap_or_default(),
        duration_ms: song.duration_ms().max(0) as u64,
        media_mid: String::new(),
    };
    let result = crate::accompaniment::extract_accompaniment(
        app.clone(),
        Some("acceptance-online-ai-347230".into()),
        None,
        Some(online),
        Some(title),
        Some(artist),
        Some(album),
        Some("netease".into()),
        Some(SONG_ID.to_string()),
        None,
        None,
        None,
)
    .await?;
    verify_online_ai_output(app, result, true).await
}

async fn run_online_ai_local(app: &tauri::AppHandle, upload: bool) -> Result<Value, String> {
    const SONG_ID: i64 = 347230;
    let app_data = app.state::<crate::AppState>().app_data.clone();
    let source = app_data.join("下载音乐").join("Beyond - 海阔天空.mp3");
    let output = app_data
        .join("Instrumental")
        .join("Beyond - 海阔天空 - 278f8d8bc3d0 - Instrumental.wav");
    let cache = output.with_extension("wav.cache.json");
    let model_dir = std::env::var_os("RUSTMUSIC_AI_MODEL_DIR")
        .map(PathBuf::from)
        .ok_or("AI model directory is not configured for local recovery")?;
    let model_path = model_dir.join("UVR-MDX-NET-Inst_HQ_3.onnx");
    let source_hash = file_sha256(&source)?;
    let output_hash = file_sha256(&output)?;
    let model_hash = file_sha256(&model_path)?;
    let output_bytes = std::fs::metadata(&output).map_err(|e| e.to_string())?.len();
    let metadata: Value =
        serde_json::from_slice(&std::fs::read(&cache).map_err(|e| e.to_string())?)
            .map_err(|_| "Existing accompaniment cache metadata is invalid")?;
    if metadata["input_sha256"] != source_hash
        || metadata["output_sha256"] != output_hash
        || metadata["output_bytes"].as_u64() != Some(output_bytes)
        || metadata["model_sha256"] != model_hash
    {
        return Err("Existing download, accompaniment, cache metadata, or current HQ_3 model hash does not match".into());
    }
    let token = crate::credentials::get("netease_music_u")
        .filter(|token| !token.is_empty())
        .ok_or("Online AI local recovery requires an existing NetEase login")?;
    let song = crate::netease::songs_by_ids(&[SONG_ID], &token)?
        .pop()
        .filter(|song| song.id == SONG_ID)
        .ok_or("NetEase did not return metadata for the requested lyric track")?;
    let result = if upload {
        crate::accompaniment::extract_accompaniment(
            app.clone(),
            Some("user-requested-hq3-cache-upload".into()),
            Some(source.to_string_lossy().into_owned()),
            None,
            Some(format!("{} - UVR5 HQ3 试听", song.name)),
            Some(song.artist_str()),
            Some(song.album_name()),
            Some("netease".into()),
            Some(SONG_ID.to_string()),
            None,
        None,
        None,
)
        .await?
    } else {
        crate::accompaniment::AccompanimentResult {
            path: output.to_string_lossy().into_owned(),
            device: "existing-local-output-not-measured".into(),
            model: "UVR-MDX-NET-Inst_HQ_3.onnx".into(),
            upload_status: "not_repeated".into(),
            upload_error: None,
            title: song.name.clone(),
            artist: song.artist_str(),
            album: song.album_name(),
            source_kind: "netease".into(),
            source_id: SONG_ID.to_string(),
            ..Default::default()
        }
    };
    let cloud_title = format!("{} - Instrumental", result.title);
    let mut report = verify_online_ai_output(app, result, upload).await?;
    report["sourceAudioPath"] = json!(source);
    report["sourceSha256"] = json!(source_hash);
    report["outputSha256"] = json!(output_hash);
    report["modelSha256"] = json!(model_hash);
    report["verifiedExistingCache"] = json!(true);
    report["device"] = json!("not measured; reusing prior local result");
    if upload {
        report["cloudTitle"] = json!(cloud_title);
        match crate::netease::weapi_post(
            "/weapi/v1/cloud/get",
            r#"{"limit":100,"offset":0}"#,
            Some(&token),
        ) {
            Ok(listing) => {
                let item = listing["data"].as_array().and_then(|rows| {
                    rows.iter().find(|row| {
                        row["songName"].as_str() == Some(cloud_title.as_str())
                            || row.pointer("/simpleSong/name").and_then(Value::as_str)
                                == Some(cloud_title.as_str())
                    })
                });
                report["cloudListingCode"] = listing["code"].clone();
                report["cloudListingMatched"] = json!(item.is_some());
                report["cloudSongId"] = item.map(|row| row["songId"].clone()).unwrap_or(Value::Null);
            }
            Err(_) => {
                report["cloudListingMatched"] = json!(false);
                report["cloudListingError"] = json!("Cloud listing request failed (details redacted)");
            }
        }
    }
    report["previousUploadStatus"] = Value::Null;
    report["previousUploadOutcomeKnown"] = json!(false);
    Ok(report)
}

async fn run_exclusive(app: &tauri::AppHandle) -> Result<Value, String> {
    let result = async {
        let audio = std::env::var("RUSTMUSIC_ACCEPTANCE_AUDIO").map_err(|e| e.to_string())?;
        crate::commands::set_volume(app.state(), 0.0).await?;
        crate::commands::set_speed(app.state(), 1.25).await?;
        crate::commands::set_vocal_removal(app.state(), 50.0)?;
        crate::commands::set_wasapi_exclusive(app.state(), true).await?;
        crate::accompaniment::play_accompaniment(
            app.state(), audio, "Exclusive acceptance fixture".into(), "Fixture".into(),
            String::new(), "netease".into(), "42".into(), None, None).await?;
        std::thread::sleep(Duration::from_millis(350));
        let engine = app.state::<crate::AppState>().engine.clone();
        if !engine.acceptance_exclusive_active() {
            return Err("WASAPI exclusive session did not become active after playback start".into());
        }
        crate::commands::pause(app.state()).await?;
        crate::commands::seek(app.state(), 5000).await?;
        let outputs = crate::commands::list_output_devices(app.state()).await?;
        let devices = outputs["devices"].as_array().ok_or("Output device list is missing")?;
        if devices.len() != 3 {
            return Err(format!("Expected the three enumerated output devices, found {}", devices.len()));
        }
        for device in devices {
            let name = device["name"].as_str().ok_or("Output device name is missing")?;
            crate::commands::set_output_device(app.state(), Some(name.into())).await?;
            let actual = crate::commands::list_output_devices(app.state()).await?;
            let state = snapshot()?;
            if !engine.acceptance_exclusive_active() || actual["preference"] != name
                || actual["current"] != name || state["playing"] != false
                || state["trackKey"] != "netease:42"
                || state["positionMs"].as_u64().unwrap_or(0).abs_diff(5000) > 100
                || engine.speed() != 1.25 {
                return Err(format!("Exclusive device switch lost active session or paused state: {state}"));
            }
        }
        let first_name = devices[0]["name"].as_str().ok_or("First output name is missing")?;
        crate::commands::resume(app.state()).await?;
        std::thread::sleep(Duration::from_millis(250));
        let before_switch = snapshot()?;
        crate::commands::set_output_device(app.state(), Some(first_name.into())).await?;
        std::thread::sleep(Duration::from_millis(250));
        let playing_switch = snapshot()?;
        if !engine.acceptance_exclusive_active() || playing_switch["playing"] != true
            || playing_switch["positionMs"].as_u64().unwrap_or(0)
                <= before_switch["positionMs"].as_u64().unwrap_or(0) {
            return Err("Exclusive output switch during playback stopped progress or lost the exclusive session".into());
        }
        crate::commands::set_wasapi_exclusive(app.state(), false).await?;
        if engine.acceptance_exclusive_active() {
            return Err("Exclusive session remained active after switching back to shared output".into());
        }
        let shared_before = snapshot()?;
        std::thread::sleep(Duration::from_millis(250));
        let shared_after = snapshot()?;
        if shared_after["playing"] != true || shared_after["positionMs"].as_u64().unwrap_or(0)
            <= shared_before["positionMs"].as_u64().unwrap_or(0) {
            return Err(format!("Playback did not continue after exclusive-to-shared transition: before={shared_before}, after={shared_after}"));
        }
        let mut reopened_endpoints = std::collections::HashSet::new();
        for device in devices {
            let name = device["name"].as_str().ok_or("Output name is missing")?;
            let before = snapshot()?;
            crate::commands::set_output_device(app.state(), Some(name.into())).await?;
            std::thread::sleep(Duration::from_millis(500));
            let after = snapshot()?;
            let key = engine.acceptance_shared_output_key().ok_or("Shared endpoint was not registered after exclusive use")?;
            if !reopened_endpoints.insert(key) || after["playing"] != true
                || after["positionMs"].as_u64().unwrap_or(0) <= before["positionMs"].as_u64().unwrap_or(0) {
                return Err(format!("Shared device could not resume after exclusive use: {name}, before={before}, after={after}"));
            }
        }
        Ok(json!({"exclusiveSessionVerified":true,"devicesSwitchedWhilePaused":devices.len(),
            "pausedPositionMs":5000,"speedPreserved":1.25,"switchWhilePlayingAdvanced":true,
            "sharedFallbackAdvanced":true,"sharedEndpointsReopenedAfterExclusive":reopened_endpoints.len(),"originalTrackKey":"netease:42"}))
    }.await;
    let _ = crate::commands::set_wasapi_exclusive(app.state(), false).await;
    let _ = crate::commands::set_output_device(app.state(), None).await;
    let _ = crate::commands::set_speed(app.state(), 1.0).await;
    let _ = crate::commands::set_vocal_removal(app.state(), 0.0);
    let _ = crate::commands::set_volume(app.state(), 0.0).await;
    let _ = crate::commands::stop(app.state()).await;
    result
}

async fn run_batter_up(app: &tauri::AppHandle, phase: &str) -> Result<Value, String> {
    let token = crate::credentials::get("netease_music_u")
        .filter(|value| !value.is_empty())
        .ok_or("BATTER UP comparison requires the existing NetEase login")?;
    if phase == "batter-lookup" {
        let result = crate::netease::search("BATTER UP BABYMONSTER", 15, 0, Some(&token))?;
        let songs: Vec<Value> = result.songs.iter().map(|song| json!({
            "id":song.id,"title":song.name,"artist":song.artist_str(),
            "album":song.album_name(),"durationMs":song.duration_ms()
        })).collect();
        return Ok(json!({"candidates":songs,"readOnly":true}));
    }
    let song_id: i64 = std::env::var("RUSTMUSIC_BATTER_SONG_ID")
        .map_err(|_| "Explicit BATTER UP song ID is required")?
        .parse().map_err(|_| "Invalid BATTER UP song ID")?;
    let song = crate::netease::songs_by_ids(&[song_id], &token)?
        .pop().ok_or("Selected BATTER UP song metadata is missing")?;
    if !song.name.to_uppercase().contains("BATTER UP")
        || !song.artist_str().to_uppercase().contains("BABYMONSTER")
    {
        return Err("Selected song does not match BATTER UP by BABYMONSTER".into());
    }
    let profile = app.state::<crate::AppState>().app_data.clone();
    let (source, output, method, device, upload_status, upload_error) = if phase == "batter-ai" {
        let request = crate::commands::OnlineSaveReq {
            kind:"netease".into(),id:song_id.to_string(),title:song.name.clone(),
            artist:song.artist_str(),album:song.album_name(),cover_url:song.cover_url().unwrap_or_default(),
            duration_ms:song.duration_ms().max(0) as u64,media_mid:String::new(),
            album_audio_id:0,hq_hash:String::new(),sq_hash:String::new(),super_hash:String::new(),
        };
        let downloaded = crate::commands::download_online_task(app, request)?;
        let source = downloaded["path"].as_str().ok_or("Download returned no source path")?.to_owned();
        let result = crate::accompaniment::extract_accompaniment(
            app.clone(),Some("user-batter-up-hq3".into()),Some(source.clone()),None,
            Some("BATTER UP - UVR HQ3".into()),Some(song.artist_str()),Some(song.album_name()),
            Some("netease".into()),Some(song_id.to_string()),
            None,
        None,
        None,
).await?;
        (source, result.path, "UVR HQ3", result.device, result.upload_status, result.upload_error)
    } else {
        let previous: Value = serde_json::from_slice(
            &std::fs::read(profile.join("report-batter-ai.json")).map_err(|e| e.to_string())?
        ).map_err(|e| e.to_string())?;
        if previous["checks"]["sourceSongId"].as_i64() != Some(song_id) {
            return Err("VST comparison must use the same song as the HQ3 run".into());
        }
        let source = previous["checks"]["sourcePath"].as_str().ok_or("Missing original source")?.to_owned();
        if previous["checks"]["sourceSha256"] != file_sha256(std::path::Path::new(&source))? {
            return Err("Original comparison source changed".into());
        }
        let (output, method, device) = if phase == "batter-vst-upload" {
            (PathBuf::from(std::env::var_os("RUSTMUSIC_BATTER_VST_OUTPUT")
                .ok_or("Explicit VST WAV output is required")?),
                "VST Remix 100", "real Remix VST offline render")
        } else {
            let output = PathBuf::from(previous["checks"]["outputPath"].as_str()
                .ok_or("Missing prior HQ3 output")?);
            if previous["checks"]["outputSha256"] != file_sha256(&output)? {
                return Err("Prior HQ3 output changed".into());
            }
            (output, "UVR HQ3", "reusing verified HQ3 output")
        };
        let title = format!("BATTER UP - {method} - Instrumental");
        let (status, error) = crate::accompaniment::acceptance_upload_file(
            &output, &title, &song.artist_str(), &song.album_name()
        );
        (source, output.to_string_lossy().into_owned(), method, device.into(), status, error)
    };
    let title = format!("BATTER UP - {method} - Instrumental");
    let listing = crate::netease::weapi_post(
        "/weapi/v1/cloud/get",r#"{"limit":100,"offset":0}"#,Some(&token)
    ).ok();
    let item = listing.as_ref().and_then(|value| value["data"].as_array()).and_then(|rows| {
        rows.iter().find(|row| row["songName"].as_str() == Some(title.as_str())
            || row.pointer("/simpleSong/name").and_then(Value::as_str) == Some(title.as_str()))
    });
    Ok(json!({
        "sourceSongId":song_id,"sourceTitle":song.name,"artist":song.artist_str(),
        "sourcePath":source,"sourceSha256":file_sha256(std::path::Path::new(&source))?,
        "outputPath":output,"outputSha256":file_sha256(std::path::Path::new(&output))?,
        "method":method,"model":if method == "UVR HQ3" {Some("UVR-MDX-NET-Inst_HQ_3.onnx")} else {None},
        "device":device,"uploadStatus":upload_status,"uploadError":upload_error,
        "cloudTitle":title,"cloudListingMatched":item.is_some(),
        "cloudSongId":item.map(|row| row["songId"].clone()),
        "subjectiveQualityVerified":false
    }))
}

async fn run(app: &tauri::AppHandle, phase: &str) -> Result<Value, String> {
    if phase == "local-bs-dual" {
        return run_local_bs_dual(app).await;
    }
    if phase == "pitch" {
        return crate::pitch_playback_check::run(app).await;
    }
    for _ in 0..30 {
        if snapshot().is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if matches!(phase, "batter-lookup" | "batter-ai" | "batter-ai-upload" | "batter-vst-upload") {
        return run_batter_up(app, phase).await;
    }
    if phase == "batter-cloud-hq3" {
        return run_cloud_read_only(app, Some("BATTER UP - UVR HQ3 - Instrumental")).await;
    }
    if phase == "batter-cloud-vst" {
        return run_cloud_read_only(app, Some("BATTER UP - VST Remix 100 - Instrumental")).await;
    }
    if phase == "ai" {
        return run_ai(app).await;
    }
    if phase == "online-ai" {
        return run_online_ai(app).await;
    }
    if phase == "online-ai-local" {
        return run_online_ai_local(app, false).await;
    }
    if phase == "online-ai-cache-upload" {
        return run_online_ai_local(app, true).await;
    }
    if phase == "exclusive" {
        return run_exclusive(app).await;
    }
    if phase == "cloud" {
        let mut checks = run_cloud_read_only(app, None).await?;
        if let Ok(preset) = std::env::var("RUSTMUSIC_ACCEPTANCE_OBS_PRESET") {
            let mut config = settings();
            config["preset"] = json!(preset);
            config["css"] = json!("");
            crate::obs_lyrics::set_obs_lyrics_settings(app.state(), config.to_string())?;
            if snapshot()?["settings"] != config {
                return Err("OBS preset did not reach the live lyrics service".into());
            }
            checks["obsPreset"] = config["preset"].clone();
        }
        return Ok(checks);
    }
    let expected = settings();
    if phase == "write" {
        crate::obs_lyrics::set_obs_lyrics_settings(app.state(), expected.to_string())?;
    } else if phase != "restore" {
        return Err(
            "Acceptance phase must be write, restore, ai, cloud, online-ai, online-ai-local, online-ai-cache-upload, or exclusive"
                .into(),
        );
    }
    let restored: Value =
        serde_json::from_str(&crate::obs_lyrics::get_obs_lyrics_settings(app.state())?)
            .map_err(|e| e.to_string())?;
    if restored != expected || snapshot()?["settings"] != expected {
        return Err("Saved settings differ from command or live server state".into());
    }
    if phase == "restore" {
        return Ok(json!({"settingsRestoredAfterRestart":true,"nativeServerSettings":true}));
    }
    crate::commands::set_volume(app.state(), 0.0).await?;
    let vst = crate::commands::vocal_removal_status();
    if !vst.installed {
        return Err("Real Remix could not load".into());
    }
    for amount in [0.0, 50.0, 100.0, 0.0] {
        crate::commands::set_vocal_removal(app.state(), amount)?;
    }
    let audio = std::env::var("RUSTMUSIC_ACCEPTANCE_AUDIO").map_err(|e| e.to_string())?;
    crate::accompaniment::play_accompaniment(
        app.state(),
        audio.clone(),
        "Acceptance instrumental".into(),
        "Fixture".into(),
        String::new(),
        "netease".into(),
        "42".into(), None, None)
    .await?;
    std::thread::sleep(Duration::from_millis(500));
    crate::commands::pause(app.state()).await?;
    let first = snapshot()?;
    std::thread::sleep(Duration::from_millis(250));
    let paused = snapshot()?;
    if paused["playing"] != false || first["positionMs"] != paused["positionMs"] {
        return Err(format!(
            "Paused engine progress did not freeze: {first} / {paused}"
        ));
    }
    if paused["trackKey"] != "netease:42" {
        return Err("Accompaniment lost original provider identity".into());
    }
    crate::commands::seek(app.state(), 5000).await?;
    let sought = snapshot()?;
    let position = sought["positionMs"].as_u64().unwrap_or(0);
    if !(4500..=5100).contains(&position) || sought["durationMs"].as_u64().unwrap_or(0) < 20000 {
        return Err(format!(
            "Seek must preserve actual audio duration and correct progress: {sought}"
        ));
    }
    let outputs = crate::commands::list_output_devices(app.state()).await?;
    let devices = outputs["devices"]
        .as_array()
        .ok_or("Missing output devices")?;
    if devices.is_empty() {
        return Err("No real output devices available for switch acceptance".into());
    }
    crate::commands::set_speed(app.state(), 1.25).await?;
    crate::commands::set_vocal_removal(app.state(), 50.0)?;
    let mut shared_output_keys = std::collections::HashSet::new();
    for device in devices {
        let name = device["name"]
            .as_str()
            .ok_or("Output device name missing")?;
        crate::commands::set_output_device(app.state(), Some(name.into())).await?;
        let endpoint_key = app
            .state::<crate::AppState>()
            .engine
            .acceptance_shared_output_key()
            .ok_or("Switched shared output has no registered endpoint")?;
        if !shared_output_keys.insert(endpoint_key) {
            return Err("Different output devices reused the same shared endpoint".into());
        }
        let actual = crate::commands::list_output_devices(app.state()).await?;
        let state = snapshot()?;
        if actual["preference"] != name
            || state["playing"] != false
            || state["trackKey"] != "netease:42"
            || state["positionMs"].as_u64().unwrap_or(0).abs_diff(position) > 250
            || app.state::<crate::AppState>().engine.speed() != 1.25
        {
            return Err(
                "Output switch lost device preference, pause, progress, track, or speed".into(),
            );
        }
    }
    let before_invalid = crate::commands::list_output_devices(app.state()).await?;
    if crate::commands::set_output_device(
        app.state(),
        Some("RUSTMUSIC-NONEXISTENT-ACCEPTANCE-DEVICE".into()),
    )
    .await
    .is_ok()
        || crate::commands::list_output_devices(app.state()).await?["preference"]
            != before_invalid["preference"]
    {
        return Err("Invalid output device must fail without changing preference".into());
    }
    crate::commands::set_output_device(app.state(), None).await?;
    if !crate::commands::list_output_devices(app.state()).await?["preference"].is_null() {
        return Err("Follow-default output preference was not restored".into());
    }
    crate::commands::set_speed(app.state(), 1.0).await?;
    crate::commands::set_vocal_removal(app.state(), 0.0)?;
    crate::commands::resume(app.state()).await?;
    std::thread::sleep(Duration::from_millis(300));
    let resumed = snapshot()?;
    if resumed["positionMs"].as_u64().unwrap_or(0) <= position {
        return Err("Real engine progress did not advance after resume".into());
    }
    let current_output = crate::commands::list_output_devices(app.state()).await?;
    let current_name = current_output["current"]
        .as_str()
        .ok_or("Current output missing")?;
    crate::commands::set_output_device(app.state(), Some(current_name.into())).await?;
    std::thread::sleep(Duration::from_millis(300));
    let switched_playing = snapshot()?;
    if switched_playing["playing"] != true
        || switched_playing["positionMs"].as_u64().unwrap_or(0)
            <= resumed["positionMs"].as_u64().unwrap_or(0)
    {
        return Err("Switching output while playing stopped playback or lost progress".into());
    }
    crate::commands::pause(app.state()).await?;
    crate::commands::set_output_device(app.state(), None).await?;
    let first_lyrics = json!({
        "synced":true,
        "lines":[{"timeMs":500,"text":"first acceptance lyric","trans":"第一句",
            "words":[{"startMs":500,"endMs":900,"text":"first"}]}]
    });
    crate::obs_lyrics::publish_obs_lyrics(
        app.state(),
        json!({
            "trackKey":"netease:42","title":"Acceptance instrumental","artist":"Fixture",
            "lyrics":first_lyrics,"playing":false,"lyricOffsetMs":375
        }),
    );
    let lyric_42 = snapshot()?;
    if lyric_42["trackKey"] != "netease:42"
        || lyric_42["lyrics"] != first_lyrics
        || lyric_42["lyricOffsetMs"] != 375
    {
        return Err(format!(
            "Published lyrics or offset missing for first real track: {lyric_42}"
        ));
    }

    crate::accompaniment::play_accompaniment(
        app.state(),
        audio.clone(),
        "Acceptance second track".into(),
        "Fixture".into(),
        String::new(),
        "netease".into(),
        "43".into(), None, None)
    .await?;
    std::thread::sleep(Duration::from_millis(250));
    let stale_cleared = snapshot()?;
    if stale_cleared["trackKey"] != "netease:43"
        || stale_cleared["lyrics"]
            .to_string()
            .contains("first acceptance lyric")
    {
        return Err(format!(
            "Changing real track leaked old lyrics into its new snapshot: {stale_cleared}"
        ));
    }
    crate::commands::pause(app.state()).await?;
    let second_lyrics = json!({
        "synced":true,
        "lines":[{"timeMs":1200,"text":"second acceptance lyric","trans":"第二句",
            "words":[{"startMs":1200,"endMs":1750,"text":"second"}]}]
    });
    let second_payload = json!({
        "trackKey":"netease:43","title":"Acceptance second track","artist":"Fixture",
        "lyrics":second_lyrics,"playing":false,"lyricOffsetMs":-250
    });
    let mut lyric_43 = snapshot()?;
    for _ in 0..10 {
        if lyric_43["lyrics"] == second_lyrics && lyric_43["lyricOffsetMs"] == -250 {
            break;
        }
        crate::obs_lyrics::publish_obs_lyrics(app.state(), second_payload.clone());
        std::thread::sleep(Duration::from_millis(50));
        lyric_43 = snapshot()?;
    }
    let lyric_43_reconnected = snapshot()?;
    if lyric_43["trackKey"] != "netease:43"
        || lyric_43["lyrics"] != second_lyrics
        || lyric_43["lyricOffsetMs"] != -250
        || lyric_43_reconnected != lyric_43
    {
        return Err(format!("Fresh HTTP requests did not receive the complete second-track snapshot: {lyric_43} / {lyric_43_reconnected}"));
    }
    crate::commands::stop(app.state()).await?;
    Ok(json!({"remixLoaded":true,"strengthCommands":[0,50,100,0],
        "outputDevicesSwitched":devices.len(),"distinctSharedOutputEndpoints":shared_output_keys.len(),"outputSwitchPreservedPausePositionSpeed":true,
        "outputSwitchWhilePlayingAdvanced":true,
        "invalidOutputRejectedWithoutPreferenceChange":true,"followSystemDefaultRestored":true,
        "realAccompanimentPlayback":true,"originalTrackKey":"netease:42",
        "pauseFrozen":true,"seekPositionMs":position,"durationMs":sought["durationMs"],
        "resumeAdvanced":true,"settingsSaved":true,"lyrics42PublishedWithOffset":true,
        "secondRealTrackInvalidatedOldLyrics":true,"lyrics43RestoredWithOffset":true,
        "completeSnapshotOnRepeatedFreshHttpRequests":true,
        "connectionCheck":"repeated independent HTTP requests; not an OBS application reconnect test"}))
}

pub fn start(app: tauri::AppHandle) {
    if std::env::var_os("RUSTMUSIC_ACCEPTANCE_PROFILE").is_none() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        let phase = std::env::var("RUSTMUSIC_ACCEPTANCE_PHASE").unwrap_or_else(|_| "write".into());
        let result = tauri::async_runtime::block_on(run(&app, &phase));
        let code = if result.is_ok() { 0 } else { 1 };
        let report = match result {
            Ok(checks) => json!({"passed":true,"phase":phase,"checks":checks}),
            Err(error) => json!({"passed":false,"phase":phase,"error":error}),
        };
        let path = app
            .state::<crate::AppState>()
            .app_data
            .join(format!("report-{phase}.json"));
        if let Err(error) = std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()) {
            eprintln!("Acceptance report failed: {error}");
            app.exit(1);
            return;
        }
        // Keep the actual verified lyric state available to the opt-in OBS
        // source-capture harness; never enabled in a normal release build.
        if code == 0
            && phase == "cloud"
            && std::env::var("RUSTMUSIC_ACCEPTANCE_OBS_HOLD").as_deref() == Ok("1")
        {
            if std::env::var("RUSTMUSIC_ACCEPTANCE_OBS_RECOVERY").as_deref() == Ok("1") {
                use std::sync::atomic::Ordering;
                std::thread::sleep(Duration::from_secs(20));
                crate::obs_lyrics::ACCEPTANCE_DROP_STATE.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(5));
                crate::obs_lyrics::ACCEPTANCE_DROP_STATE.store(false, Ordering::SeqCst);
                let mut config = settings();
                config["preset"] = json!("neon");
                config["css"] = json!("");
                let restored = crate::obs_lyrics::set_obs_lyrics_settings(app.state(), config.to_string());
                let dropped = crate::obs_lyrics::ACCEPTANCE_DROPPED.load(Ordering::SeqCst);
                let evidence = json!({"passed":restored.is_ok() && dropped > 0,
                    "connectionsClosedWithoutResponse":dropped,"outageSeconds":5,"restoredPreset":"neon"});
                let _ = std::fs::write(app.state::<crate::AppState>().app_data.join("report-obs-outage.json"),
                    serde_json::to_vec_pretty(&evidence).unwrap());
                std::thread::sleep(Duration::from_secs(35));
            } else {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        app.exit(code);
    });
}
