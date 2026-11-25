use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Shortcuts(Mutex<HashMap<String, Shortcut>>);

#[tauri::command]
pub async fn studio_one_shortcut_set(
    window: WebviewWindow,
    effect: String,
    binding: Option<String>,
) -> Result<(), String> {
    if window.label() != "host-console" {
        return Err("请在主播控制台设置效果快捷键。".into());
    }
    let app = window.app_handle();
    let state = app.state::<Shortcuts>();
    let mut bindings = state.0.lock();
    if app.get_webview_window("host-console").is_none() {
        return Err("主播控制台已关闭。".into());
    }
    let previous = bindings.get(&effect).copied();
    let hotkeys = app.global_shortcut();
    let Some(binding) = binding else {
        if let Some(previous) = previous {
            hotkeys.unregister(previous).map_err(|e| e.to_string())?;
            bindings.remove(&effect);
        }
        return Ok(());
    };
    let shortcut = binding
        .replace("Win+", "Super+")
        .parse::<Shortcut>()
        .map_err(|_| "此按键不支持全局快捷键，请换一个按键。")?;
    if previous == Some(shortcut) {
        return Ok(());
    }
    if bindings.values().any(|registered| *registered == shortcut) {
        return Err("该快捷键已被其他效果占用，请换一个按键。".into());
    }
    let target = effect.clone();
    // Register first so an occupied shortcut never replaces the previous binding.
    hotkeys
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit_to("host-console", "studio-one://shortcut", &target);
            }
        })
        .map_err(|error| {
            let error = error.to_string();
            if error.starts_with("HotKey already registered") {
                "该快捷键已被其他应用或系统占用，请换一个按键。".into()
            } else {
                format!("全局快捷键注册失败，请换一个按键：{error}")
            }
        })?;
    if let Some(previous) = previous {
        if let Err(error) = hotkeys.unregister(previous) {
            let _ = hotkeys.unregister(shortcut);
            return Err(format!("无法解除原快捷键：{error}"));
        }
    }
    bindings.insert(effect, shortcut);
    Ok(())
}

pub async fn clear(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Shortcuts>();
    let mut bindings = state.0.lock();
    let mut failed = None;
    bindings.retain(|_, shortcut| {
        if let Err(error) = app.global_shortcut().unregister(*shortcut) {
            failed = Some(format!("清除效果快捷键失败：{error}"));
            true
        } else {
            false
        }
    });
    failed.map_or(Ok(()), Err)
}

#[tauri::command]
pub async fn studio_one_shortcuts_clear(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "host-console" {
        return Err("请在主播控制台设置效果快捷键。".into());
    }
    clear(window.app_handle().clone()).await
}
