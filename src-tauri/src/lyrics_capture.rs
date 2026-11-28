//! One renderer process per layer gives game-capture hooks an unambiguous swap chain.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};
use tauri::window::WindowBuilder;
#[path = "lyrics_capture_gpu.rs"]
mod gpu;

struct Process { pid: u32, input: Option<std::process::ChildStdin>, visible: bool, ready: bool, suspended: bool, title: String, geometry: Value }
static PROCESSES: OnceLock<Mutex<HashMap<String, Process>>> = OnceLock::new();
fn processes() -> &'static Mutex<HashMap<String, Process>> { PROCESSES.get_or_init(Default::default) }

fn send(id: &str, command: Value) -> Result<(), String> {
    let mut processes = processes().lock().map_err(|e| e.to_string())?;
    let process = processes.get_mut(id).ok_or("请先创建透明窗口")?;
    let input = process.input.as_mut().ok_or("窗口正在休眠，请重新显示")?;
    writeln!(input, "{command}").and_then(|_| input.flush()).map_err(|e| e.to_string())
}
pub fn windows() -> Result<Vec<Value>, String> {
    Ok(processes().lock().map_err(|e| e.to_string())?.iter().filter(|(_, process)| process.ready).map(|(id, process)| json!({"id":id,"visible":process.visible})).collect())
}
pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(mut process) = processes().lock().map_err(|e| e.to_string())?.remove(id) {
        if let Some(input) = process.input.as_mut() { let _ = writeln!(input, "{}", json!({"command":"close"})); }
    }
    app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":id,"open":false,"visible":false})).map_err(|e| e.to_string())
}
pub async fn visibility(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    if visible {
        let title = processes().lock().map_err(|e| e.to_string())?.get(&id).ok_or("请先创建透明窗口")?.title.clone();
        open(app, id, title).await
    } else {
        let pid = {
            let mut processes = processes().lock().map_err(|e| e.to_string())?;
            let process = processes.get_mut(&id).ok_or("请先创建透明窗口")?;
            if process.input.is_none() { return Ok(()); }
            process.suspended = true;
            let input = process.input.as_mut().unwrap();
            if let Err(error) = writeln!(input, "{}", json!({"command":"hibernate"})).and_then(|_| input.flush()) {
                process.suspended = false;
                return Err(error.to_string());
            }
            process.pid
        };
        tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            loop {
                let processes = processes().lock().map_err(|e| e.to_string())?;
                if !processes.get(&id).is_some_and(|process| process.pid == pid && process.input.is_some()) { return Ok(()); }
                drop(processes);
                if started.elapsed() > Duration::from_secs(15) { return Err("窗口内存尚未释放，请稍后重试".to_owned()); }
                std::thread::sleep(Duration::from_millis(25));
            }
        }).await.map_err(|e| e.to_string())?
    }
}
pub fn title(id: &str, title: &str) -> Result<(), String> {
    let running = {
        let mut processes = processes().lock().map_err(|e| e.to_string())?;
        let process = processes.get_mut(id).ok_or("请先创建透明窗口")?;
        process.title = title.to_owned();
        process.input.is_some()
    };
    if running { send(id, json!({"command":"title","title":title})) } else { Ok(()) }
}

pub async fn open(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let (running, geometry) = {
        let processes = processes().lock().map_err(|e| e.to_string())?;
        if processes.get(&id).is_some_and(|process| process.suspended && process.input.is_some()) { return Err("窗口正在回收内存，请稍后重新显示".to_owned()); }
        processes.get(&id).map(|process| (process.input.is_some(), process.geometry.clone())).unwrap_or((false, Value::Null))
    };
    if running { return send(&id, json!({"command":"visible","visible":true})); }
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(["--lyrics-capture", &id, &title, &geometry.to_string()]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("无法创建游戏采集窗口：{e}"))?;
    let pid = child.id();
    let input = child.stdin.take().ok_or("无法连接歌词窗口")?;
    let output = child.stdout.take().ok_or("无法读取歌词窗口状态")?;
    processes().lock().map_err(|e| e.to_string())?.insert(id.clone(), Process { pid, input: Some(input), visible: false, ready: false, suspended: false, title, geometry });
    let (ready_tx, ready_rx) = mpsc::channel();
    let watched_id = id.clone();
    let error_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            let Ok(mut processes) = processes().lock() else { break };
            let Some(process) = processes.get_mut(&watched_id).filter(|process| process.pid == pid) else { continue };
            if message["geometry"].is_object() {
                process.geometry = message["geometry"].clone();
            }
            if let Some(error) = message["error"].as_str() {
                process.suspended = false;
                let _ = ready_tx.send(Err(error.to_owned()));
                let _ = app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":watched_id,"open":false,"visible":false,"error":error}));
            }
            if let Some(visible) = message["visible"].as_bool() {
                process.visible = visible; process.ready = true;
                let _ = app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":watched_id,"open":true,"visible":visible}));
                let _ = ready_tx.send(Ok(()));
            }
        }
        let _ = child.wait();
        if let Ok(mut processes) = processes().lock() {
            if let Some(process) = processes.get_mut(&watched_id).filter(|process| process.pid == pid) {
                if process.suspended {
                    process.input = None; process.pid = 0; process.visible = false; process.ready = true;
                    let _ = app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":watched_id,"open":true,"visible":false}));
                } else {
                    processes.remove(&watched_id);
                    let _ = app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":watched_id,"open":false,"visible":false}));
                }
            }
        }
        let _ = ready_tx.send(Err("游戏采集窗口已退出".to_owned()));
    });
    let result = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(25)).map_err(|_| "游戏采集窗口启动超时".to_owned())?).await.map_err(|e| e.to_string())?;
    if result.is_err() {
        let mut processes = processes().lock().map_err(|e| e.to_string())?;
        if processes.get(&id).is_some_and(|process| process.pid == pid) {
            processes.remove(&id);
            let _ = error_app.emit_to("main", "obs-lyrics-canvas-window", json!({"id":id,"open":false,"visible":false}));
        }
    }
    result
}

fn reply(message: Value) { println!("{message}"); let _ = std::io::stdout().flush(); }


pub fn run_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--lyrics-capture") { return false; }
    let Some(id) = args.get(2).filter(|id| !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).cloned() else { return true };
    let title = args.get(3).cloned().unwrap_or_else(|| "透明歌词 - 播放器".to_owned());
    let geometry = args.get(4).and_then(|value| serde_json::from_str(value).ok()).unwrap_or(Value::Null);
    let path = if id == "primary" { "lyrics".to_owned() } else { format!("canvas/{id}") };
    run_source(format!("http://127.0.0.1:17842/{path}"), title, geometry);
    true
}

fn capture_title(title: &str) -> String {
    format!("{} - 请使用游戏捕捉", title.trim_end_matches(" - 请使用游戏捕捉"))
}

pub fn run_source(url: String, title: String, geometry: Value) {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let running = Arc::new(AtomicBool::new(true));
    let window_running = running.clone();
    let result = tauri::Builder::default().on_window_event(move |window, event| {
        if window.label() == "capture-output" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); window_running.store(false, Ordering::SeqCst); }
        }
    }).setup(move |app| {
        use sha2::Digest;
        let data = app.path().app_local_data_dir()?.join("lyrics-capture-webview").join(hex::encode(sha2::Sha256::digest(url.as_bytes())));
        let output = WindowBuilder::new(app, "capture-output").title(capture_title(&title)).inner_size(960.0, 540.0).min_inner_size(320.0, 180.0)
            .visible(false).build()?;
        if let (Some(width), Some(height)) = (geometry["width"].as_u64(), geometry["height"].as_u64()) {
            output.set_size(tauri::PhysicalSize::new(width.clamp(320, 7680) as u32, height.clamp(180, 4320) as u32))?;
        }
        if let (Some(x), Some(y)) = (geometry["x"].as_i64(), geometry["y"].as_i64()) { output.set_position(tauri::PhysicalPosition::new(x as i32, y as i32))?; }
        let hwnd = output.hwnd()?.0 as isize;
        let visible = Arc::new(AtomicBool::new(true));
        let input_output = output.clone();
        let input_visible = visible.clone();
        let input_running = running.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let Ok(command) = serde_json::from_str::<Value>(&line) else { continue };
                let result = match command["command"].as_str() {
                    Some("close") => break,
                    Some("hibernate") => {
                        if let (Ok(size), Ok(position)) = (input_output.inner_size(), input_output.outer_position()) { reply(json!({"geometry":{"width":size.width,"height":size.height,"x":position.x,"y":position.y}})); }
                        let _ = input_output.hide();
                        break;
                    }
                    Some("visible") => {
                        let show = command["visible"] == true;
                        let result = if show { input_output.unminimize().and_then(|_| input_output.show()) } else { input_output.hide() };
                        if result.is_ok() { input_visible.store(show, Ordering::SeqCst); reply(json!({"visible":show})); }
                        result
                    }
                    Some("title") => input_output.set_title(&capture_title(command["title"].as_str().unwrap_or("透明歌词"))),
                    #[cfg(feature = "acceptance-tests")]
                    Some("minimize") => input_output.minimize(),
                    _ => continue,
                };
                if let Err(error) = result { reply(json!({"error":error.to_string()})); break; }
            }
            input_running.store(false, Ordering::SeqCst);
        });
        let render_app = app.handle().clone();
        std::thread::spawn(move || {
            let render = || -> Result<(), String> {
                let _apartment = gpu::Apartment::new()?;
                let size = output.inner_size().map_err(|e| e.to_string())?;
                let mut surface = crate::lyrics_capture_d3d::CaptureSurface::new(hwnd, size.width, size.height)?;
                let source = gpu::GpuSource::start(&render_app, hwnd, url, data, surface.capture_device()?, size.width, size.height)?;
                let mut dimensions = (size.width, size.height);
                let mut first = true;
                let started = Instant::now();
                #[cfg(feature = "acceptance-tests")]
                let mut diagnostic_frames = 0;
                #[cfg(feature = "acceptance-tests")]
                let mut performance_frames = Vec::new();
                #[cfg(feature = "acceptance-tests")]
                let performance_path = std::env::var_os("RUSTMUSIC_CAPTURE_PERFORMANCE_PATH");
                #[cfg(feature = "acceptance-tests")]
                let mut previous_frame = Instant::now();
                while running.load(Ordering::SeqCst) {
                    #[cfg(feature = "acceptance-tests")]
                    let frame_started = Instant::now();
                    if !visible.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(100)); continue; }
                    // A minimized HWND may report zero client size; retain its capture resolution.
                    let size = if output.is_minimized().map_err(|e| e.to_string())? {
                        tauri::PhysicalSize::new(dimensions.0, dimensions.1)
                    } else { output.inner_size().map_err(|e| e.to_string())? };
                    if size.width == 0 || size.height == 0 { std::thread::sleep(Duration::from_millis(100)); continue; }
                    if dimensions != (size.width, size.height) {
                        source.resize(size.width, size.height)?;
                        dimensions = (size.width, size.height);
                    }
                    #[cfg(feature = "acceptance-tests")]
                    let capture_started = Instant::now();
                    let Some(frame) = source.next_frame()? else {
                        if first && started.elapsed() > Duration::from_secs(15) { return Err("网页 GPU 首帧生成超时".into()); }
                        continue;
                    };
                    #[cfg(feature = "acceptance-tests")]
                    let capture_finished = Instant::now();
                    let content_size = frame.ContentSize().map_err(|e| e.to_string())?;
                    if (content_size.Width as u32, content_size.Height as u32) != dimensions { continue; }
                    use windows::core::Interface;
                    let access: windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess = frame.Surface().map_err(|e| e.to_string())?.cast().map_err(|e| e.to_string())?;
                    let texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
                    let mut texture_size = windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC::default();
                    unsafe { texture.GetDesc(&mut texture_size); }
                    if (texture_size.Width, texture_size.Height) != dimensions { continue; }
                    surface.present_texture(dimensions.0, dimensions.1, &texture)?;
                    drop(texture);
                    drop(access);
                    drop(frame);
                    #[cfg(feature = "acceptance-tests")]
                    if let Some(path) = &performance_path {
                        let finished = Instant::now();
                        let milliseconds = |duration: Duration| duration.as_secs_f64() * 1000.0;
                        performance_frames.push(json!({
                            "captureMs":milliseconds(capture_finished-capture_started),
                            "transferMs":0,
                            "decodeMs":0,
                            "presentMs":milliseconds(finished-capture_finished),
                            "workMs":milliseconds(finished-frame_started),
                            "intervalMs":milliseconds(finished-previous_frame)
                        }));
                        previous_frame = finished;
                        if performance_frames.len() == 180 {
                            std::fs::write(path, serde_json::to_vec(&performance_frames).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                            return Ok(());
                        }
                    }
                    #[cfg(feature = "acceptance-tests")]
                    if std::env::var_os("RUSTMUSIC_CAPTURE_FRAME_DIRECTORY").is_some() {
                        diagnostic_frames += 1;
                        if diagnostic_frames == 30 && std::env::var_os("RUSTMUSIC_CAPTURE_TEST_EXIT").is_some() { return Ok(()); }
                    }
                    if first { output.show().map_err(|e| e.to_string())?; reply(json!({"visible":true})); first = false; }
                }
                Ok(())
            };
            match render() {
                Ok(()) => render_app.exit(0),
                Err(error) => { reply(json!({"error":error})); render_app.exit(1); }
            }
        });
        Ok(())
    }).build(context);
    match result { Ok(app) => app.run(|_, _| {}), Err(error) => reply(json!({"error":error.to_string()})) }
}
