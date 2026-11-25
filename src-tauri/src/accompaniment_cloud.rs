//! Cloud reuse is account-scoped; only unique, complete metadata matches are reused.
use super::*;
use serde_json::{json, Value};

fn id(row: &Value) -> Option<i64> {
    row["songId"].as_i64().or_else(|| row["songId"].as_str()?.parse().ok()).filter(|id| *id > 0)
}

fn original_title(title: &str) -> Option<&str> {
    let title = title.strip_suffix("（伴奏）").or_else(|| title.strip_suffix(" - Instrumental"))?;
    if title.contains(" - VST ") { return None; }
    Some(title.strip_suffix(" - UVR HQ3").unwrap_or(title))
}

fn rows(cookie: &str) -> Result<Vec<Value>, String> {
    rows_with(cookie, &mut ProductionCloudTransport)
}

fn rows_with(cookie: &str, transport: &mut impl CloudTransport) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    for offset in (0..100_000).step_by(100) {
        let response = transport.weapi("/weapi/v1/cloud/get", &json!({"limit":100,"offset":offset}), cookie)?;
        if response["code"].as_i64() != Some(200) { return Err("读取云盘伴奏失败，请重试；未重复上传".into()); }
        let page = response["data"].as_array().ok_or("云盘列表格式无效")?;
        all.extend(page.iter().cloned());
        if page.len() < 100 || response["hasMore"].as_bool() == Some(false) { return Ok(all); }
    }
    Err("云盘列表超出检查范围，未将未检查内容判断为不存在".into())
}

fn metadata_matches(row: &Value, result: &AccompanimentResult) -> bool {
    let title = row["songName"].as_str().or_else(|| row.pointer("/simpleSong/name")?.as_str()).unwrap_or("");
    let artist = row["artist"].as_str().unwrap_or("");
    let album = row["album"].as_str().unwrap_or("");
    let original = if shared::stem(result) == "vocals" { title.strip_suffix("（人声）") } else { original_title(title) };
    original == Some(result.title.as_str())
        && !result.artist.trim().is_empty() && artist == result.artist
        && album == if result.album.is_empty() { "Instrumental" } else { &result.album }
        && row.pointer("/simpleSong/dt").and_then(Value::as_u64)
            .filter(|duration| *duration > 0 && result.duration_ms > 0)
            .is_none_or(|duration| duration.abs_diff(result.duration_ms) <= 2500)
}

fn match_id(rows: &[Value], result: &AccompanimentResult, account: &str) -> Result<Option<i64>, String> {
    if result.cloud_account.as_deref() == Some(account) {
        if let Some(known) = result.cloud_id.filter(|known| rows.iter().any(|row| id(row) == Some(*known))) {
            return Ok(Some(known));
        }
    }
    let matches: Vec<_> = rows.iter().filter(|row| metadata_matches(row, result)).filter_map(id).collect();
    match matches.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(*one)),
        _ => Err("云盘存在多个同名同歌手同专辑伴奏，无法唯一识别；未覆盖或重复上传".into()),
    }
}

fn save_reference(result: &AccompanimentResult, directory: &Path, account: &str) -> Result<(), String> {
    if account.is_empty() { return Err("无法确认当前云盘账号".into()); }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let key = format!("{:x}", Sha256::digest(account.as_bytes()));
    let target = directory.join(format!("cloud-{key}-{}.json", result.cloud_id.ok_or("缺少云盘ID")?));
    let temp = target.with_extension(format!("{}.partial", rand::random::<u64>()));
    fs::write(&temp, serde_json::to_vec(result).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, target).map_err(|e| e.to_string())
}

pub(super) fn reuse(result: &AccompanimentResult, directory: &Path, account: &str) -> Result<Option<AccompanimentResult>, String> {
    let Some(cookie) = crate::credentials::get("netease_music_u") else { return Ok(None); };
    // Server weights can promote a better model even when this account has an older render.
    let preferred = shared::reuse(result, &cookie)?;
    let Some(mut reused) = (if preferred.is_some() { preferred } else {
        reuse_with(result, directory, account, &cookie, &mut ProductionCloudTransport)?
    }) else { return Ok(None); };
    reused.cloud_account = Some(account.into());
    if shared::stem(result) == "instrumental" && reused.vocals_path.is_none() && reused.vocals_cloud_id.is_none() {
        let mut vocal = result.clone();
        vocal.stem = "vocals".into();
        let preferred = shared::reuse(&vocal, &cookie)?;
        if let Some(mut vocal) = if preferred.is_some() { preferred } else {
            reuse_with(&vocal, directory, account, &cookie, &mut ProductionCloudTransport)?
        } {
            vocal.cloud_account = Some(account.into());
            reused.vocals_path = Some(vocal.path.clone());
            reused.vocals_cloud_id = vocal.cloud_id;
            save_reference(&vocal, directory, account)?;
        }
    }
    save_reference(&reused, directory, account)?;
    Ok(Some(reused))
}

fn reuse_with(result: &AccompanimentResult, directory: &Path, account: &str, cookie: &str, transport: &mut impl CloudTransport) -> Result<Option<AccompanimentResult>, String> {
    if account.is_empty() { return Err("无法确认云盘账号，请重新登录".into()); }
    let available = rows_with(cookie, transport)?;
    let mut identity = result.clone();
    for known in list_references(directory, account)? {
        if !result.source_id.is_empty() && known.source_id == result.source_id && known.source_kind == result.source_kind && shared::stem(&known) == shared::stem(result) {
            identity.cloud_id = known.cloud_id;
            identity.cloud_account = known.cloud_account;
            identity.vocals_path = known.vocals_path;
            identity.vocals_cloud_id = known.vocals_cloud_id;
            if identity.lyrics.is_none() { identity.lyrics = known.lyrics; }
            break;
        }
    }
    let Some(cloud_id) = match_id(&available, &identity, account)? else { return Ok(None); };
    let mut reused = identity;
    reused.path = format!("cloud:{cloud_id}");
    reused.cloud_id = Some(cloud_id);
    reused.cloud_account = Some(account.into());
    reused.device = "cloud".into();
    reused.upload_status = "uploaded".into();
    reused.upload_error = None;
    save_reference(&reused, directory, account)?;
    Ok(Some(reused))
}

fn list_references(directory: &Path, account: &str) -> Result<Vec<AccompanimentResult>, String> {
    if !directory.exists() { return Ok(Vec::new()); }
    let mut results = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path.file_name().unwrap_or_default().to_string_lossy().starts_with("cloud-") || path.extension().is_none_or(|ext| ext != "json") { continue; }
        if let Ok(result) = fs::read(path).map_err(|e| e.to_string()).and_then(|bytes| serde_json::from_slice::<AccompanimentResult>(&bytes).map_err(|e| e.to_string())) {
            if result.cloud_account.as_deref() == Some(account) { results.push(result); }
        }
    }
    Ok(results)
}

fn reconcile_local(results: &mut [AccompanimentResult], available: &[Value], account: &str) -> Result<(), String> {
    if account.is_empty() { return Ok(()); }
    for result in results {
        // A prior replacement's ID proves only the old audio exists, not the new render.
        if result.pending_replace || result.replace_cloud_id.is_some()
            || result.cloud_account.as_deref() != Some(account)
            || !result.cloud_id.is_some_and(|known| available.iter().any(|row| id(row) == Some(known))) {
            continue;
        }
        if result.upload_status == "uploaded" && result.upload_error.is_none() { continue; }
        if result.upload_status == "uploaded" {
            // Legacy records used the upload error field for post-upload warnings too.
            result.upload_warning = result.upload_error.take();
        }
        result.upload_status = "uploaded".into();
        result.upload_error = None;
        library::persist(result)?;
    }
    Ok(())
}

pub(super) fn list(directory: &Path, account: &str) -> Result<Vec<AccompanimentResult>, String> {
    let mut results = library::list(directory)?;
    let mut vocals = library::list(&directory.join("Vocals"))?;
    for vocal in &mut vocals {
        if vocal.source_id.is_empty() {
            if let Some(original) = results.iter().find(|item| item.vocals_path.as_deref() == Some(vocal.path.as_str())) {
                let path = vocal.path.clone();
                *vocal = original.clone();
                vocal.path = path;
                vocal.cloud_id = original.vocals_cloud_id;
            }
        }
        vocal.stem = "vocals".into();
        vocal.vocals_path = None;
        vocal.vocals_cloud_id = None;
    }
    results.extend(vocals);
    let Some(cookie) = crate::credentials::get("netease_music_u") else { return Ok(results); };
    let available = rows(&cookie)?;
    reconcile_local(&mut results, &available, account)?;
    let references = list_references(directory, account)?;
    for row in &available {
        let Some(cloud_id) = id(row) else { continue; };
        if results.iter().any(|r| r.cloud_id == Some(cloud_id) && r.cloud_account.as_deref() == Some(account)) { continue; }
        if let Some(known) = references.iter().find(|r| r.cloud_id == Some(cloud_id)) {
            let mut known = known.clone(); known.path = format!("cloud:{cloud_id}");
            if known.upload_status == "uploaded" { known.upload_warning = known.upload_error.take().or(known.upload_warning); }
            known.upload_status = "uploaded".into(); known.upload_error = None;
            results.push(known); continue;
        }
        let name = row["songName"].as_str().unwrap_or("");
        let (title, stem) = if let Some(title) = name.strip_suffix("（人声）") { (title, "vocals") }
            else if let Some(title) = original_title(name) { (title, "instrumental") } else { continue; };
        results.push(AccompanimentResult {
            path: format!("cloud:{cloud_id}"), title: title.into(),
            artist: row["artist"].as_str().unwrap_or("").into(),
            album: row["album"].as_str().unwrap_or("").into(),
            duration_ms: row.pointer("/simpleSong/dt").and_then(Value::as_u64).unwrap_or(0),
            cover: row.pointer("/simpleSong/al/picUrl").and_then(Value::as_str).unwrap_or("").into(),
            cloud_id: Some(cloud_id), cloud_account: Some(account.into()),
            device: "cloud".into(), upload_status: "uploaded".into(),
            stem: stem.into(),
            ..Default::default()
        });
    }
    Ok(results)
}

pub(super) fn publish(result: &mut AccompanimentResult, directory: &Path, account: &str, replace: bool) -> Result<(), String> {
    let mut vocals = result.vocals_path.clone().filter(|path| !path.starts_with("cloud:")).map(|path| {
        let mut vocal = result.clone();
        vocal.path = path; vocal.stem = "vocals".into(); vocal.cloud_id = result.vocals_cloud_id;
        vocal.vocals_path = None; vocal.vocals_cloud_id = None; vocal.published_md5 = None;
        vocal.replace_cloud_id = None; vocal.replacement_target = None; vocal.pending_replace = replace;
        vocal.upload_status = "local_only".into(); vocal.upload_error = None;
        vocal
    });
    if let Some(vocal) = &vocals { library::persist(vocal)?; }
    let Some(cookie) = crate::credentials::get("netease_music_u") else {
        result.upload_status = "skipped_not_signed_in".into(); return Ok(());
    };
    publish_with(result, directory, account, replace, &cookie, &mut ProductionCloudTransport)?;
    result.upload_warning = shared::register(result).err();
    if shared::stem(result) == "instrumental" {
        if let Some(mut vocal) = vocals.take() {
            match publish_with(&mut vocal, directory, account, replace, &cookie, &mut ProductionCloudTransport) {
                Ok(()) => {
                    result.vocals_cloud_id = vocal.cloud_id;
                    vocal.upload_warning = shared::register(&vocal).err();
                }
                Err(error) => { vocal.upload_status = "failed_local_preserved".into(); vocal.upload_error = Some(error); }
            }
            library::persist(&vocal)?;
            save_reference(result, directory, account)?;
        }
    }
    Ok(())
}

fn publish_with(result: &mut AccompanimentResult, directory: &Path, account: &str, replace: bool, cookie: &str, transport: &mut impl CloudTransport) -> Result<(), String> {
    if result.cloud_account.as_deref().is_some_and(|owner| owner != account) { result.replace_cloud_id = None; }
    let before = reuse_with(result, directory, account, cookie, transport)?;
    if replace && result.replace_cloud_id.is_none() { result.replace_cloud_id = before.as_ref().and_then(|r| r.cloud_id); }
    if replace && result.replace_cloud_id.is_some() { library::persist(result)?; }
    if !replace {
        if let Some(existing) = before {
            result.cloud_id = existing.cloud_id; result.cloud_account = existing.cloud_account;
            result.upload_status = "uploaded".into(); result.upload_error = None; return Ok(());
        }
    }
    let title = if shared::stem(result) == "vocals" { format!("{}（人声）", result.title) } else { accompaniment_title(&result.title) };
    let new_id = upload_cloud_file_with(Path::new(&result.path), &title,
        &result.artist, &result.album, cookie, transport)?;
    // Verify publication before retiring precisely the previously matched accompaniment.
    if !rows_with(cookie, transport)?.iter().any(|row| id(row) == Some(new_id)) { return Err("新伴奏尚未在云盘确认，旧伴奏保留，请重试上传".into()); }
    result.cloud_id = Some(new_id); result.cloud_account = Some(account.into());
    result.published_md5 = Some(format!("{:x}", md5::Md5::digest(fs::read(&result.path).map_err(|e| e.to_string())?)));
    result.upload_status = "uploaded".into(); result.upload_error = None;
    save_reference(result, directory, account)?;
    if let Some(old) = result.replace_cloud_id.filter(|old| *old != new_id) {
        let response = transport.weapi("/weapi/cloud/del", &json!({"songIds":[old]}), cookie)?;
        if response["code"].as_i64() != Some(200) { return Err("新伴奏已上传，但旧云盘伴奏移除失败；两份均保留".into()); }
        if rows_with(cookie, transport)?.iter().any(|row| id(row) == Some(old)) { return Err("旧伴奏删除尚未确认，请重试同步".into()); }
    }
    result.pending_replace = false; result.replace_cloud_id = None;
    save_reference(result, directory, account)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FixtureCloud { published: bool, deleted: bool, fail_publish: bool, calls: Vec<String> }
    impl CloudTransport for FixtureCloud {
        fn api(&mut self, path: &str, _: &Value, _: &str) -> Result<Value, String> {
            self.calls.push(path.into());
            Ok(match path {
                "/api/cloud/upload/check" => json!({"code":200,"needUpload":false,"songId":99}),
                "/api/upload/cloud/info/v2" => json!({"code":200,"songId":99}),
                "/api/cloud/pub/v2" if self.fail_publish => return Err("fixture publish failure".into()),
                "/api/cloud/pub/v2" => { self.published = true; json!({"code":200}) },
                _ => panic!("Unexpected cloud API"),
            })
        }
        fn weapi(&mut self, path: &str, payload: &Value, _: &str) -> Result<Value, String> {
            self.calls.push(path.into());
            Ok(match path {
                "/weapi/v1/cloud/get" => {
                    let mut data = Vec::new();
                    if !self.deleted { data.push(json!({"songId":42,"songName":"song（伴奏）","artist":"artist","album":"album"})); }
                    if self.published { data.push(json!({"songId":99,"songName":"song（伴奏）","artist":"artist","album":"album"})); }
                    json!({"code":200,"data":data,"hasMore":false})
                }
                "/weapi/nos/token/alloc" => json!({"result":{"objectKey":"object","token":"fixture","resourceId":17}}),
                "/weapi/cloud/del" => {
                    assert!(self.published, "Never delete the old accompaniment before successful publication");
                    assert_eq!(payload["songIds"], json!([42]), "Delete only the uniquely identified old accompaniment");
                    self.deleted = true; json!({"code":200})
                }
                _ => panic!("Unexpected encrypted API"),
            })
        }
        fn lbs(&mut self, _: &str) -> Result<Value, String> { panic!("Fixture already uploaded bytes") }
        fn nos(&mut self, _: &str, _: &str, _: &str, _: &[u8]) -> Result<(), String> { panic!("Fixture already uploaded bytes") }
    }

    #[test]
    fn confirmed_sync_repairs_sidecar_without_upload_or_changing_audio() {
        let directory = std::env::temp_dir().join(format!("rustmusic-sync-{}", rand::random::<u64>()));
        fs::create_dir_all(&directory).unwrap();
        let audio = directory.join("song.wav");
        let mut bytes = vec![0; 1200]; bytes[..4].copy_from_slice(b"RIFF"); bytes[8..12].copy_from_slice(b"WAVE"); bytes[40..44].copy_from_slice(b"data");
        fs::write(&audio, &bytes).unwrap();
        let result = AccompanimentResult { path: audio.to_string_lossy().into_owned(),
            cloud_id:Some(42), cloud_account:Some("current".into()),
            upload_status:"failed_local_preserved".into(), upload_error:Some("old timeout".into()),
            ..Default::default() };
        library::persist(&result).unwrap();
        let mut records = library::list(&directory).unwrap();
        reconcile_local(&mut records, &[json!({"songId":"42"})], "current").unwrap();
        let restarted = library::list(&directory).unwrap();
        assert_eq!(restarted[0].upload_status, "uploaded", "A verified cloud ID must repair the persistent status, not merely hide the warning");
        assert!(restarted[0].upload_error.is_none());
        assert_eq!(fs::read(&audio).unwrap(), bytes, "Repair must not replace or reupload local audio");
        records[0].upload_error = Some("云盘已保存，共享目录暂时无法连接".into());
        reconcile_local(&mut records, &[json!({"songId":42})], "current").unwrap();
        assert!(records[0].upload_error.is_none());
        assert!(records[0].upload_warning.is_some(), "Post-upload warnings remain visible without misreporting a cloud upload failure");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sync_repair_requires_current_account_id_and_no_pending_replacement() {
        let failed = AccompanimentResult { title:"song".into(), artist:"artist".into(), album:"album".into(),
            cloud_id:Some(42),cloud_account:Some("current".into()),
            upload_status:"failed_local_preserved".into(),upload_error:Some("keep error".into()), ..Default::default() };
        let mut foreign = failed.clone(); foreign.cloud_account = Some("other".into());
        let mut missing = failed.clone(); missing.cloud_id = None;
        let mut replacing = failed.clone(); replacing.pending_replace = true;
        let mut deleting = failed.clone(); deleting.replace_cloud_id = Some(41);
        for record in [foreign, missing, replacing, deleting] {
            let mut records = vec![record];
            reconcile_local(&mut records, &[json!({"songId":42,"songName":"song（伴奏）","artist":"artist","album":"album"})], "current").unwrap();
            assert_eq!(records[0].upload_error.as_deref(), Some("keep error"), "Title matches, foreign IDs and old replacement IDs are not proof that this render uploaded");
        }
        let mut records = vec![failed];
        reconcile_local(&mut records, &[json!({"songId":43})], "current").unwrap();
        assert!(records[0].upload_error.is_some(), "An absent cloud ID must retain the real failure");
    }

    #[test]
    fn reuse_skips_upload_and_replacement_retires_only_after_verified_publication() {
        let directory = std::env::temp_dir().join(format!("rustmusic-cloud-{}", rand::random::<u64>()));
        fs::create_dir_all(&directory).unwrap();
        let audio = directory.join("song.wav");
        let mut wav = vec![0; 1200]; wav[..4].copy_from_slice(b"RIFF"); wav[8..12].copy_from_slice(b"WAVE"); wav[40..44].copy_from_slice(b"data");
        fs::write(&audio, wav).unwrap();
        let result = AccompanimentResult { path: audio.to_string_lossy().into_owned(), title:"song".into(), artist:"artist".into(), album:"album".into(), ..Default::default() };
        let mut transport = FixtureCloud { published:false, deleted:false, fail_publish:false, calls:Vec::new() };
        let mut retried = result.clone();
        retried.upload_error = Some("previous timeout".into());
        publish_with(&mut retried, &directory, "account", false, "cookie", &mut transport).unwrap();
        assert!(retried.upload_error.is_none(), "A successfully reused cloud track must not retain the previous upload failure");
        assert!(!transport.calls.iter().any(|path| path.contains("upload") || path.ends_with("/del")),
            "An existing accompaniment must be referenced, not uploaded again");
        let mut replaced = result.clone();
        publish_with(&mut replaced, &directory, "account", true, "cookie", &mut transport).unwrap();
        assert!(transport.deleted && transport.published);
        assert_eq!(replaced.cloud_id, Some(99)); assert!(!replaced.pending_replace);
        let mut failed = FixtureCloud { published:false, deleted:false, fail_publish:true, calls:Vec::new() };
        assert!(publish_with(&mut result.clone(), &directory, "other-account", true, "cookie", &mut failed).is_err());
        assert!(!failed.deleted, "A failed new upload must leave the existing cloud version intact");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn cloud_matching_requires_unique_complete_metadata_and_scoped_identity() {
        let result = AccompanimentResult { title:"song".into(), artist:"artist".into(), album:"album".into(), ..Default::default() };
        let row = json!({"songId":42,"songName":"song（伴奏）","artist":"artist","album":"album"});
        assert_eq!(match_id(&[row.clone()], &result, "a").unwrap(), Some(42));
        assert!(match_id(&[row.clone(),row.clone()], &result, "a").is_err(), "Never silently choose among duplicate performances");
        assert_eq!(match_id(&[json!({"songId":43,"songName":"song","artist":"artist","album":"album"})], &result, "a").unwrap(), None, "Original vocals are not accompaniments");
        let foreign = AccompanimentResult { cloud_id:Some(42),cloud_account:Some("other".into()),title:"different".into(), ..result };
        assert_eq!(match_id(&[row], &foreign, "a").unwrap(), None, "Account changes must not reuse another account's ID");
        assert_eq!(original_title("BATTER UP - UVR HQ3 - Instrumental"), Some("BATTER UP"));
        assert_eq!(original_title("BATTER UP - VST Remix 100 - Instrumental"), None, "A VST render must not be presented as AI");
    }
    #[test]
    #[ignore = "Read-only inspection of current signed-in cloud; no upload or deletion"]
    fn cloud_reuse_live_read_only() {
        let cookie = crate::credentials::get("netease_music_u").expect("Current account login");
        let available = rows(&cookie).expect("Complete cloud listing");
        assert!(available.iter().all(|row| id(row).is_some()));
        let candidates = available.iter().filter(|row| row["songName"].as_str().and_then(original_title).is_some()).count();
        eprintln!("Cloud read-only: {} entries, {} accompaniment name candidates; no writes", available.len(), candidates);
    }
}
