use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
#[path = "studio_one_ucnet.rs"]
mod ucnet;

static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudioOneHost {
    pub(crate) pid: u32,
    pub(crate) thread: u32,
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudioOneChannel {
    token: String,
    id: Option<String>,
    name: Option<String>,
    input: Option<String>,
    channel_type: Option<i32>,
    index: Option<i32>,
    volume: Option<f64>,
    max_volume: Option<f64>,
    pan: Option<f64>,
    mute: Option<bool>,
    solo: Option<bool>,
    monitor: Option<bool>,
    plugin: Option<String>,
    plugin_enabled: Option<bool>,
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawHost {
        pid: u32,
        thread: u32,
        name: [u8; 96],
        title: [u8; 256],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawChannel {
        token: u64,
        flags: u32,
        bypass_id: u32,
        channel_type: i32,
        index: i32,
        mute: i32,
        solo: i32,
        monitor: i32,
        volume: f64,
        max_volume: f64,
        pan: f64,
        bypass_value: f64,
        id: [u8; 128],
        name: [u8; 128],
        plugin: [u8; 128],
    }

    #[repr(C)]
    struct RawReply {
        status: u32,
        channel_count: u32,
        error: [u8; 256],
        channels: [RawChannel; 64],
    }

    static LIBRARY: OnceLock<Mutex<Option<libloading::Library>>> = OnceLock::new();

    fn with_library<T>(
        f: impl FnOnce(&libloading::Library) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut library = LIBRARY
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?;
        if library.is_none() {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let base = exe.parent().ok_or("无法定位 Studio One 控制模块")?;
            let candidates = [
                base.join("resources/rustmusic-studioone-bridge.dll"),
                base.join("rustmusic-studioone-bridge.dll"),
                base.join("../rustmusic-studioone-bridge.dll"),
            ];
            let path = candidates
                .iter()
                .find(|path| path.is_file())
                .ok_or("Studio One 控制模块文件缺失")?;
            *library = Some(
                unsafe { libloading::Library::new(path) }
                    .map_err(|e| format!("Studio One 控制模块未能加载：{e}"))?,
            );
        }
        f(library.as_ref().unwrap())
    }

    fn text(raw: &[u8]) -> String {
        String::from_utf8_lossy(&raw[..raw.iter().position(|b| *b == 0).unwrap_or(raw.len())])
            .into_owned()
    }

    fn check(code: u32) -> Result<(), String> {
        match code {
            0 => Ok(()),
            50 => Err("Studio One 控制目前仅支持 64 位 Windows".into()),
            258 => Err("Studio One 主线程没有响应，稍后重试".into()),
            2250 => Err("Studio One 尚未连接".into()),
            _ => Err(format!("Studio One Hook 调用失败（系统代码 {code}）")),
        }
    }

    pub fn hosts() -> Result<Vec<StudioOneHost>, String> {
        with_library(|library| unsafe {
            let call = library
                .get::<unsafe extern "C" fn(*mut RawHost, u32) -> u32>(b"so_hosts\0")
                .map_err(|e| e.to_string())?;
            let mut raw: [RawHost; 16] = std::mem::zeroed();
            let count = call(raw.as_mut_ptr(), raw.len() as u32).min(raw.len() as u32);
            Ok(raw[..count as usize]
                .iter()
                .map(|host| StudioOneHost {
                    pid: host.pid,
                    thread: host.thread,
                    name: text(&host.name),
                    title: text(&host.title),
                    hidden: false,
                })
                .collect())
        })
    }

    pub fn connect(pid: u32, thread: u32) -> Result<(), String> {
        with_library(|library| unsafe {
            let call = library
                .get::<unsafe extern "C" fn(u32, u32) -> u32>(b"so_connect\0")
                .map_err(|e| e.to_string())?;
            check(call(pid, thread))
        })
    }

    pub fn disconnect_all() -> Result<(), String> {
        let library = LIBRARY
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?;
        let Some(library) = library.as_ref() else {
            return Ok(());
        };
        unsafe {
            let call = library
                .get::<unsafe extern "C" fn() -> u32>(b"so_disconnect_all\0")
                .map_err(|e| e.to_string())?;
            check(call())
        }
    }

    pub fn snapshot(pid: u32) -> Result<Vec<StudioOneChannel>, String> {
        with_library(|library| unsafe {
            type Exchange = unsafe extern "C" fn(u32, u32, u64, f64, *mut RawReply) -> u32;
            let call = library
                .get::<Exchange>(b"so_exchange\0")
                .map_err(|e| e.to_string())?;
            let mut reply: Box<RawReply> = Box::new(std::mem::zeroed());
            check(call(pid, 1, 0, 0.0, &mut *reply))?;
            if reply.status != 0 {
                return Err(text(&reply.error));
            }
            Ok(reply.channels[..reply.channel_count.min(64) as usize]
                .iter()
                .filter_map(|c| {
                    let has = |flag| c.flags & flag != 0;
                    Some(StudioOneChannel {
                        input: None,
                        token: c.token.to_string(),
                        id: has(1).then(|| text(&c.id)),
                        name: has(2).then(|| text(&c.name)),
                        channel_type: has(4).then_some(c.channel_type),
                        index: has(8).then_some(c.index),
                        volume: has(16).then_some(c.volume),
                        max_volume: has(32).then_some(c.max_volume),
                        pan: has(64).then_some(c.pan),
                        mute: has(128).then_some(c.mute != 0),
                        solo: has(256).then_some(c.solo != 0),
                        monitor: has(512).then_some(c.monitor != 0),
                        plugin: has(2048).then(|| text(&c.plugin)),
                        plugin_enabled: has(1024).then_some(c.bypass_value < 0.5),
                    })
                })
                .collect())
        })
    }

    pub fn set(pid: u32, token: u64, field: &str, value: f64) -> Result<(), String> {
        let operation = match field {
            "volume" if value.is_finite() && value >= 0.0 => 2,
            "monitor" if value == 0.0 || value == 1.0 => 3,
            "pluginEnabled" if value == 0.0 || value == 1.0 => 4,
            "mute" if value == 0.0 || value == 1.0 => 6,
            "solo" if value == 0.0 || value == 1.0 => 7,
            "volume" | "monitor" | "pluginEnabled" | "mute" | "solo" => {
                return Err("Studio One 控制值无效".into())
            }
            _ => return Err("不支持此 Studio One 控制项".into()),
        };
        with_library(|library| unsafe {
            type Exchange = unsafe extern "C" fn(u32, u32, u64, f64, *mut RawReply) -> u32;
            let call = library
                .get::<Exchange>(b"so_exchange\0")
                .map_err(|e| e.to_string())?;
            let mut reply: Box<RawReply> = Box::new(std::mem::zeroed());
            check(call(pid, operation, token, value, &mut *reply))?;
            if reply.status == 0 {
                Ok(())
            } else {
                Err(text(&reply.error))
            }
        })
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn hosts() -> Result<Vec<StudioOneHost>, String> {
        Err("Studio One Hook 仅支持 Windows".into())
    }
    pub fn connect(_: u32, _: u32) -> Result<(), String> {
        Err("Studio One Hook 仅支持 Windows".into())
    }
    pub fn disconnect_all() -> Result<(), String> {
        Ok(())
    }
    pub fn snapshot(_: u32) -> Result<Vec<StudioOneChannel>, String> {
        Err("Studio One Hook 仅支持 Windows".into())
    }
    pub fn set(_: u32, _: u64, _: &str, _: f64) -> Result<(), String> {
        Err("Studio One Hook 仅支持 Windows".into())
    }
}

fn validate_write(channel: &StudioOneChannel, field: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() {
        return Err("Studio One 控制值无效".into());
    }
    match field {
        "volume" if channel.volume.is_some() && value >= 0.0 && value <= channel.max_volume.unwrap_or(1.0) => Ok(()),
        "monitor" if channel.monitor.is_some() && (value == 0.0 || value == 1.0) => Ok(()),
        "pluginEnabled" if channel.plugin_enabled.is_some() && (value == 0.0 || value == 1.0) => {
            Ok(())
        }
        "mute" if channel.mute.is_some() && (value == 0.0 || value == 1.0) => Ok(()),
        "solo" if channel.solo.is_some() && (value == 0.0 || value == 1.0) => Ok(()),
        "volume" => Err("推子值超出 Studio One 音轨范围".into()),
        "monitor" => Err("此 Studio One 音轨不支持监听控制".into()),
        "pluginEnabled" => Err("此插件不支持启用/旁路控制".into()),
        "mute" => Err("此 Studio One 通道不支持静音控制".into()),
        "solo" => Err("此 Studio One 通道不支持独奏控制".into()),
        _ => Err("不支持此 Studio One 控制项".into()),
    }
}

#[tauri::command]
pub async fn studio_one_set_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        ENABLED.store(true, Ordering::SeqCst);
    } else {
        ENABLED.store(false, Ordering::SeqCst);
        #[cfg(windows)]
        ucnet::disconnect();
        restore_host_window()?;
        tauri::async_runtime::spawn_blocking(native::disconnect_all)
            .await
            .map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[tauri::command]
pub async fn studio_one_hosts() -> Result<Vec<StudioOneHost>, String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        if let Some(host) = crate::studio_one_window::hidden_host()? {
            return Ok(vec![host]);
        }
        native::hosts()
    })
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn restore_host_window() -> Result<(), String> {
    #[cfg(windows)]
    crate::studio_one_window::restore()?;
    Ok(())
}

#[cfg(windows)]
fn is_remote_only_host(pid: u32) -> Result<bool, String> {
    let hidden = crate::studio_one_window::hidden_host()?;
    Ok(hidden.into_iter().chain(native::hosts()?)
        .any(|host| host.pid == pid && host.name == "Studio Pro"))
}

#[tauri::command]
pub async fn studio_one_set_host_hidden(pid: u32, hidden: bool) -> Result<(), String> {
    if !hidden {
        return restore_host_window();
    }
    #[cfg(windows)]
    {
        if !ENABLED.load(Ordering::SeqCst) {
            return Err("请先开启 Studio One 控制".into());
        }
        let host = native::hosts()?.into_iter().find(|host| host.pid == pid)
            .ok_or("Studio One 已关闭")?;
        crate::studio_one_window::hide(host)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("隐藏 Studio One 宿主仅支持 Windows".into())
    }
}

#[tauri::command]
pub async fn studio_one_connect(pid: u32, thread: u32) -> Result<(), String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Err("请先开启 Studio One 控制".into());
    }
    tauri::async_runtime::spawn_blocking(move || {

        #[cfg(windows)]
        {
            let studio_pro = is_remote_only_host(pid)?;
            let _ = ucnet::snapshot(pid, studio_pro);
            if ucnet::connected(pid) || studio_pro {
                return Ok(());
            }
        }
        native::connect(pid, thread)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn studio_one_snapshot(pid: u32) -> Result<Vec<StudioOneChannel>, String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {

        #[cfg(windows)]
        {
            let studio_pro = is_remote_only_host(pid)?;
            if let Some(remote) = ucnet::snapshot(pid, studio_pro) {
                // A complete mixer snapshot binds the controls to the actual
                // channel and insert slot, not to similarly named VST instances.
                return Ok(remote);
            }
            if ucnet::connected(pid) || studio_pro {
                return Ok(Vec::new());
            }
        }
        native::snapshot(pid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn studio_one_set(
    pid: u32,
    token: String,
    field: String,
    value: f64,
) -> Result<(), String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Err("请先开启 Studio One 控制".into());
    }
    tauri::async_runtime::spawn_blocking(move || {

        #[cfg(windows)]
        if token.starts_with("ucnet:") {
            return ucnet::set(pid, &token, &field, value);
        }
        let token: u64 = token.parse().map_err(|_| "Studio One 控制项无效")?;
        let channel = native::snapshot(pid)?
            .into_iter()
            .find(|channel| channel.token == token.to_string())
            .ok_or("目标音轨或插件已关闭")?;
        validate_write(&channel, &field, value)?;
        native::set(pid, token, &field, value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> StudioOneChannel {
        StudioOneChannel {
            input: None,
            token: "7".into(),
            id: None,
            name: None,
            channel_type: None,
            index: None,
            volume: Some(0.5),
            max_volume: Some(1.5),
            pan: Some(0.0),
            mute: Some(false),
            solo: Some(false),
            monitor: Some(false),
            plugin: None,
            plugin_enabled: Some(true),
        }
    }

    #[test]
    fn host_controls_reject_unsupported_fields_and_out_of_range_values() {
        let channel = channel();
        assert!(validate_write(&channel, "volume", 1.5).is_ok());
        assert!(validate_write(&channel, "volume", 1.51).is_err());
        assert!(validate_write(&channel, "monitor", 1.0).is_ok());
        assert!(validate_write(&channel, "pluginEnabled", 0.0).is_ok());
        assert!(validate_write(&channel, "mute", 1.0).is_ok());
        assert!(validate_write(&channel, "solo", 1.0).is_ok());
        assert!(validate_write(&channel, "monitor", f64::NAN).is_err());

        let mut unsupported = channel;
        unsupported.monitor = None;
        unsupported.plugin_enabled = None;
        assert!(validate_write(&unsupported, "monitor", 1.0).is_err());
        assert!(validate_write(&unsupported, "pluginEnabled", 1.0).is_err());
    }
}
