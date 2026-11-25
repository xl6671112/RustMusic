use serde::{Deserialize, Serialize};
use std::{fs, path::{Component, Path, PathBuf}};
use tauri::State;

#[derive(Clone, Deserialize, Serialize)]
pub struct AiModel {
    pub id: String,
    pub package_id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub bytes: u64,
    pub model: String,
    pub architecture: String,
    pub model_sha256: String,
    #[serde(skip)]
    pub directory: PathBuf,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default, alias = "id")]
    package_id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    model: String,
    #[serde(default)]
    architecture: String,
    #[serde(default)]
    edition: String,
    model_sha256: String,
}

pub(crate) fn read_model(directory: &Path, id: String, legacy: bool) -> Result<AiModel, String> {
    let manifest = directory.join(if legacy { "runtime.json" } else { "model.json" });
    let bytes = fs::read(&manifest).map_err(|_| "模型缺少 model.json".to_string())?;
    let marker: Manifest = serde_json::from_slice(bytes.strip_prefix(&[239, 187, 191]).unwrap_or(&bytes))
        .map_err(|_| "模型配置文件无效")?;
    let file = Path::new(&marker.model);
    if file.components().any(|part| !matches!(part, Component::Normal(_)))
        || !file.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("onnx")) {
        return Err("模型文件必须是文件夹内的 ONNX 文件".into());
    }
    let architecture = if !marker.architecture.is_empty() { marker.architecture }
        else { match marker.edition.as_str() {
            "lite" => "mdx-hq3".into(), "pro" => "bs-roformer-resurrection".into(),
            _ => return Err("模型缺少支持的架构标识".into()),
        }};
    if !matches!(architecture.as_str(), "mdx-hq3" | "mdx-karaoke" | "bs-roformer-resurrection")
        || marker.model_sha256.len() != 64
        || !marker.model_sha256.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("模型架构或校验值无效".into());
    }
    let model_directory = if legacy { directory.join("models") } else { directory.to_owned() };
    let metadata = fs::metadata(model_directory.join(file)).map_err(|_| "模型文件未安装完整")?;
    if !metadata.is_file() || metadata.len() == 0 { return Err("模型文件未安装完整".into()); }
    Ok(AiModel { id,
        package_id: if marker.package_id.is_empty() { format!("local:{}", marker.model_sha256.to_lowercase()) } else { marker.package_id },
        version: if marker.version.is_empty() { format!("local-{}", &marker.model_sha256[..12]) } else { marker.version },
        name: if marker.name.is_empty() { marker.model.clone() } else { marker.name },
        description: if marker.description.is_empty() {
            match architecture.as_str() {
                "mdx-hq3" => "偏轻量的伴奏与人声分离模型，适合日常提取。".into(),
                "mdx-karaoke" => "单模型卡拉 OK 分离，模型直接提取伴奏并以残差生成人声，目标是保留伴唱和和声。".into(),
                _ => "侧重细节的伴奏与人声分离模型，计算量相对较大。".into(),
            }
        } else { marker.description },
        bytes: metadata.len(),
        model: marker.model, architecture, model_sha256: marker.model_sha256.to_lowercase(), directory: model_directory })
}

pub(crate) fn discover(root: &Path) -> Vec<AiModel> {
    let mut directories = fs::read_dir(root).into_iter().flatten().filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let number = name.strip_prefix("ai")?.parse::<u32>().ok()?;
            (number > 0 && entry.path().is_dir()).then_some((number, name, entry.path()))
        }).collect::<Vec<_>>();
    directories.sort_by_key(|(number, _, _)| *number);
    let mut models = directories.into_iter().filter_map(|(_, name, directory)| read_model(&directory, name, false).ok()).collect::<Vec<_>>();
    if let Ok(model) = read_model(&root.join("ai"), "legacy".into(), true) { models.push(model); }
    models
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeSettings {
    pub model_id: String,
    pub gpu_percent: u32,
    pub memory_mb: u32,
}

pub(crate) fn settings(conn: &rusqlite::Connection) -> AiRuntimeSettings {
    AiRuntimeSettings {
        model_id: crate::db::get_setting(conn, "ai_model_id").unwrap_or_default(),
        gpu_percent: crate::db::get_setting(conn, "ai_gpu_percent").and_then(|value| value.parse().ok()).unwrap_or(60).clamp(10, 100),
        memory_mb: crate::db::get_setting(conn, "ai_memory_mb").and_then(|value| value.parse().ok()).unwrap_or(0),
    }
}

pub(crate) fn resolve(root: &Path, settings: &AiRuntimeSettings) -> Result<AiModel, String> {
    if let Some(path) = std::env::var_os("RUSTMUSIC_AI_MODEL_DIR") {
        let path = PathBuf::from(path);
        return read_model(path.parent().ok_or("模型目录无效")?, "override".into(), true);
    }
    let models = discover(root);
    if settings.model_id.is_empty() {
        let preferred = models.iter().position(|model| model.architecture == "mdx-hq3").unwrap_or(0);
        models.into_iter().nth(preferred).ok_or_else(|| "请先在设置中下载或安装一个 AI 模型".into())
    } else {
        models.into_iter().find(|model| model.id == settings.model_id)
            .ok_or_else(|| "已选模型不可用，请在设置中重新选择".into())
    }
}

#[tauri::command]
pub async fn list_ai_models() -> Result<Vec<AiModel>, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(discover(exe.parent().ok_or("无法定位程序目录")?))
}

#[tauri::command]
pub async fn get_ai_runtime_settings(state: State<'_, crate::AppState>) -> Result<AiRuntimeSettings, String> {
    let conn = state.db.try_lock_for(std::time::Duration::from_secs(2))
        .ok_or("设置暂时忙碌，请稍后点击刷新重试")?;
    Ok(settings(&conn))
}

#[tauri::command]
pub async fn set_ai_runtime_settings(state: State<'_, crate::AppState>, settings: AiRuntimeSettings) -> Result<(), String> {
    if !(10..=100).contains(&settings.gpu_percent)
        || (settings.memory_mb != 0 && !(512..=131072).contains(&settings.memory_mb)) {
        return Err("GPU 计算比例需为 10–100%，内存上限需为 512–131072 MB 或不限制".into());
    }
    if !settings.model_id.is_empty() {
        let root = std::env::current_exe().map_err(|error| error.to_string())?;
        if !discover(root.parent().ok_or("程序目录无效")?).iter().any(|model| model.id == settings.model_id) {
            return Err("所选模型尚未安装".into());
        }
    }
    let conn = state.db.lock();
    for (key, value) in [("ai_model_id", settings.model_id), ("ai_gpu_percent", settings.gpu_percent.to_string()), ("ai_memory_mb", settings.memory_mb.to_string())] {
        conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, &value]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_defaults_to_balanced_without_overwriting_saved_preferences() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        assert_eq!(settings(&conn).gpu_percent, 60, "New users should start with balanced GPU scheduling");
        conn.execute("INSERT INTO settings VALUES ('ai_gpu_percent','30')", []).unwrap();
        assert_eq!(settings(&conn).gpu_percent, 30, "An existing explicit choice must survive restart");
    }
    #[test]
    fn coexisting_hq3_and_resurrection_resolve_the_explicit_selection_instead_of_the_first_model() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("ai-multiple-models-{}", rand::random::<u64>()));
        fs::create_dir_all(root.join("ai")).unwrap();
        fs::write(root.join("ai/runtime.json"), r#"{"format":"rustmusic-numpy-onnx-v1","packages":["onnxruntime"]}"#).unwrap();
        for (id, package, model, architecture, content) in [
            ("ai12", "uvr-mdx-inst-hq3", "UVR-MDX-NET-Inst_HQ_3.onnx", "mdx-hq3", b"HQ3 model fixture".as_slice()),
            ("ai4", "uvr-mdx-karaoke", "UVR_MDXNET_KARA.onnx", "mdx-karaoke", b"Karaoke model fixture".as_slice()),
            ("ai1", "bs-roformer-resurrection-instrumental", "BS-Roformer-Resurrection-Instrumental.onnx", "bs-roformer-resurrection", b"Resurrection model fixture".as_slice()),
        ] {
            let directory = root.join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(model), content).unwrap();
            fs::write(directory.join("model.json"), serde_json::json!({
                "package_id": package, "version": "1.0.0", "model": model,
                "architecture": architecture, "model_sha256": format!("{:x}", Sha256::digest(content)),
            }).to_string()).unwrap();
        }
        let models = discover(&root);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["ai1", "ai4", "ai12"],
            "The Karaoke model must be independently selectable beside HQ3 and Resurrection");
        assert_eq!(resolve(&root, &AiRuntimeSettings::default()).unwrap().id, "ai12", "HQ3 should be preferred even when its folder number is larger");
        for expected in &models {
            let selected = resolve(&root, &AiRuntimeSettings { model_id: expected.id.clone(), ..Default::default() }).unwrap();
            assert_eq!(selected.directory, root.join(&expected.id),
                "Explicit selection must route inference to the selected folder, not the default folder");
            assert_eq!(selected.architecture, expected.architecture);
            assert_eq!(selected.package_id, expected.package_id);
            assert_eq!(selected.model, expected.model);
            assert_eq!(fs::read(selected.directory.join(&selected.model)).unwrap().len() as u64, selected.bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_folders_sort_numerically_and_reject_escape_or_unsupported_architecture() {
        let root = std::env::temp_dir().join(format!("ai-models-{}", rand::random::<u64>()));
        for (id, model, architecture) in [("ai10","model.onnx","mdx-hq3"),("ai2","model.onnx","mdx-hq3"),("ai3","../escape.onnx","mdx-hq3"),("ai4","model.onnx","unknown")] {
            let folder=root.join(id); fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("model.onnx"), b"fixture").unwrap();
            fs::write(folder.join("model.json"), serde_json::json!({"model":model,"architecture":architecture,"model_sha256":"a".repeat(64)}).to_string()).unwrap();
        }
        assert_eq!(discover(&root).iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["ai2","ai10"]);
        assert!(resolve(&root, &AiRuntimeSettings { model_id:"ai1".into(), ..Default::default() }).is_err(), "A removed selected model must never silently run a different model");
        fs::remove_dir_all(root).unwrap();
    }
}
