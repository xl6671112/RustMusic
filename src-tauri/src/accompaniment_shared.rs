//! Cross-account descriptors contain no cookies; each recipient publishes to its own cloud.
use super::*;
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedStem {
    source_kind: String,
    source_id: String,
    stem: String,
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration_ms: u64,
    #[serde(default)]
    lyrics: Option<Value>,
    md5: String,
    length: u64,
    sample_rate: u32,
    bit_depth: u16,
    channels: u16,
    model: String,
    #[serde(default)]
    model_id: String,
    #[serde(default)]
    model_name: String,
    #[serde(default)]
    model_version: String,
    cloud_id: i64,
}

pub(super) fn stem(result: &AccompanimentResult) -> &str {
    if result.stem == "vocals" { "vocals" } else { "instrumental" }
}

fn source(result: &AccompanimentResult) -> Option<(String, String)> {
    match result.source_kind.as_str() {
        "netease" | "qq" | "kugou" | "bilibili" if !result.source_id.is_empty() =>
            Some((result.source_kind.clone(), result.source_id.clone())),
        "track" => result.original_source.as_deref()
            .and_then(|path| sha256(Path::new(path)).ok()).map(|hash| ("sha256".into(), hash)),
        _ => None,
    }
}

fn request(url: &str) -> ureq::Request {
    ureq::get(url).timeout(Duration::from_secs(8))
}

pub(super) fn reuse(result: &AccompanimentResult, cookie: &str) -> Result<Option<AccompanimentResult>, String> {
    let Some((kind, id)) = source(result) else { return Ok(None); };
    let mut url = tauri::Url::parse(&format!("{}/api/shared-stems", crate::updater::WEBSITE)).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("sourceKind", &kind).append_pair("sourceId", &id).append_pair("stem", stem(result));
    // A catalog outage must leave local generation available.
    let response: Value = match request(url.as_str()).call().and_then(|r| r.into_json().map_err(ureq::Error::from)) {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    let Some(items) = response["items"].as_array() else { return Ok(None); };
    for item in items.iter().take(10) {
        let Ok(descriptor) = serde_json::from_value::<SharedStem>(item.clone()) else { continue; };
        if descriptor.source_kind != kind || descriptor.source_id != id || descriptor.stem != stem(result)
            || descriptor.md5.len() != 32 || !descriptor.md5.bytes().all(|b| b.is_ascii_hexdigit())
            || descriptor.length < 44 || descriptor.length > 8 * 1024 * 1024 * 1024
            || (result.duration_ms > 0 && descriptor.duration_ms.abs_diff(result.duration_ms) > 2500) { continue; }
        // Try candidates in gateway quality order. A hash miss never transfers bytes.
        let cloud_id = match publish_hash(&descriptor, cookie, &mut ProductionCloudTransport) {
            Ok(Some(id)) => id,
            Ok(None) => continue,
            Err(error) => return Err(format!("共享音轨秒传暂未完成：{error}。请重试；未重复提取或上传音频")),
        };
        let mut reused = result.clone();
        reused.path = format!("cloud:{cloud_id}");
        reused.cloud_id = Some(cloud_id);
        reused.model = descriptor.model;
        reused.model_id = descriptor.model_id;
        reused.model_name = descriptor.model_name;
        reused.model_version = descriptor.model_version;
        reused.device = "shared_cloud".into();
        reused.upload_status = "uploaded".into();
        reused.upload_error = None;
        if reused.cover.is_empty() { reused.cover = descriptor.cover; }
        if reused.lyrics.is_none() { reused.lyrics = descriptor.lyrics; }
        return Ok(Some(reused));
    }
    Ok(None)
}

fn publish_hash(v: &SharedStem, cookie: &str, transport: &mut impl CloudTransport) -> Result<Option<i64>, String> {
    let check = transport.api("/api/cloud/upload/check", &json!({
        "bitrate":"999000","ext":"","length":v.length,"md5":v.md5,"songId":"0","version":1
    }), cookie)?;
    if check["code"].as_i64() != Some(200) || check["needUpload"].as_bool() != Some(false) { return Ok(None); }
    let filename = format!("{}-{}.wav", v.md5, v.stem);
    let allocated = transport.weapi("/weapi/nos/token/alloc", &json!({
        "bucket":"jd-musicrep-privatecloud-audio-public","ext":"wav","filename":filename,
        "local":false,"nos_product":3,"type":"audio","md5":v.md5
    }), cookie)?;
    let resource = &allocated["result"]["resourceId"];
    if !resource.as_str().is_some_and(|value| !value.is_empty()) && !resource.as_u64().is_some_and(|value| value > 0) {
        return Err("秒传资源信息无效".into());
    }
    let title = if v.stem == "vocals" { format!("{}（人声）", v.title) } else { accompaniment_title(&v.title) };
    let info = transport.api("/api/upload/cloud/info/v2", &json!({
        "md5":v.md5,"songid":check["songId"],"filename":filename,"song":title,
        "album":if v.album.is_empty() { "Instrumental" } else { &v.album },
        "artist":if v.artist.is_empty() { "Unknown Artist" } else { &v.artist },
        "bitrate":"999000","resourceId":resource
    }), cookie)?;
    let id = info["songId"].as_i64().or_else(|| info["songId"].as_str()?.parse().ok()).filter(|id| *id > 0);
    if info["code"].as_i64() != Some(200) { return Err("秒传歌曲登记失败".into()); }
    let id = id.ok_or("秒传歌曲编号无效")?;
    let published = transport.api("/api/cloud/pub/v2", &json!({"songid":id}), cookie)?;
    // Re-publishing an already present hash can return a non-200 response.
    // The account's own listing must prove the exact ID returned for this hash.
    for offset in (0..100_000).step_by(100) {
        let response = transport.weapi("/weapi/v1/cloud/get", &json!({"limit":100,"offset":offset}), cookie)?;
        if response["code"].as_i64() != Some(200) { return Err("秒传列表验证失败".into()); }
        let page = response["data"].as_array().ok_or("秒传列表格式无效")?;
        if page.iter().any(|row| row["songId"].as_i64().or_else(|| row["songId"].as_str()?.parse().ok()) == Some(id)) { return Ok(Some(id)); }
        if page.len() < 100 || response["hasMore"].as_bool() == Some(false) { break; }
    }
    if published["code"].as_i64() != Some(200) {
        return Err(format!("秒传发布失败（code={}）", published["code"]));
    }
    Err("秒传音轨尚未出现在云盘".into())
}

fn wave_quality(bytes: &[u8]) -> Option<(u32, u16, u16, u64)> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" { return None; }
    let mut offset = 12usize;
    let mut format = None;
    let mut data_length = None;
    while offset.checked_add(8)? <= bytes.len() {
        let size = u32::from_le_bytes(bytes.get(offset + 4..offset + 8)?.try_into().ok()?) as usize;
        let body = offset.checked_add(8)?;
        let end = body.checked_add(size)?;
        if end > bytes.len() { return None; }
        if bytes.get(offset..offset + 4)? == b"fmt " && size >= 16 {
            let channel = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().ok()?);
            let rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?);
            let align = u16::from_le_bytes(bytes[body + 12..body + 14].try_into().ok()?);
            let depth = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().ok()?);
            if rate == 0 || align == 0 || channel == 0 { return None; }
            format = Some((rate, depth, channel, align));
        }
        if bytes.get(offset..offset + 4)? == b"data" { data_length = Some(size as u64); }
        offset = end.checked_add(size % 2)?;
    }
    let (rate, depth, channels, align) = format?;
    Some((rate, depth, channels, data_length? * 1000 / u64::from(align) / u64::from(rate)))
}

pub(super) fn register(result: &AccompanimentResult) -> Result<(), String> {
    let Some((kind, id)) = source(result) else { return Ok(()); };
    let Some(cloud_id) = result.cloud_id.filter(|id| *id > 0) else { return Ok(()); };
    let bytes = fs::read(&result.path).map_err(|e| e.to_string())?;
    let md5 = format!("{:x}", md5::Md5::digest(&bytes));
    if result.published_md5.as_deref() != Some(md5.as_str()) { return Ok(()); }
    let (sample_rate, bit_depth, channels, duration) = wave_quality(&bytes).ok_or("无法读取共享音轨音质")?;
    let record = SharedStem {
        source_kind: kind, source_id: id, stem: stem(result).into(), title: result.title.clone(),
        artist: result.artist.clone(), album: result.album.clone(), cover: result.cover.clone(),
        duration_ms: duration, lyrics: result.lyrics.clone(), md5,
        length: bytes.len() as u64, sample_rate, bit_depth, channels, model: result.model.clone(),
        model_id: result.model_id.clone(), model_name: result.model_name.clone(), model_version: result.model_version.clone(), cloud_id,
    };
    ureq::post(&format!("{}/api/shared-stems", crate::updater::WEBSITE)).timeout(Duration::from_secs(8))
        .send_json(serde_json::to_value(record).map_err(|e| e.to_string())?)
        .map_err(|_| "云盘已保存，共享目录暂时无法连接".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Publishes an existing real accompaniment descriptor and hash-registers it in the saved second debug account"]
    fn live_gateway_reuses_existing_audio_in_saved_second_account() {
        let audio = PathBuf::from(std::env::var_os("RUSTMUSIC_SHARED_AUDIO").expect("Existing BATTER UP HQ3 output"));
        let report = PathBuf::from(std::env::var_os("RUSTMUSIC_SHARED_REPORT").expect("New report path"));
        assert!(audio.is_absolute() && valid_wav(&audio) && report.is_absolute() && !report.exists());
        let first = crate::credentials::get("netease_music_u").expect("Current account is signed in");
        let second = keyring::Entry::new("RustMusic.HashTransferDebug", "second_account")
            .ok().and_then(|entry| entry.get_password().ok()).expect("Saved second debug account");
        assert!(first != second, "The verification requires two distinct accounts");
        let mut original_id = None;
        for offset in (0..10000).step_by(100) {
            let page = crate::netease::weapi_post("/weapi/v1/cloud/get",
                &json!({"limit":100,"offset":offset}).to_string(), Some(&first))
                .map_err(|_| "First-account cloud listing failed").unwrap();
            assert_eq!(page["code"].as_i64(), Some(200));
            let rows = page["data"].as_array().expect("Cloud listing rows");
            original_id = rows.iter().find(|row| row["songName"].as_str() == Some("BATTER UP - UVR HQ3 - Instrumental")
                || row.pointer("/simpleSong/name").and_then(Value::as_str) == Some("BATTER UP - UVR HQ3 - Instrumental"))
                .and_then(|row| row["songId"].as_i64().or_else(|| row["songId"].as_str()?.parse().ok()));
            if original_id.is_some() || rows.len() < 100 { break; }
        }
        let bytes = fs::read(&audio).unwrap();
        let md5 = format!("{:x}", md5::Md5::digest(&bytes));
        let (_, _, _, duration) = wave_quality(&bytes).expect("Real WAV quality");
        let mut transport = ProductionCloudTransport;
        let checked = transport.api("/api/cloud/upload/check",
            &json!({"bitrate":"999000","ext":"","length":bytes.len(),"md5":md5,"songId":"0","version":1}), &first)
            .map_err(|_| "First-account hash check failed").unwrap();
        assert_eq!(checked["needUpload"].as_bool(), Some(false), "Only existing uploaded audio may enter this verification");
        let package_id = std::env::var("RUSTMUSIC_SHARED_MODEL_ID").expect("Published HQ3 catalog ID");
        let result = AccompanimentResult { path:audio.to_string_lossy().into_owned(), device:"CPU".into(),
            model:MODEL.into(), model_id:package_id, model_name:"UVR HQ3".into(), model_version:"1.0.0".into(),
            title:"BATTER UP".into(), artist:"BABYMONSTER".into(), album:"BATTER UP".into(),
            source_kind:"netease".into(), source_id:"2103336805".into(), duration_ms:duration,
            cloud_id:Some(original_id.expect("Existing first-account cloud song")), published_md5:Some(md5.clone()), ..Default::default() };
        register(&result).expect("Register real shared metadata");
        let recipient = reuse(&result, &second).expect("Gateway reuse must succeed").expect("Gateway must return the published real stem");
        assert_eq!(recipient.device, "shared_cloud");
        assert_eq!(recipient.model_id, result.model_id);
        assert_eq!(recipient.title, result.title);
        assert!(recipient.cloud_id.is_some());
        fs::write(report, serde_json::to_vec_pretty(&json!({
            "passed":true,"distinctAccounts":true,"sourceKind":"netease","sourceId":"2103336805",
            "modelId":recipient.model_id,"modelVersion":recipient.model_version,
            "title":recipient.title,"md5":md5,"length":bytes.len(),"cloudSongId":recipient.cloud_id,
            "path":recipient.path,"mode":"gateway descriptor to recipient hash check, publication and cloud listing",
            "audioUploadTransportCalled":false,"primaryLoginUnchanged":crate::credentials::get("netease_music_u").as_deref()==Some(first.as_str())
        })).unwrap()).unwrap();
    }
    struct NoAudio { need_upload: bool, calls: Vec<String>, publish_code: i64, listed: bool }
    impl CloudTransport for NoAudio {
        fn api(&mut self, path: &str, _: &Value, _: &str) -> Result<Value, String> {
            self.calls.push(path.into());
            Ok(match path {
                "/api/cloud/upload/check" => json!({"code":200,"needUpload":self.need_upload,"songId":"opaque-hash"}),
                "/api/upload/cloud/info/v2" => json!({"code":200,"songId":42}),
                "/api/cloud/pub/v2" => json!({"code":self.publish_code}),
                _ => panic!("Unexpected endpoint"),
            })
        }
        fn weapi(&mut self, path: &str, _: &Value, _: &str) -> Result<Value, String> {
            self.calls.push(path.into());
            Ok(if path.ends_with("/alloc") { json!({"result":{"resourceId":99}}) }
                else { json!({"code":200,"data":if self.listed {vec![json!({"songId":42})]} else {vec![]},"hasMore":false}) })
        }
        fn lbs(&mut self, _: &str) -> Result<Value, String> { panic!("Hash sharing must never upload audio") }
        fn nos(&mut self, _: &str, _: &str, _: &str, _: &[u8]) -> Result<(), String> { panic!("Hash sharing must never upload audio") }
    }
    #[test]
    fn hash_miss_does_not_allocate_and_hit_registers_in_recipient_account() {
        let record: SharedStem = serde_json::from_value(json!({"sourceKind":"netease","sourceId":"1","stem":"instrumental",
            "title":"song","artist":"artist","album":"","cover":"","durationMs":1000,"md5":"a".repeat(32),"length":1000,
            "sampleRate":44100,"bitDepth":16,"channels":2,"model":"HQ3","cloudId":1})).unwrap();
        let mut transport = NoAudio { need_upload: true, calls: Vec::new(), publish_code: 200, listed: true };
        assert_eq!(publish_hash(&record, "recipient", &mut transport).unwrap(), None);
        assert_eq!(transport.calls, ["/api/cloud/upload/check"]);
        transport.need_upload = false;
        assert_eq!(publish_hash(&record, "recipient", &mut transport).unwrap(), Some(42));
        assert!(transport.calls.iter().any(|path| path == "/api/cloud/pub/v2"));
        transport.publish_code = 201;
        assert_eq!(publish_hash(&record, "recipient", &mut transport).unwrap(), Some(42),
            "An already published hash must remain reusable when its exact account entry is verified");
        transport.listed = false;
        assert!(publish_hash(&record, "recipient", &mut transport).is_err(),
            "A duplicate/error response without a verified account entry must never be reported as success");
    }
    #[test]
    fn local_database_ids_cannot_match_unrelated_users_songs() {
        let result = AccompanimentResult { source_kind:"track".into(),source_id:"1".into(),..Default::default() };
        assert!(source(&result).is_none(), "Local IDs alone must never be shared globally");
    }
    #[test]
    fn shared_quality_comes_from_wave_frames_not_file_size_or_source_tags() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36u32 + 192000).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48000u32.to_le_bytes());
        bytes.extend_from_slice(&192000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&192000u32.to_le_bytes());
        bytes.resize(44 + 192000, 0);
        assert_eq!(wave_quality(&bytes), Some((48000,16,2,1000)));
        bytes.truncate(100);
        assert!(wave_quality(&bytes).is_none(), "A partial WAV cannot claim full-quality shared audio");
    }
}
