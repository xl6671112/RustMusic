//! Opt-in real-engine check, excluded from production.
use tauri::Manager;

pub async fn run(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = std::env::var("RUSTMUSIC_ACCEPTANCE_AUDIO").map_err(|e| e.to_string())?;
    let play = |id: &str| crate::accompaniment::play_accompaniment(
        app.state(), path.clone(), "Pitch playback check".into(),
        "Fixture".into(), String::new(), "netease".into(), id.into(), None, None);
    play("42").await?;
    crate::commands::set_pitch_shift(app.clone(), app.state(), 3.0)?;
    if crate::commands::get_pitch_shift(app.state()) != 3.0 { return Err("Pitch command did not apply".into()); }
    crate::commands::pause(app.state()).await?;
    crate::commands::seek(app.state(), 2000).await?;
    if crate::commands::get_pitch_shift(app.state()) != 3.0 { return Err("Pause/seek reset current pitch".into()); }
    let engine = app.state::<crate::AppState>().engine.clone();
    engine.switch_output_device(None)?;
    if crate::commands::get_pitch_shift(app.state()) != 3.0 { return Err("Output switch reset current pitch".into()); }
    play("43").await?;
    if crate::commands::get_pitch_shift(app.state()) != 0.0 { return Err("Next song inherited old pitch".into()); }
    crate::commands::set_pitch_shift(app.clone(), app.state(), -2.0)?;
    play("42").await?;
    if crate::commands::get_pitch_shift(app.state()) != 0.0 { return Err("Previous song inherited old pitch".into()); }
    crate::commands::stop(app.state()).await?;
    Ok(serde_json::json!({"realEngine":true,"pitchCommandApplied":true,
        "pauseSeekRetainedPitch":true,"outputSwitchRetainedPitch":true,
        "nextAndPreviousResetPitch":true,"subjectiveQualityVerified":false}))
}
