use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPackage {
    id: String, name: String, description: String, version: String,
    archive_url: String, #[serde(default)] mirrors: Vec<String>,
    size: u64, #[serde(default)] installed_size: u64,
    sha256: String, model_file: String, model_sha256: String, architecture: String,
}

fn https(raw: &str) -> bool {
    tauri::Url::parse(raw).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some()
        && u.username().is_empty() && u.password().is_none() && u.fragment().is_none())
}

fn hash(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) }

fn model_path(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\\', ':']) && !value.starts_with('/')
        && value.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.ends_with(['.', ' ']))
}

impl ModelPackage {
    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 64 || !self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || self.name.trim().is_empty() || self.name.len() > 160 || self.description.len() > 2000
            || !https(&self.archive_url) || self.mirrors.len() > 8 || self.mirrors.iter().any(|u| !https(u))
            || self.size == 0 || self.size > 8 * 1024 * 1024 * 1024 || self.installed_size > 16 * 1024 * 1024 * 1024
            || !hash(&self.sha256) || !hash(&self.model_sha256)
            || !model_path(&self.model_file) || !self.model_file.to_ascii_lowercase().ends_with(".onnx")
            || !matches!(self.architecture.as_str(), "mdx-hq3" | "mdx-karaoke" | "bs-roformer-resurrection") {
            return Err("模型下载信息不完整，请稍后刷新列表".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn fetch_ai_model_catalog() -> Result<Vec<ModelPackage>, String> {
    tauri::async_runtime::spawn_blocking(catalog).await.map_err(|_| "模型列表请求失败")?
}

fn catalog() -> Result<Vec<ModelPackage>, String> {
    let response = ureq::get(&format!("{}/api/models", crate::updater::WEBSITE))
        .timeout(Duration::from_secs(15)).call().map_err(|_| "暂时无法获取模型列表，请稍后重试")?;
    let mut raw = String::new();
    response.into_reader().take(1024 * 1024 + 1).read_to_string(&mut raw).map_err(|_| "模型列表读取失败")?;
    if raw.len() > 1024 * 1024 { return Err("模型列表过大".into()); }
    #[derive(Deserialize)] struct Catalog { models: Vec<ModelPackage> }
    let result: Catalog = serde_json::from_str(&raw).map_err(|_| "模型列表格式无效")?;
    if result.models.len() > 1000 { return Err("模型列表过大".into()); }
    for entry in &result.models { entry.validate()?; }
    Ok(result.models)
}

fn progress(app: &AppHandle, id: &str, phase: &str, received: u64, total: u64, line: usize) {
    let _ = app.emit("ai-model://progress", serde_json::json!({
        "id":id,"phase":phase,"received":received,"total":total,"line":line,
        "percent":if total > 0 { received.saturating_mul(100).checked_div(total).unwrap_or(0).min(100) } else {0}
    }));
}

#[tauri::command]
pub fn cancel_ai_model_download() { CANCEL.store(true, Ordering::Relaxed); }

#[tauri::command]
pub async fn download_ai_model(app: AppHandle, id: String) -> Result<String, String> {
    if DOWNLOADING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("请等待当前模型下载完成".into());
    }
    CANCEL.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { DOWNLOADING.store(false, Ordering::SeqCst); } }
        let _reset = Reset;
        let package = catalog()?.into_iter().find(|m| m.id == id).ok_or("此模型已下架，请刷新列表")?;
        let root = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("无法定位播放器目录")?.to_owned();
        install_package(&root, &package, |phase, received, total, line| {
            progress(&app, &package.id, phase, received, total, line);
        })
    }).await.map_err(|_| "模型安装任务中断".to_string())?
}

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) { Err("已取消模型下载".into()) } else { Ok(()) }
}

#[tauri::command]
pub async fn import_ai_model(source: String, architecture: String) -> Result<String, String> {
    if DOWNLOADING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("请等待当前模型安装完成".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { DOWNLOADING.store(false, Ordering::SeqCst); } }
        let _reset = Reset;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        import_local(exe.parent().ok_or("无法定位播放器目录")?, Path::new(&source), &architecture)
    }).await.map_err(|_| "模型导入任务中断".to_string())?
}

fn import_local(root: &Path, source: &Path, architecture: &str) -> Result<String, String> {
    let metadata = fs::metadata(source).map_err(|_| "请选择有效的模型文件")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 * 1024 {
        return Err("模型文件为空或超过 8 GB".into());
    }
    let stage = root.join(format!(".ai-import-{:016x}", rand::random::<u64>()));
    fs::create_dir(&stage).map_err(|_| "播放器目录无法写入")?;
    struct Clean(PathBuf);
    impl Drop for Clean { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    let _clean = Clean(stage.clone());
    let output = stage.join("model");
    match source.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "zip" => extract(source, &output, |_, _| Ok(()))?,
        "onnx" => {
            if !matches!(architecture, "mdx-hq3" | "mdx-karaoke" | "bs-roformer-resurrection") {
                return Err("请选择与 ONNX 文件匹配的模型类型".into());
            }
            fs::create_dir(&output).map_err(|e| e.to_string())?;
            fs::copy(source, output.join("model.onnx")).map_err(|e| e.to_string())?;
            let digest = file_hash(&output.join("model.onnx"))?;
            let source_name = source.file_stem().unwrap_or_default().to_string_lossy();
            let (name, description) = if architecture == "mdx-karaoke" {
                ("UVR-MDX-NET Karaoke", "单模型卡拉 OK 分离，模型直接提取伴奏并以残差生成人声，目标是保留伴唱和和声。")
            } else {
                (source_name.as_ref(), "本地导入的模型")
            };
            fs::write(output.join("model.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "name":name, "description":description, "model":"model.onnx", "architecture":architecture,
                "model_sha256":digest
            })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        }
        _ => return Err("请选择模型 ZIP 或 ONNX 文件".into()),
    }
    let model = crate::ai_models::read_model(&output, String::new(), false)?;
    if file_hash(&output.join(&model.model))? != model.model_sha256 {
        return Err("模型文件与 model.json 中的校验值不一致".into());
    }
    let mut index = 1u32;
    while root.join(format!("ai{index}")).exists() { index = index.checked_add(1).ok_or("模型目录数量过多")?; }
    let destination = root.join(format!("ai{index}"));
    fs::rename(output, &destination).map_err(|e| format!("保存模型失败：{e}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

fn install_package(root: &Path, p: &ModelPackage, mut report: impl FnMut(&str, u64, u64, usize)) -> Result<String, String> {
    let stage = root.join(format!(".ai-model-{:016x}", rand::random::<u64>()));
    fs::create_dir(&stage).map_err(|_| "播放器目录无法写入，请将播放器放在可写目录后重试")?;
    // This path was exclusively created under the selected player directory.
    struct Clean(PathBuf);
    impl Drop for Clean { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    let _clean = Clean(stage.clone());
    let archive = stage.join("download.zip");
    let mut downloaded = false;
    let mut last_error = String::new();
    for (line, link) in std::iter::once(&p.archive_url).chain(p.mirrors.iter()).enumerate() {
        cancelled()?;
        report("download", 0, p.size, line + 1);
        match download_file(link, &archive, p, |done| report("download", done, p.size, line + 1)) {
            Ok(()) => { downloaded = true; break; }
            Err(error) => { last_error = error; let _ = fs::remove_file(&archive); }
        }
    }
    if !downloaded { return Err(format!("所有下载线路均失败：{last_error}")); }
    let extracted = stage.join("model");
    report("extract", 0, 0, 0);
    extract(&archive, &extracted, |done, total| {
        report("extract", done, total, 0);
        cancelled()
    })?;
    let model = extracted.join(&p.model_file);
    let actual = file_hash(&model)?;
    if !actual.eq_ignore_ascii_case(&p.model_sha256) { return Err("模型文件校验失败，请重新下载".into()); }
    fs::write(extracted.join("model.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "name":p.name,"description":p.description,"model":p.model_file,"architecture":p.architecture,
        "model_sha256":p.model_sha256.to_ascii_lowercase(),"package_id":p.id,"version":p.version
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    cancelled()?;
    let mut index = 1u32;
    while root.join(format!("ai{index}")).exists() { index = index.checked_add(1).ok_or("模型目录数量过多")?; }
    let destination = root.join(format!("ai{index}"));
    fs::rename(&extracted, &destination).map_err(|e| format!("保存模型失败：{e}"))?;
    report("installed", 1, 1, 0);
    Ok(destination.to_string_lossy().into_owned())
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "模型包中缺少指定模型文件")?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop { let n = file.read(&mut buf).map_err(|e| e.to_string())?; if n == 0 { break; } h.update(&buf[..n]); }
    Ok(hex::encode(h.finalize()))
}

fn download_file(url: &str, path: &Path, p: &ModelPackage, mut on_progress: impl FnMut(u64)) -> Result<(), String> {
    let response = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30)).build().get(url).timeout(Duration::from_secs(3600))
        .call().map_err(|_| "此线路暂时无法连接")?;
    if response.get_url().starts_with("http:") { return Err("下载地址需要 HTTPS".into()); }
    let mut source = response.into_reader();
    let mut dest = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    let mut done = 0u64;
    let mut hash = Sha256::new();
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        cancelled()?;
        let n = source.read(&mut buf).map_err(|_| "此线路下载中断")?;
        if n == 0 { break; }
        done += n as u64;
        if done > p.size { return Err("下载文件大小不符".into()); }
        dest.write_all(&buf[..n]).map_err(|e| format!("保存模型失败：{e}"))?;
        hash.update(&buf[..n]);
        if last.elapsed() > Duration::from_millis(120) { on_progress(done); last = Instant::now(); }
    }
    if done != p.size || !hex::encode(hash.finalize()).eq_ignore_ascii_case(&p.sha256) { return Err("模型压缩包大小或校验值不符".into()); }
    dest.sync_all().map_err(|e| e.to_string())?;
    on_progress(done);
    Ok(())
}

fn extract(path: &Path, dir: &Path, mut on_progress: impl FnMut(u64, u64) -> Result<(), String>) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?).map_err(|_| "模型压缩包不是有效 ZIP")?;
    if zip.len() > 10000 { return Err("模型压缩包文件过多".into()); }
    let mut total = 0u64;
    for i in 0..zip.len() {
        total = total.checked_add(zip.by_index(i).map_err(|e| e.to_string())?.size()).ok_or("模型压缩包过大")?;
    }
    if total > 16 * 1024 * 1024 * 1024 { return Err("模型解压大小超过限制".into()); }
    fs::create_dir(dir).map_err(|e| e.to_string())?;
    let mut done = 0u64;
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().trim_end_matches('/');
        if !model_path(name) || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err("模型 ZIP 含无效路径或链接".into());
        }
        let relative = entry.enclosed_name().ok_or("模型 ZIP 含无效路径")?;
        let target = dir.join(relative);
        if entry.is_dir() { fs::create_dir_all(target).map_err(|e| e.to_string())?; continue; }
        let extension = target.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(), "onnx" | "data" | "bin" | "json" | "yaml" | "yml" | "txt" | "md") { return Err("模型包只能包含模型、权重和说明文件".into()); }
        fs::create_dir_all(target.parent().ok_or("模型文件路径无效")?).map_err(|e| e.to_string())?;
        let mut out = fs::OpenOptions::new().create_new(true).write(true).open(target).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 65536];
        loop {
            if last_progress.elapsed() >= Duration::from_millis(120) {
                on_progress(done, total)?;
                last_progress = Instant::now();
            }
            let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if done > total { return Err("模型解压长度不符".into()); }
        }
    }
    on_progress(done, total)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_import_preserves_existing_models_and_rejects_bad_packages() {
        let root = std::env::temp_dir().join(format!("model-import-{}", rand::random::<u64>()));
        fs::create_dir_all(root.join("ai1")).unwrap();
        fs::write(root.join("ai1/existing.txt"), b"keep").unwrap();
        let source = root.join("custom.onnx");
        fs::write(&source, b"fixture weights").unwrap();
        let imported = import_local(&root, &source, "mdx-hq3").unwrap();
        assert!(Path::new(&imported).ends_with("ai2"), "Import must allocate a new model slot");
        assert_eq!(fs::read(root.join("ai1/existing.txt")).unwrap(), b"keep");
        assert!(import_local(&root, &source, "unsupported").is_err());
        let archive = root.join("model.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        for name in ["model.json", "model.onnx"] {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(&fs::read(Path::new(&imported).join(name)).unwrap()).unwrap();
        }
        zip.finish().unwrap();
        assert!(Path::new(&import_local(&root, &archive, "").unwrap()).ends_with("ai3"));
        fs::write(Path::new(&imported).join("model.onnx"), b"changed").unwrap();
        let broken = root.join("broken.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&broken).unwrap());
        for name in ["model.json", "model.onnx"] {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(&fs::read(Path::new(&imported).join(name)).unwrap()).unwrap();
        }
        zip.finish().unwrap();
        assert!(import_local(&root, &broken, "").is_err(), "A checksum mismatch must never install a model");
        assert!(!root.join("ai4").exists());
        let karaoke = import_local(&root, &source, "mdx-karaoke").unwrap();
        let installed = crate::ai_models::read_model(Path::new(&karaoke), "ai4".into(), false).unwrap();
        assert_eq!(installed.architecture, "mdx-karaoke", "Karaoke must remain a single independently selectable model");
        assert_eq!(installed.name, "UVR-MDX-NET Karaoke");
        assert_eq!(installed.description, "单模型卡拉 OK 分离，模型直接提取伴奏并以残差生成人声，目标是保留伴唱和和声。");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "Downloads a real published model into a temporary isolated directory"]
    fn published_model_download_falls_back_and_installs_real_weights() {
        let id = std::env::var("RUSTMUSIC_MODEL_VERIFY_ID").expect("Set RUSTMUSIC_MODEL_VERIFY_ID to a published small model");
        let mut p = catalog().unwrap().into_iter().find(|p| p.id == id).expect("Model is not published");
        p.mirrors.insert(0, p.archive_url.clone());
        p.archive_url = format!("{}/models/fixture-missing-{}.zip", crate::updater::WEBSITE, rand::random::<u64>());
        let root = std::env::temp_dir().join(format!("rustmusic-model-live-{}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        struct Clean(PathBuf);
        impl Drop for Clean { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _clean = Clean(root.clone());
        CANCEL.store(false, Ordering::Relaxed);
        let mut fallback = false;
        let mut extracted = false;
        let directory = install_package(&root, &p, |phase, done, total, line| {
            fallback |= phase == "download" && line == 2;
            extracted |= phase == "extract" && total > 0 && done == total;
        }).unwrap();
        assert!(fallback && extracted, "A failed source must use the backup and report actual extraction completion");
        assert_eq!(file_hash(&Path::new(&directory).join(&p.model_file)).unwrap(), p.model_sha256.to_lowercase());
        let models = crate::ai_models::discover(&root);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].description, p.description, "Installed models must retain their published description");
        assert!(models[0].bytes > 0);
    }
    #[test]
    fn model_archives_cannot_escape_or_install_executables() {
        let dir = std::env::temp_dir().join(format!("model-zip-{}", rand::random::<u64>()));
        fs::create_dir(&dir).unwrap();
        for (i, entry) in ["../escape.onnx", "C:/escape.onnx", "file.onnx:stream", "helper.exe", "model.onnx"].iter().enumerate() {
            let archive = dir.join(format!("{i}.zip"));
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            zip.start_file(*entry, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"fixture").unwrap(); zip.finish().unwrap();
            assert_eq!(extract(&archive, &dir.join(format!("out{i}")), |_, _| Ok(())).is_ok(), *entry == "model.onnx");
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
