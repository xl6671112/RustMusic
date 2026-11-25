//! 官网 Release 自动更新。
//!
//! 流程：检查最新 release（按当前平台挑选附件：Windows 找 `*setup*.exe` 安装包，
//! Linux 找 AppImage）→ 前端弹窗展示 markdown 更新说明 → 用户确认后下载安装包
//! （带进度事件，校验大小与 SHA-256）→ 安装并自动重启：
//! - Windows：退出后由分离的 PowerShell 助手静默运行安装包（显式传
//!   `/DIR=<当前安装目录>`，安装位置不变），装完自动重启并清理临时文件；
//! - Linux（AppImage 运行）：下载文件落在当前 .AppImage 同目录，chmod +x 后
//!   原子 rename 覆盖运行中的 AppImage（rename 只替换目录项，旧进程仍持有旧
//!   inode），由分离的 sh 助手等旧进程退出后启动新版本；
//! - Linux（deb 安装）或 release 无本平台附件：应用内安装不可用，
//!   `can_install=false`，前端引导前往 官网 发布页手动下载。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const WEBSITE: &str = "https://music.xn--hlr32k.com";
const UA: &str = "RustMusic-Updater";
/// 下载整体超时兜底：安装包一般 10~20 MB，弱网也足够；卡死连接最终会在此报错
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

pub fn cancel_download() {
    DOWNLOAD_CANCEL.store(true, Ordering::Relaxed);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版本号（去掉 tag 前缀 v，如 "0.1.2"）
    pub version: String,
    /// release notes（markdown 原文）
    pub notes: String,
    /// 本平台安装包附件；release 没有本平台附件时为 None
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: u64,
    /// 附件哈希（官网 返回 "sha256:<hex>"；缺省 = 无法校验，仅剩大小检查）
    pub asset_digest: Option<String>,
    /// 签名附件（<安装包>.sig，ed25519）；缺失 = 更新被拒绝（见 download），
    /// 仅当发布流水线签名缺失时才会发生
    pub asset_sig_url: Option<String>,
    #[serde(default)]
    pub asset_mirrors: Vec<String>,
    #[serde(default)]
    pub signature_mirrors: Vec<String>,
    pub published_at: String,
    /// 当前安装方式能否应用内自动更新（false → 前端引导前往发布页）
    pub can_install: bool,
}

/// "v0.1.2" / "0.1.2-beta.1" → [0, 1, 2]，无法解析的段按 0 处理
fn version_tuple(v: &str) -> Vec<u64> {
    let v = v.trim().trim_start_matches(|c| c == 'v' || c == 'V');
    let v = v.split(['-', '+']).next().unwrap_or(v);
    v.split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_tuple(latest), version_tuple(current));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 从 release 附件里挑 Windows 安装包：优先 *setup*.exe（Inno 安装包），其次任意 .exe
#[cfg(all(windows, test))]
fn pick_setup_asset(assets: &[serde_json::Value]) -> Option<(String, String, u64, Option<String>)> {
    let mut fallback = None;
    for a in assets {
        let (Some(name), Some(url)) = (a["name"].as_str(), a["browser_download_url"].as_str())
        else {
            continue;
        };
        let lower = name.to_lowercase();
        if !lower.ends_with(".exe") {
            continue;
        }
        let item = (
            name.to_string(),
            url.to_string(),
            a["size"].as_u64().unwrap_or(0),
            a["digest"].as_str().map(|s| s.to_string()),
        );
        if lower.contains("setup") {
            return Some(item);
        }
        fallback.get_or_insert(item);
    }
    fallback
}

/// 从 release 附件里挑 Linux AppImage：优先匹配当前架构
///（deb 命名用 amd64/arm64，Rust 的 ARCH 是 x86_64/aarch64，两种都认）
#[cfg(all(target_os = "linux", test))]
fn pick_appimage_asset(
    assets: &[serde_json::Value],
) -> Option<(String, String, u64, Option<String>)> {
    let aliases: &[&str] = match std::env::consts::ARCH {
        "x86_64" => &["x86_64", "amd64"],
        "aarch64" => &["aarch64", "arm64"],
        other => &[other],
    };
    let mut fallback = None;
    for a in assets {
        let (Some(name), Some(url)) = (a["name"].as_str(), a["browser_download_url"].as_str())
        else {
            continue;
        };
        let lower = name.to_lowercase();
        if !lower.ends_with(".appimage") {
            continue;
        }
        let item = (
            name.to_string(),
            url.to_string(),
            a["size"].as_u64().unwrap_or(0),
            a["digest"].as_str().map(|s| s.to_string()),
        );
        if aliases.iter().any(|s| lower.contains(s)) {
            return Some(item);
        }
        fallback.get_or_insert(item);
    }
    fallback
}

/// 当前进程是否以 AppImage 方式运行（AppImage 运行时会注入 APPIMAGE 环境变量，
/// 指向 .AppImage 文件自身；deb/apt 等系统包安装时没有该变量）
#[cfg(target_os = "linux")]
fn running_appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 当前安装方式是否支持应用内自动更新
#[cfg(windows)]
fn can_install_in_app() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn can_install_in_app() -> bool {
    running_appimage().is_some()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn can_install_in_app() -> bool {
    false
}

/// 官网 访问走系统代理（环境变量）：无代理网络下直连 官网 会被重置/极慢，
/// 而浏览器等遵循系统代理的应用速度正常。ureq 不读系统/环境代理，需显式传入；
/// 未设置代理或代理无效时回退直连。
fn website_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new();
    if let Some(p) = crate::qq::system_proxy() {
        builder = builder.proxy(p);
    }
    builder.build()
}

pub fn start_presence(installation: Option<String>) {
    let _ = std::thread::Builder::new().name("website-presence".into()).spawn(move || {
        let persistent = installation.is_some();
        let id = installation.unwrap_or_else(|| hex::encode(rand::random::<[u8; 16]>()));
        let body = serde_json::json!({ "id": id, "persistent": persistent }).to_string();
        let url = format!("{WEBSITE}/api/presence");
        let agent = website_agent();
        loop {
            let _ = agent.post(&url)
                .set("Content-Type", "application/json")
                .timeout(Duration::from_secs(8))
                .send_string(&body);
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

/// 查询 官网 最新 release；有更新返回安装包信息，已是最新返回 None
pub fn fetch_latest(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let response = website_agent().get(&format!("{WEBSITE}/api/update?platform={platform}"))
        .set("User-Agent", UA).timeout(Duration::from_secs(12)).call();
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(_) => return Err("暂时无法连接更新服务，请稍后重试".into()),
    };
    let mut info: UpdateInfo = response.into_json().map_err(|_| "更新信息暂时不可用")?;
    if !is_newer(&info.version, current_version) { return Ok(None); }
    for url in [&info.asset_url, &info.asset_sig_url].into_iter().flatten()
        .chain(info.asset_mirrors.iter()).chain(info.signature_mirrors.iter()) {
        if !valid_download_url(url) { return Err("更新下载地址需要有效的 HTTPS 链接".into()); }
    }
    if info.asset_mirrors.len() > 8 || info.signature_mirrors.len() > 8 { return Err("更新备用地址过多".into()); }
    info.can_install = info.asset_url.is_some() && can_install_in_app();
    Ok(Some(info))
}

#[tauri::command]
pub fn fetch_lyrics_styles() -> Result<serde_json::Value, String> {
    let response = website_agent().get(&format!("{WEBSITE}/api/lyrics-styles"))
        .timeout(Duration::from_secs(12)).call().map_err(|_| "暂时无法获取歌词风格，请稍后重试")?;
    let mut body = String::new();
    response.into_reader().take(262145).read_to_string(&mut body).map_err(|_| "歌词风格读取失败")?;
    if body.len() > 262144 { return Err("歌词风格内容过大".into()); }
    serde_json::from_str(&body).map_err(|_| "歌词风格格式无效".into())
}

/// 下载目标目录：AppImage 运行时必须与当前 .AppImage 同目录——原地替换依赖
/// 同一文件系统内的原子 rename，跨文件系统（如 /tmp）会 EXDEV 失败；其余用系统临时目录
fn download_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(dir) = running_appimage().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        return dir;
    }
    std::env::temp_dir()
}

/// 下载安装包到下载目录，期间通过 `update://progress` 事件上报进度。
/// 更新包 ed25519 验签公钥（hex）。私钥由发布方离线保管
///（installer/signing.key，不入库），发布流水线对安装包签名并随附件上传
///（<安装包名>.sig）。公钥内置使更新校验不依赖 官网 的可信度：
/// 发布账号被盗也只能推送会被验签拒绝的文件
const UPDATE_PUBKEY: &str = "18a4f79c46c309b68d1b4c59b1b0e7676ebbb33cccf14e947f071320b0bfa2ea";

/// 校验下载文件的 ed25519 签名（sig 为 64 字节签名 hex）
fn verify_signature(file: &std::path::Path, sig_hex: &str, pubkey_hex: &str) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let mut pk = [0u8; 32];
    hex::decode_to_slice(pubkey_hex, &mut pk).map_err(|_| {
        crate::i18n::pick("内置公钥格式错误", "Invalid built-in public key format").to_string()
    })?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| {
        crate::i18n::pick("内置公钥无效", "Invalid built-in public key").to_string()
    })?;
    let sig_bytes = hex::decode(sig_hex.trim())
        .map_err(|_| crate::i18n::pick("签名格式错误", "Invalid signature format").to_string())?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|_| crate::i18n::pick("签名格式错误", "Invalid signature format").to_string())?;
    let data = std::fs::read(file).map_err(|e| {
        crate::i18n::pick(
            format!("读取安装包失败: {e}"),
            format!("Failed to read installer package: {e}"),
        )
    })?;
    vk.verify(&data, &sig).map_err(|_| {
        crate::i18n::pick(
            "更新包签名校验失败，已删除下载文件",
            "Update signature verification failed; downloaded file deleted",
        )
        .to_string()
    })
}

/// 返回下载文件的完整路径。校验链：大小一致 → SHA-256（官网 附件
/// digest，形如 "sha256:<hex>"，防传输损坏）→ ed25519 签名（公钥内置，
/// 防发布源被冒充）——全部通过才允许进入静默安装，任一不符即删除下载文件
pub fn download(
    app: &AppHandle,
    url: &str,
    name: &str,
    expected_size: u64,
    expected_digest: Option<&str>,
    sig_url: Option<&str>,
    mirrors: &[String],
    signature_mirrors: &[String],
) -> Result<PathBuf, String> {
    DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);
    let signatures = sig_url.into_iter().chain(signature_mirrors.iter().map(String::as_str)).collect::<Vec<_>>();
    let urls = std::iter::once(url).chain(mirrors.iter().map(String::as_str)).collect::<Vec<_>>();
    if urls.len() > 9 || signatures.len() > 9 || signatures.is_empty()
        || urls.iter().chain(signatures.iter()).any(|u| !valid_download_url(u)) {
        return Err("更新地址或签名信息无效".into());
    }
    let mut error = String::new();
    for (line, source) in urls.iter().enumerate() {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) { return Err("已取消下载".into()); }
        let _ = app.emit("update://source", serde_json::json!({"line":line + 1,"total":urls.len()}));
        match download_one(app, source, name, expected_size, expected_digest, &signatures) {
            Ok(path) => {
                if name.to_ascii_lowercase().ends_with(".zip") {
                    let result = unpack_update(&path);
                    let _ = std::fs::remove_file(&path);
                    return result;
                }
                return Ok(path);
            }
            Err(e) => error = e,
        }
    }
    Err(format!("所有下载线路均失败：{error}"))
}

fn valid_download_url(raw: &str) -> bool {
    tauri::Url::parse(raw).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some()
        && u.username().is_empty() && u.password().is_none() && u.fragment().is_none())
}

fn download_one(
    app: &AppHandle, url: &str, name: &str, expected_size: u64,
    expected_digest: Option<&str>, signature_urls: &[&str],
) -> Result<PathBuf, String> {
    use sha2::Digest as _;
    // 附件名固定为 RustMusic_*-setup.exe，仅允许常规文件名字符，避免拼进脚本出问题
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '(' | ')'))
        .collect();
    if safe_name.is_empty() {
        return Err(crate::i18n::pick(
            "安装包文件名无效",
            "Invalid installer filename",
        )
        .into());
    }
    // 临时文件名带进程号：固定可预测的路径可能被其它用户预创建/替换
    //（SHA-256 校验是第二道防线，不能当第一道）
    let path = download_dir().join(format!("{}-{:016x}-{safe_name}", std::process::id(), rand::random::<u64>()));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { if !self.0.as_os_str().is_empty() { let _ = std::fs::remove_file(&self.0); } } }
    let mut cleanup = Cleanup(path.clone());

    let resp = website_agent()
        .get(url)
        .set("User-Agent", UA)
        .timeout(DOWNLOAD_TIMEOUT)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => crate::i18n::pick(
                format!("下载失败（HTTP {code}）"),
                format!("Download failed (HTTP {code})"),
            ),
            other => crate::i18n::pick(
                format!("下载失败：{other}"),
                format!("Download failed: {other}"),
            ),
        })?;
    let total = if expected_size > 0 { expected_size } else { resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(expected_size) };

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&path).map_err(|e| {
        crate::i18n::pick(
            format!("无法写入下载目录：{e}"),
            format!("Cannot write to download directory: {e}"),
        )
    })?;

    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut hasher = sha2::Sha256::new();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(crate::i18n::pick("已取消下载", "Download canceled").into());
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                hasher.update(&buf[..n]);
                file.write_all(&buf[..n]).map_err(|e| {
                    crate::i18n::pick(
                        format!("写入安装包失败：{e}"),
                        format!("Failed to write installer: {e}"),
                    )
                })?;
                received += n as u64;
                if total > 0 && received > total { return Err("更新包大小超过发布信息".into()); }
                if last_emit.elapsed() >= Duration::from_millis(120) {
                    last_emit = Instant::now();
                    let _ = app.emit(
                        "update://progress",
                        serde_json::json!({ "received": received, "total": total }),
                    );
                }
            }
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(crate::i18n::pick(
                    format!("下载中断：{e}"),
                    format!("Download interrupted: {e}"),
                ));
            }
        }
    }
    file.flush().map_err(|e| {
        crate::i18n::pick(
            format!("写入安装包失败：{e}"),
            format!("Failed to write installer: {e}"),
        )
    })?;
    drop(file);

    if total > 0 && received != total {
        let _ = std::fs::remove_file(&path);
        return Err(crate::i18n::pick("下载不完整，请重试", "Incomplete download, please retry").into());
    }
    if let Some(d) = expected_digest {
        let expected = d.trim().to_lowercase();
        let expected = expected.strip_prefix("sha256:").unwrap_or(&expected);
        let actual = hex::encode(hasher.finalize());
        if !expected.is_empty() && actual != expected {
            let _ = std::fs::remove_file(&path);
            return Err(crate::i18n::pick(
                "安装包校验失败（SHA-256 不符），已删除下载文件",
                "Package verification failed (SHA-256 mismatch); file deleted",
            )
            .into());
        }
    }
    // 签名校验：正常发布必有 <安装包>.sig 附件（build.ps1 自动签名）；
    // 缺失视为发布异常，拒绝安装（fail-closed）
    let mut signed = false;
    for u in signature_urls {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) { return Err("已取消下载".into()); }
        let result = (|| -> Result<(), String> {
            let response = website_agent()
                .get(u)
                .set("User-Agent", UA)
                .timeout(Duration::from_secs(20))
                .call()
                .map_err(|e| {
                    crate::i18n::pick(
                        format!("下载更新包签名失败：{e}"),
                        format!("Failed to download update signature: {e}"),
                    )
                })?;
            let mut sig = String::new();
            response.into_reader().take(1025).read_to_string(&mut sig).map_err(|_| "读取更新签名失败")?;
            verify_signature(&path, &sig, UPDATE_PUBKEY)
        })();
        if result.is_ok() { signed = true; break; }
    }
    if !signed { return Err("更新包签名校验失败，请刷新后重试".into()); }
    cleanup.0 = PathBuf::new();
    Ok(path)
}

/// 只有通过外层大小、哈希、签名校验的 ZIP 才会进入此处。
fn unpack_update(path: &Path) -> Result<PathBuf, String> {
    let dir = path.with_extension("unpacked");
    if dir.exists() { return Err("更新解压目录已存在，请重新启动播放器后重试".into()); }
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("ZIP 文件无效：{e}"))?;
        if zip.len() > 20000 { return Err("ZIP 文件数量过多".into()); }
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let relative = entry.enclosed_name().ok_or("ZIP 包含无效路径")?;
            if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
                return Err("ZIP 不支持符号链接".into());
            }
            total = total.checked_add(entry.size()).ok_or("ZIP 文件过大")?;
            if total > 8 * 1024 * 1024 * 1024 { return Err("ZIP 解压大小超过限制".into()); }
            let target = dir.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else {
                std::fs::create_dir_all(target.parent().ok_or("ZIP 路径无效")?).map_err(|e| e.to_string())?;
                let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
        }
        let files: Vec<_> = walkdir::WalkDir::new(&dir).into_iter().collect::<Result<Vec<_>,_>>()
            .map_err(|e| e.to_string())?.into_iter().filter(|e| e.file_type().is_file()).collect();
        let setups: Vec<_> = files.iter().filter(|e| {
            let n=e.file_name().to_string_lossy().to_ascii_lowercase();
            n.ends_with(".exe") && n.contains("setup")
        }).collect();
        if setups.len() == 1 { return Ok(setups[0].path().to_path_buf()); }
        if !setups.is_empty() { return Err("ZIP 包含多个安装程序，请保留一个".into()); }
        let players: Vec<_> = files.iter().filter(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case("rustmusic.exe")).collect();
        if players.len() == 1 { return Ok(players[0].path().parent().unwrap().to_path_buf()); }
        Err("ZIP 中需要一个 setup.exe 安装程序或包含 rustmusic.exe 的完整目录".into())
    })();
    if result.is_err() {
        // dir 由下载临时目录内的文件派生，并由本次调用独占创建。
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

#[cfg(windows)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 生成 PowerShell 助手脚本：等待播放器退出、安装完成后再启动新版本。
#[cfg(windows)]
fn build_update_script(setup: &str, dir: &str, exe: &str, pid: u32) -> String {
    let setup_q = ps_quote(setup);
    let dir_q = ps_quote(dir);
    let exe_q = ps_quote(exe);

    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         Start-Sleep -Seconds 2\n\
         $setup = {setup_q}\n\
         $dir = {dir_q}\n\
         $exe = {exe_q}\n\
         Wait-Process -Id {pid} -ErrorAction SilentlyContinue\n\
         Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES',('/DIR=\"' + $dir + '\"')) -Wait\n\
         Start-Sleep -Milliseconds 500\n\
         Start-Process -FilePath $exe\n\
         Start-Sleep -Seconds 2\n\
         Remove-Item -LiteralPath $setup -Force\n\
         Remove-Item -LiteralPath $PSCommandPath -Force\n",
        pid = pid,
    )
}

#[cfg(windows)]
fn build_executable_update_script(source: &Path, exe: &Path, pid: u32) -> String {
    let source = ps_quote(&source.to_string_lossy());
    let exe = ps_quote(&exe.to_string_lossy());
    format!("$ErrorActionPreference = 'Stop'\n\
        $source = {source}\n$exe = {exe}\n\
        $backup = $exe + '.update-backup'\n\
        Wait-Process -Id {pid} -ErrorAction SilentlyContinue\n\
        try {{\n\
          $probe = $exe + '.update-write-test'\n\
          [IO.File]::Open($probe, [IO.FileMode]::CreateNew).Dispose()\n\
          Remove-Item -LiteralPath $probe\n\
        }} catch {{\n\
          if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {{\n\
            try {{ Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('\"' + $PSCommandPath + '\"')) }}\n\
            catch {{ Start-Process -FilePath $exe }}\n\
            exit\n\
          }}\n\
          $_ | Out-File -LiteralPath ($PSCommandPath + '.error.txt')\n\
          Start-Process -FilePath $exe\n\
          exit 1\n\
        }}\n\
        try {{\n\
          Copy-Item -LiteralPath $exe -Destination $backup -Force\n\
          Copy-Item -LiteralPath $source -Destination $exe -Force\n\
        }} catch {{\n\
          if (Test-Path -LiteralPath $backup) {{ Copy-Item -LiteralPath $backup -Destination $exe -Force }}\n\
          $_ | Out-File -LiteralPath ($PSCommandPath + '.error.txt')\n\
        }}\n\
        Start-Process -FilePath $exe\n\
        Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue\n\
        Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\n")
}

/// 安装并重启：
/// 1. 写出 PowerShell 助手脚本（UTF-8 BOM，中文路径可安全表示）并分离启动；
/// 2. 助手静默运行安装包，`/DIR` 显式指定为当前安装目录 → 位置不变；
/// 3. 安装进程结束后重启应用，最后清理临时文件。用户取消 UAC 时也会重启旧版本。
#[cfg(windows)]
pub fn install_and_restart(app: &AppHandle, setup: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| {
        crate::i18n::pick(
            format!("获取程序路径失败：{e}"),
            format!("Failed to get executable path: {e}"),
        )
    })?;
    let dir = exe.parent().ok_or_else(|| {
        crate::i18n::pick("获取安装目录失败", "Failed to get install directory").to_string()
    })?;
    if !setup.is_file() && !setup.join("rustmusic.exe").is_file() {
        return Err(crate::i18n::pick(
            "安装包不存在，请重新下载",
            "Installer file not found; please download again",
        )
        .into());
    }

    let script = if setup.is_dir() {
        format!("$ErrorActionPreference = 'Stop'\n\
            trap {{ Start-Process -FilePath {exe}; exit 1 }}\n\
            Wait-Process -Id {pid} -ErrorAction SilentlyContinue\n\
            Start-Sleep -Milliseconds 500\n\
            try {{\n\
              $probe = Join-Path {dest} 'rustmusic-update-write-test-{pid}.tmp'\n\
              [IO.File]::Open($probe, [IO.FileMode]::CreateNew).Dispose()\n\
              Remove-Item -LiteralPath $probe\n\
            }} catch {{\n\
              if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {{\n\
                Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('\"' + $PSCommandPath + '\"'))\n\
                exit\n\
              }}\n\
              throw\n\
            }}\n\
            try {{ Get-ChildItem -LiteralPath {source} -Force | Copy-Item -Destination {dest} -Recurse -Force }}\n\
            finally {{ Start-Process -FilePath {exe} }}\n",
            pid=std::process::id(),source=ps_quote(&setup.to_string_lossy()),
            dest=ps_quote(&dir.to_string_lossy()),exe=ps_quote(&exe.to_string_lossy()))
    } else if setup.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
        let name = s.to_ascii_lowercase();
        name.ends_with(".exe") && !name.contains("setup") && !name.contains("install")
    }) {
        build_executable_update_script(setup, &exe, std::process::id())
    } else { build_update_script(
        &setup.to_string_lossy(),
        &dir.to_string_lossy(),
        &exe.to_string_lossy(),
        std::process::id(),
    ) };

    let script_path =
        std::env::temp_dir().join(format!("rustmusic-update-{}.ps1", std::process::id()));
    std::fs::write(&script_path, format!("\u{feff}{script}")).map_err(|e| {
        crate::i18n::pick(
            format!("写入更新脚本失败：{e}"),
            format!("Failed to write update script: {e}"),
        )
    })?;

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if let Err(e) = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&script_path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        let _ = std::fs::remove_file(&script_path);
        return Err(crate::i18n::pick(
            format!("启动更新程序失败：{e}"),
            format!("Failed to launch updater: {e}"),
        ));
    }

    // 助手已分离接管后续流程，稍后退出本进程（给前端留出展示状态的时间）
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        handle.exit(0);
    });
    Ok(())
}

/// Linux（AppImage 运行）：原地替换更新。下载文件与当前 .AppImage 同目录，
/// chmod +x 后原子 rename 覆盖运行中的 AppImage（rename 只替换目录项，旧进程
/// 仍持有旧 inode，运行不受影响），再由分离的 sh 助手等本进程退出后启动新版本。
/// 启动新版本前清掉 AppImage 运行时注入的环境变量（APPDIR/LD_LIBRARY_PATH 等
/// 指向旧挂载点，会随旧进程退出而失效）。
/// deb 等系统包安装方式需要 root 权限装包，应用内自动更新不可用。
#[cfg(target_os = "linux")]
pub fn install_and_restart(app: &AppHandle, setup: &Path) -> Result<(), String> {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};

    let Some(appimage) = running_appimage() else {
        return Err(crate::i18n::pick(
            "当前安装方式（deb）不支持应用内自动更新，请到 官网 发布页下载新版本",
            "In-app updates are not supported for .deb packages; please download the new release from 官网",
        )
        .into());
    };
    if !setup.is_file() {
        return Err(crate::i18n::pick(
            "安装包不存在，请重新下载",
            "Installer file not found; please download again",
        )
        .into());
    }
    std::fs::set_permissions(setup, std::fs::Permissions::from_mode(0o755)).map_err(|e| {
        crate::i18n::pick(
            format!("设置安装包执行权限失败：{e}"),
            format!("Failed to set installer permissions: {e}"),
        )
    })?;
    std::fs::rename(setup, &appimage).map_err(|e| {
        crate::i18n::pick(
            format!("替换 AppImage 失败（所在目录可能不可写）：{e}"),
            format!("Failed to replace AppImage (directory may be read-only): {e}"),
        )
    })?;

    // 分离助手：独立进程组（不随终端 SIGHUP 退出），等旧进程结束后 exec 新版本，
    // 避免新旧实例短暂并行争抢数据库/音频设备
    let helper = format!(
        "while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; exec \"$1\"",
        pid = std::process::id()
    );
    let dir = appimage.parent().map(|p| p.to_path_buf());
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c")
        .arg(&helper)
        .arg(&appimage) // $0
        .arg(&appimage) // $1，exec 的目标
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .env_remove("APPDIR")
        .env_remove("OWD")
        .env_remove("LD_LIBRARY_PATH");
    if let Some(d) = &dir {
        cmd.current_dir(d);
    }
    if let Err(e) = cmd.spawn() {
        // 磁盘上已是新版本，只是没能自动拉起：提示手动重启即可
        return Err(crate::i18n::pick(
            format!("更新已写入，自动重启失败，请手动重新启动应用：{e}"),
            format!("Update written, but auto-restart failed; please restart the app manually: {e}"),
        ));
    }

    // 助手已分离接管重启，稍后退出本进程（给前端留出展示状态的时间）
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        handle.exit(0);
    });
    Ok(())
}

/// 其它平台（如 macOS）：应用内自动安装不可用，前端引导前往发布页
#[cfg(not(any(windows, target_os = "linux")))]
pub fn install_and_restart(_app: &AppHandle, _setup: &Path) -> Result<(), String> {
    Err(crate::i18n::pick(
        "当前平台暂不支持应用内自动安装，请到 官网 发布页下载新版本",
        "In-app updates are not supported on this platform; please download from 官网 releases",
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_update_selects_setup_and_rejects_escape() {
        use zip::write::SimpleFileOptions;
        let root = std::env::temp_dir().join(format!("rustmusic-ziptest-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, entry, expected) in [
            ("setup.zip", "release/RustMusic-setup.exe", true),
            ("portable.zip", "release/rustmusic.exe", true),
            ("escape.zip", "../outside.exe", false),
            ("empty.zip", "readme.txt", false),
        ] {
            let path = root.join(name);
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            writer.start_file(entry, SimpleFileOptions::default()).unwrap();
            writer.write_all(b"test package").unwrap();
            writer.finish().unwrap();
            let result = unpack_update(&path);
            assert_eq!(result.is_ok(), expected, "{entry}: {result:?}");
        }
        assert!(!root.join("outside.exe").exists(), "更新包不能越出解压目录");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_compare() {
        assert!(is_newer("0.1.2", "0.1.1"));
        assert!(is_newer("v0.2.0", "0.1.1"));
        assert!(is_newer("0.2", "0.1.9"));
        assert!(is_newer("0.1.2.0", "0.1.1"));
        assert!(!is_newer("0.1.1", "0.1.1"));
        assert!(!is_newer("v0.1.1", "0.1.1"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert!(!is_newer("0.1.1-beta.1", "0.1.1"));
    }

    #[test]
    #[cfg(windows)]
    fn executable_updates_wait_and_keep_a_rollback_copy() {
        let script = build_executable_update_script(Path::new(r"C:\temp\播放器.exe"), Path::new(r"C:\应用\rustmusic.exe"), 123);
        assert!(script.contains("Wait-Process -Id 123"), "Windows must release the running executable before replacement");
        assert!(script.contains(".update-backup"), "A failed replacement must leave the old executable recoverable");
        assert!(script.contains("Copy-Item -LiteralPath $backup -Destination $exe"), "Replacement failures restore the previous binary");
        assert!(!script.contains("/VERYSILENT"), "A plain application executable must not be treated as an installer");
        let dump = std::env::temp_dir().join("rustmusic-executable-update-script-test.ps1");
        std::fs::write(dump, format!("\u{feff}{script}")).unwrap();
    }

    #[test]
    fn version_tuple_parses() {
        assert_eq!(version_tuple("v0.1.2"), vec![0, 1, 2]);
        assert_eq!(version_tuple("0.1.2-beta.1"), vec![0, 1, 2]);
        assert_eq!(version_tuple(" 1.2 "), vec![1, 2]);
    }

    #[test]
    fn signature_roundtrip_and_tamper() {
        use ed25519_dalek::{Signer, SigningKey};
        let dir = std::env::temp_dir().join(format!("rustmusic-sigtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("asset.bin");
        let payload = b"rustmusic update payload";
        std::fs::write(&file, payload).unwrap();
        let sk = SigningKey::from_bytes(&[0x42u8; 32]);
        let sig = hex::encode(sk.sign(payload).to_bytes());
        let pk = hex::encode(sk.verifying_key().to_bytes());
        assert!(verify_signature(&file, &sig, &pk).is_ok());
        // 内容篡改后必须失败
        std::fs::write(&file, b"tampered payload").unwrap();
        assert!(verify_signature(&file, &sig, &pk).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AppImage 附件挑选：跳过非 AppImage，优先命中当前架构（amd64/x86_64、arm64/aarch64 别名互认）
    #[test]
    #[cfg(target_os = "linux")]
    fn appimage_pick_prefers_current_arch() {
        use serde_json::json;
        let assets = vec![
            json!({"name": "RustMusic_0.1.2_arm64.AppImage", "size": 1,
                   "browser_download_url": "https://example.com/arm64.AppImage"}),
            json!({"name": "RustMusic_0.1.2_amd64.AppImage", "size": 2,
                   "browser_download_url": "https://example.com/amd64.AppImage"}),
            json!({"name": "RustMusic_0.1.2_amd64.deb", "size": 3,
                   "browser_download_url": "https://example.com/amd64.deb"}),
        ];
        // 期望值随构建架构变化：arm64 runner 上应命中 arm64 附件
        let (want_name, want_size) = match std::env::consts::ARCH {
            "aarch64" => ("arm64.AppImage", 1),
            _ => ("amd64.AppImage", 2),
        };
        let (name, url, size, _) = pick_appimage_asset(&assets).expect("应选中 AppImage");
        assert!(name.ends_with(want_name), "选中了 {name}，期望 {want_name}");
        assert_eq!(size, want_size);
        assert!(url.ends_with(".AppImage"));

        // 当前架构的附件缺席时回退到任意 AppImage
        let only_arm = vec![assets[0].clone()];
        let (name, _, _, _) = pick_appimage_asset(&only_arm).expect("应回退到 arm64 附件");
        assert!(name.contains("arm64"));

        assert!(pick_appimage_asset(&[assets[2].clone()]).is_none());
    }

    /// Windows 附件挑选：优先 *setup*.exe，忽略 .msi 等其它格式
    #[test]
    #[cfg(windows)]
    fn setup_pick_prefers_setup_exe() {
        use serde_json::json;
        let assets = vec![
            json!({"name": "RustMusic_0.1.2_x64_en-US.msi", "size": 3,
                   "browser_download_url": "https://example.com/a.msi"}),
            json!({"name": "RustMusic_0.1.2_x64-setup.exe", "size": 2,
                   "browser_download_url": "https://example.com/setup.exe"}),
        ];
        let (name, _, size, _) = pick_setup_asset(&assets).expect("应选中 setup.exe");
        assert!(name.ends_with("-setup.exe"));
        assert_eq!(size, 2);
    }

    #[test]
    #[cfg(windows)]
    fn script_quotes_paths_with_spaces_and_chinese() {
        let s = build_update_script(
            r"C:\Users\张三\AppData\Local\Temp\RustMusic_0.1.2.0_x64-setup.exe",
            r"C:\Program Files\RustMusic",
            r"C:\Program Files\RustMusic\rustmusic.exe",
            123,
        );
        // 落盘供 PowerShell 解析器做语法校验（UTF-8 BOM，与真实写入一致）
        let dump = std::env::temp_dir().join("rustmusic-update-script-test.ps1");
        std::fs::write(&dump, format!("\u{feff}{s}")).unwrap();
        assert!(s.contains(r"'C:\Users\张三\AppData\Local\Temp\RustMusic_0.1.2.0_x64-setup.exe'"));
        assert!(s.contains("Wait-Process -Id 123"), "The old player must exit before installation");
        assert!(s.contains("Start-Process -FilePath $setup") && s.contains("-Wait"),
            "The new player must not start until the installer exits");
        assert!(!s.contains("Get-Process -Name"), "Waiting on the installer filename caused premature restarts");
        assert!(s.contains(r#"('/DIR="' + $dir + '"')"#));
        assert!(s.contains("'C:\\Program Files\\RustMusic'"));
        // 单引号转义：路径里的 ' 必须 doubled，避免破坏 PS 字符串
        let q = build_update_script("C:\\it's\\setup.exe", "C:\\app", "C:\\app\\rustmusic.exe", 123);
        assert!(q.contains("'C:\\it''s\\setup.exe'"));
    }
}
