//! One result sidecar per audio path: independent jobs cannot overwrite an index.
use super::{AccompanimentResult, valid_wav};
use std::{collections::HashSet, fs, io::Write, path::Path};

pub(super) fn persist(result: &AccompanimentResult) -> Result<(), String> {
    let audio = Path::new(&result.path);
    if !valid_wav(audio) { return Err("Cannot save an invalid accompaniment".into()); }
    let sidecar = audio.with_extension("wav.result.json");
    let temporary = audio.with_extension(format!("wav.result.{}.partial", rand::random::<u64>()));
    let bytes = serde_json::to_vec(result).map_err(|error| error.to_string())?;
    let saved = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &sidecar)
    })();
    if let Err(error) = saved {
        let _ = fs::remove_file(&temporary);
        return Err(format!("保存伴奏列表失败（本地音频保留）: {error}"));
    }
    Ok(())
}

pub(super) fn list(directory: &Path) -> Result<Vec<AccompanimentResult>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut paths = entries.map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    paths.sort();
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for audio in paths {
        if !audio.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("wav")) || !valid_wav(&audio) { continue; }
        let canonical = fs::canonicalize(&audio).map_err(|error| error.to_string())?;
        let key = canonical.to_string_lossy().into_owned();
        #[cfg(windows)]
        let key = key.to_lowercase();
        if !seen.insert(key) { continue; }
        let known = fs::read(audio.with_extension("wav.result.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<AccompanimentResult>(&bytes).ok())
            .filter(|result| fs::canonicalize(&result.path).ok().as_ref() == Some(&canonical));
        results.push(known.unwrap_or_else(|| AccompanimentResult {
            path: audio.to_string_lossy().into_owned(),
            title: audio.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            artist: String::new(), album: String::new(),
            device: String::new(), model: String::new(),
            upload_status: "local_only".into(), upload_error: None,
            source_kind: String::new(), source_id: String::new(),
            cover: String::new(), duration_ms: 0,
            ..Default::default()
        }));
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let dir=std::env::temp_dir().join(format!("rustmusic-library-{}",rand::random::<u64>()));
        fs::create_dir(&dir).unwrap(); dir
    }
    fn fixture(dir:&Path,name:&str)->AccompanimentResult {
        let audio=dir.join(format!("{name}.wav"));
        let mut wav=vec![0u8;1200];
        wav[..4].copy_from_slice(b"RIFF"); wav[8..12].copy_from_slice(b"WAVE"); wav[40..44].copy_from_slice(b"data");
        fs::write(&audio,wav).unwrap();
        AccompanimentResult { path:audio.to_string_lossy().into_owned(),title:name.into(),
            artist:"real artist".into(),album:"real album".into(),device:"gpu-directml".into(),
            model:super::super::MODEL.into(),upload_status:"failed_local_preserved".into(),
            upload_error:Some("fixture network failure".into()),source_kind:"netease".into(),source_id:"42".into(),
            cover:"https://fixture/real-cover.jpg".into(),duration_ms:234567, ..Default::default() }
    }
    #[test]
    fn restart_reads_real_metadata_and_preserves_local_after_upload_failure() {
        let dir=directory();
        let mut result=fixture(&dir,"song"); persist(&result).unwrap();
        let loaded=list(&dir).unwrap(); assert_eq!(loaded.len(),1);
        assert_eq!(serde_json::to_value(&loaded[0]).unwrap(),serde_json::to_value(&result).unwrap(),
            "A restart must recover real source identity and upload failure, not guess either");
        result.upload_status="uploaded".into(); result.upload_error=None;
        persist(&result).unwrap();
        assert_eq!(list(&dir).unwrap()[0].upload_status,"uploaded","Atomic replacement must update an existing sidecar");
        fs::remove_file(&result.path).unwrap();
        assert!(list(&dir).unwrap().is_empty(),"Deleted files must not remain playable library items");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_jobs_keep_all_paths_and_ignore_partial_sidecars() {
        let dir=directory();
        let jobs:Vec<_>=(0..8).map(|i| {
            let result=fixture(&dir,&format!("song-{i}"));
            std::thread::spawn(move || { persist(&result).unwrap(); persist(&result).unwrap(); })
        }).collect();
        for job in jobs { job.join().unwrap(); }
        fs::write(dir.join("song-0.wav.result.fake.partial"),b"partial").unwrap();
        let loaded=list(&dir).unwrap();
        assert_eq!(loaded.len(),8,"Per-song persistence must not lose concurrent jobs or duplicate repeated results");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_files_have_no_invented_identity_and_invalid_audio_is_excluded() {
        let dir=directory();
        fixture(&dir,"legacy");
        fs::write(dir.join("broken.wav"),b"not a wave").unwrap();
        fs::write(dir.join("legacy.wav.cache.json"),br#"{"sourceId":"not a result"}"#).unwrap();
        let loaded=list(&dir).unwrap(); assert_eq!(loaded.len(),1);
        assert_eq!(loaded[0].title,"legacy");
        assert!(loaded[0].source_kind.is_empty()&&loaded[0].source_id.is_empty()&&loaded[0].model.is_empty(),
            "A filename/cache does not establish the original song, model or account");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn display_suffix_never_overwrites_original_title_and_old_metadata_still_loads() {
        let dir=directory(); let result=fixture(&dir,"original title");
        assert_eq!(super::super::accompaniment_title(&result.title),"original title（伴奏）");
        assert_eq!(super::super::accompaniment_title("original title（伴奏）"),"original title（伴奏）");
        persist(&result).unwrap();
        assert_eq!(list(&dir).unwrap()[0].title,"original title","Only display/upload names get the accompaniment suffix");
        let mut old=serde_json::to_value(result).unwrap();
        old.as_object_mut().unwrap().remove("cover");
        old.as_object_mut().unwrap().remove("durationMs");
        let parsed:AccompanimentResult=serde_json::from_value(old).unwrap();
        assert!(parsed.cover.is_empty()); assert_eq!(parsed.duration_ms,0);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn accompaniment_keeps_provider_specific_lyric_lookup_identity() {
        for (kind,id) in [("qq","qq-mid"),("bilibili","BV-real-id"),("navidrome","server-song-id")] {
            assert_eq!(super::super::accompaniment_lyrics_qid(kind,id).as_deref(),Some(id),
                "The original provider's lyric lookup key must survive playing a local accompaniment");
        }
        for kind in ["netease","kugou","track",""] {
            assert_eq!(super::super::accompaniment_lyrics_qid(kind,"42"),None,
                "Providers using nid, kgid or local track ID must not be relabeled as QQ");
        }
    }
}
