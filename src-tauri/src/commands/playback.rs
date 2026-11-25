//! 播放控制：本地曲目播放 / 播放状态 / 音量、倍速、均衡器 / 输出设备

use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::AppState;

use super::engine_clone;
// ---------- 输出设备 ----------

/// 枚举输出设备 + 当前生效的设备名
#[tauri::command]
pub async fn list_output_devices(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let engine = engine_clone(&state);
    let devices = engine.list_output_devices();
    Ok(json!({
        "devices": devices,
        "current": engine.current_device_name(),
        "preference": engine.device_preference(),
    }))
}

/// 切换输出设备；name 为空 = 跟随系统默认（并持久化偏好）
#[tauri::command]
pub async fn set_output_device(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<(), String> {
    let engine = engine_clone(&state);
    let pref = name.as_deref().filter(|s| !s.is_empty());
    engine.switch_output_device(pref)?;
    {
        let conn = state.db.lock();
        db::set_setting(&conn, "output_device", pref.unwrap_or(""));
    }
    let _ = app.emit("player://output-device", ());
    Ok(())
}
// ---------- 播放控制 ----------

fn local_quality(meta: &crate::models::TrackMeta) -> String {
    if meta.bit_depth >= 16 && meta.sample_rate >= 44100 {
        format!("{}kHz/{}bit", meta.sample_rate as f64 / 1000.0, meta.bit_depth)
    } else if meta.bitrate > 0 {
        // Lofty audio_bitrate() and the library database already use kbps.
        format!("{}kbps", meta.bitrate)
    } else {
        String::new()
    }
}

#[cfg(test)]
mod quality_tests {
    use super::local_quality;
    use crate::models::TrackMeta;

    #[test]
    fn library_kbps_is_not_divided_a_second_time() {
        for bitrate in [128, 256, 320] {
            let meta = TrackMeta { bitrate, ..Default::default() };
            assert_eq!(local_quality(&meta), format!("{bitrate}kbps"));
        }
    }

    #[test]
    fn unknown_bitrate_is_hidden_and_sample_rate_retains_precision() {
        assert_eq!(local_quality(&TrackMeta::default()), "");
        let meta = TrackMeta { bit_depth: 24, sample_rate: 44100, ..Default::default() };
        assert_eq!(local_quality(&meta), "44.1kHz/24bit");
    }
}

/// 曲库元数据 → 引擎播放信息（play_track 与预载共用）
fn track_info_from_meta(
    meta: crate::models::TrackMeta,
    local_quality: &str,
) -> crate::engine::TrackInfo {
    crate::engine::TrackInfo {
        id: Some(meta.id),
        kind: "track".into(),
        path: meta.path,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        cover: meta.cover,
        duration_ms: (meta.duration * 1000.0) as u64,
        nid: None,
        qid: None,
        kgid: None,
        quality: (!local_quality.is_empty()).then_some(local_quality.to_string()),
    }
}

/// 预载"自然播完后的下一曲"（仅本库曲目可由引擎直接起播）：
/// 自然播完引擎直接续播，挂起期间也无缝；在线曲目取链需要前端
///（登录态+网络），前端传 None 走原有唤醒编排路径
#[derive(serde::Deserialize)]
pub struct PreloadTrack {
    pub id: i64,
}

#[tauri::command]
pub async fn engine_preload_next(
    state: State<'_, AppState>,
    item: Option<PreloadTrack>,
) -> Result<(), String> {
    let info = match item {
        Some(q) => {
            let conn = state.db.lock();
            db::get_track(&conn, q.id).map(|meta| {
                let local_quality = local_quality(&meta);
                track_info_from_meta(meta, &local_quality)
            })
        }
        None => None,
    };
    engine_clone(&state).set_preload(info);
    Ok(())
}

#[tauri::command]
pub async fn play_track(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let meta = {
        let conn = state.db.lock();
        db::get_track(&conn, id)
            .ok_or_else(|| crate::i18n::pick("曲目不存在", "Track not found"))?
    };
    let local_quality = local_quality(&meta);
    let r = engine_clone(&state).play_file(track_info_from_meta(meta, &local_quality));
    // 开播成功才计入播放次数/最近播放：文件损坏等播放失败不计
    if r.is_ok() {
        let conn = state.db.lock();
        db::record_play(&conn, id);
    }
    r
}
/// WASAPI 独占模式开关（切换后下一首生效）
#[tauri::command]
pub async fn set_wasapi_exclusive(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let eng = engine_clone(&state);
    if enabled {
        eng.set_exclusive_enabled(true);
    } else {
        // 先成功交还设备并恢复共享输出，再持久化关闭开关。
        eng.stop_exclusive_resume_shared()?;
        eng.set_exclusive_enabled(false);
    }
    let conn = state.db.lock();
    db::set_setting(
        &conn,
        "wasapi_exclusive",
        if enabled { "true" } else { "false" },
    );
    Ok(())
}
#[tauri::command]
pub async fn play_pause(state: State<'_, AppState>) -> Result<(), String> {
    engine_clone(&state).toggle();
    Ok(())
}

/// 当前播放状态快照（含进度）。WebView 挂起恢复窗口期的事件推送可能丢失，
/// 前端恢复后主动拉取本命令做权威同步，不依赖任何固定延迟的补发。
#[tauri::command]
pub async fn get_play_state(
    state: State<'_, AppState>,
) -> Result<Option<crate::engine::PlayStateSnapshot>, String> {
    Ok(engine_clone(&state).snapshot())
}

#[tauri::command]
pub async fn pause(state: State<'_, AppState>) -> Result<(), String> {
    engine_clone(&state).pause();
    Ok(())
}

#[tauri::command]
pub async fn resume(state: State<'_, AppState>) -> Result<(), String> {
    engine_clone(&state).resume();
    Ok(())
}

#[tauri::command]
pub async fn stop(state: State<'_, AppState>) -> Result<(), String> {
    engine_clone(&state).stop();
    Ok(())
}

#[tauri::command]
pub async fn seek(state: State<'_, AppState>, ms: u64) -> Result<(), String> {
    engine_clone(&state).seek(ms)
}

#[tauri::command]
pub async fn set_volume(state: State<'_, AppState>, v: f32) -> Result<(), String> {
    engine_clone(&state).set_volume(v);
    let conn = state.db.lock();
    db::set_setting(&conn, "volume", &format!("{}", v));
    Ok(())
}

#[tauri::command]
pub async fn set_speed(state: State<'_, AppState>, v: f32) -> Result<(), String> {
    engine_clone(&state).set_speed(v);
    let conn = state.db.lock();
    db::set_setting(&conn, "speed", &format!("{}", v));
    Ok(())
}

#[tauri::command]
pub async fn set_eq(
    state: State<'_, AppState>,
    gains: Vec<f32>,
    enabled: bool,
) -> Result<(), String> {
    if gains.len() != 10 {
        return Err(crate::i18n::pick(
            "均衡器需要 10 个频段的增益",
            "Equalizer requires 10 band gain values",
        )
        .into());
    }
    let mut arr = [0f32; 10];
    arr.copy_from_slice(&gains);
    engine_clone(&state).eq.set(arr, enabled);
    let conn = state.db.lock();
    db::set_setting(&conn, "eq_gains", &serde_json::to_string(&gains).unwrap());
    db::set_setting(&conn, "eq_enabled", &enabled.to_string());
    Ok(())
}

#[tauri::command]
pub fn set_vocal_removal(app: AppHandle, state: State<'_, AppState>, amount: f32) -> Result<(), String> {
    engine_clone(&state).vocal.set(amount)?;
    let _ = app.emit("player://vocal-removal", amount);
    Ok(())
}

#[tauri::command]
pub fn get_vocal_removal(state: State<'_, AppState>) -> f32 {
    engine_clone(&state).vocal.amount_percent()
}

#[tauri::command]
pub fn vocal_removal_status() -> crate::vocal::VocalStatus {
    crate::vocal::status()
}

#[tauri::command]
pub fn set_pitch_shift(app: tauri::AppHandle, state: State<'_, AppState>, semitones: f32) -> Result<(), String> {
    use tauri::Emitter;
    engine_clone(&state).pitch.set(semitones)?;
    let _ = app.emit("player://pitch", semitones);
    Ok(())
}

#[tauri::command]
pub fn get_pitch_shift(state: State<'_, AppState>) -> f32 {
    engine_clone(&state).pitch.semitones()
}

/// 皮肤音频律动开关：前端在律动层挂载/卸载与窗口可见性变化时调用，
/// 关闭时分析线程空转（每 tick 一次原子读），不空发事件
#[tauri::command]
pub fn fx_set_enabled(state: State<'_, AppState>, enabled: bool) {
    engine_clone(&state).fx.set_enabled(enabled);
    #[cfg(debug_assertions)]
    eprintln!(
        "[fx] spectrum {}",
        if enabled { "enabled" } else { "disabled" }
    );
}
