//! WebView2 composition frames stay on the GPU through the game-capture swap chain.
use std::{cell::RefCell, path::PathBuf, sync::{Arc, Condvar, Mutex, mpsc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::AppHandle;
use webview2_com::{Microsoft::Web::WebView2::Win32::*, CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler, CreateCoreWebView2CompositionControllerCompletedHandler, NavigationCompletedEventHandler};
use windows::{core::{Interface, HSTRING, PCWSTR}, Graphics::{Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession}, DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat}, SizeInt32}, System::{DispatcherQueue, DispatcherQueueController}, UI::Composition::{Compositor, ContainerVisual}, Win32::{Foundation::{HWND, RECT}, System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_STA, DQTYPE_THREAD_CURRENT}}};

type FrameSlot = Arc<(Mutex<Option<Result<Direct3D11CaptureFrame, String>>>, Condvar, AtomicBool)>;
struct CompositionState {
    _queue: Option<DispatcherQueueController>,
    _compositor: Compositor,
    root: ContainerVisual,
    _web_visual: ContainerVisual,
    controller: ICoreWebView2Controller,
    _composition: ICoreWebView2CompositionController,
    _environment: ICoreWebView2Environment,
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    frame_token: i64,
    session: GraphicsCaptureSession,
    device: IDirect3DDevice,
}
impl Drop for CompositionState {
    fn drop(&mut self) {
        let _ = self.pool.RemoveFrameArrived(self.frame_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
        unsafe { let _ = self.controller.Close(); }
    }
}
thread_local! { static STATE: RefCell<Option<CompositionState>> = const { RefCell::new(None) }; }

pub(super) struct GpuSource { app: AppHandle, frames: FrameSlot }
pub(super) struct Apartment;
impl Apartment {
    pub(super) fn new() -> Result<Self, String> {
        unsafe { windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for Apartment { fn drop(&mut self) { unsafe { windows::Win32::System::WinRT::RoUninitialize(); } } }
impl Drop for GpuSource {
    fn drop(&mut self) {
        self.frames.2.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.frames.0.lock() { if let Some(Ok(frame)) = slot.take() { let _ = frame.Close(); } }
        let (tx, rx) = mpsc::channel();
        if self.app.run_on_main_thread(move || {
            let queue = STATE.with(|state| {
                let state = state.borrow_mut().take();
                let queue = state.as_ref().and_then(|state| state._queue.clone());
                drop(state);
                queue
            });
            let _ = tx.send(queue.map(|queue| queue.ShutdownQueueAsync()).transpose());
        }).is_ok() {
            if let Ok(Ok(Some(action))) = rx.recv_timeout(Duration::from_secs(3)) {
                // The UI thread keeps pumping while its owned dispatcher completes shutdown.
                for _ in 0..300 {
                    if action.Status().map(|status| status.0 != 0).unwrap_or(true) { break; }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}
pub(super) struct GpuFrame(Direct3D11CaptureFrame);
impl std::ops::Deref for GpuFrame {
    type Target = Direct3D11CaptureFrame;
    fn deref(&self) -> &Self::Target { &self.0 }
}
impl Drop for GpuFrame { fn drop(&mut self) { let _ = self.0.Close(); } }
impl GpuSource {
    pub(super) fn start(app: &AppHandle, hwnd: isize, url: String, data: PathBuf, device: IDirect3DDevice, width: u32, height: u32) -> Result<Self, String> {
        let frames: FrameSlot = Arc::new((Mutex::new(None), Condvar::new(), AtomicBool::new(false)));
        let source_frames = frames.clone();
        let (tx, rx) = mpsc::channel();
        let device = windows::core::AgileReference::new(&device).map_err(|e| e.to_string())?;
        app.run_on_main_thread(move || unsafe {
            let device = match device.resolve() { Ok(device) => device, Err(error) => { let _ = tx.send(Err(error.to_string())); return; } };
            let completed = tx.clone();
            let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
                let setup = || -> Result<(), String> {
                    result.map_err(|e| e.to_string())?;
                    let environment = environment.ok_or("WebView2 环境未创建")?;
                    let environment3: ICoreWebView2Environment3 = environment.cast().map_err(|e| e.to_string())?;
                    let environment = environment.clone();
                    let ready = completed.clone();
                    let frames = source_frames.clone();
                    let url = url.clone();
                    let device = device.clone();
                    let controller_handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(move |result, composition| {
                        let initialize = || -> Result<(), String> {
                            result.map_err(|e| e.to_string())?;
                            let composition = composition.ok_or("WebView2 合成控制器未创建")?;
                            let controller: ICoreWebView2Controller = composition.cast().map_err(|e| e.to_string())?;
                            let queue = if DispatcherQueue::GetForCurrentThread().is_ok() { None } else {
                                Some(CreateDispatcherQueueController(DispatcherQueueOptions { dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32, threadType: DQTYPE_THREAD_CURRENT, apartmentType: DQTAT_COM_STA }).map_err(|e| e.to_string())?)
                            };
                            let compositor = Compositor::new().map_err(|e| e.to_string())?;
                            let root = compositor.CreateContainerVisual().map_err(|e| e.to_string())?;
                            root.SetSize(windows_numerics::Vector2 { X: width as f32, Y: height as f32 }).map_err(|e| e.to_string())?;
                            root.SetIsVisible(true).map_err(|e| e.to_string())?;
                            let web_visual = compositor.CreateContainerVisual().map_err(|e| e.to_string())?;
                            web_visual.SetRelativeSizeAdjustment(windows_numerics::Vector2 { X: 1.0, Y: 1.0 }).map_err(|e| e.to_string())?;
                            root.Children().and_then(|children| children.InsertAtTop(&web_visual)).map_err(|e| e.to_string())?;
                            let controller3: ICoreWebView2Controller3 = controller.cast().map_err(|e| e.to_string())?;
                            controller3.SetShouldDetectMonitorScaleChanges(false).map_err(|e| e.to_string())?;
                            controller3.SetRasterizationScale(1.0).map_err(|e| e.to_string())?;
                            controller3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS).map_err(|e| e.to_string())?;
                            controller.SetBounds(RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 }).map_err(|e| e.to_string())?;
                            let controller2: ICoreWebView2Controller2 = controller.cast().map_err(|e| e.to_string())?;
                            controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 }).map_err(|e| e.to_string())?;
                            controller.SetIsVisible(true).map_err(|e| e.to_string())?;
                            composition.SetRootVisualTarget(&web_visual).map_err(|e| e.to_string())?;
                            let core = controller.CoreWebView2().map_err(|e| e.to_string())?;
                            let navigation_frames = frames.clone();
                            let navigation = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                                if let Some(args) = args {
                                    let mut success = windows::core::BOOL::default();
                                    args.IsSuccess(&mut success)?;
                                    if !success.as_bool() {
                                        if let Ok(mut slot) = navigation_frames.0.lock() { *slot = Some(Err("歌词网页加载失败".into())); navigation_frames.1.notify_one(); }
                                    }
                                }
                                Ok(())
                            }));
                            let mut token = 0;
                            core.add_NavigationCompleted(&navigation, &mut token).map_err(|e| e.to_string())?;
                            let item = GraphicsCaptureItem::CreateFromVisual(&root).map_err(|e| format!("无法创建网页 GPU 合成画面：{e}"))?;
                            let size = SizeInt32 { Width: width as i32, Height: height as i32 };
                            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).map_err(|e| e.to_string())?;
                            let frame_slot = frames.clone();
                            let frame_token = pool.FrameArrived(&windows::Foundation::TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |pool, _| {
                                if let Some(pool) = pool.as_ref() {
                                    // Replacing an old frame bounds memory and keeps latency independent of rendering speed.
                                    if let Ok(mut slot) = frame_slot.0.lock() {
                                        if frame_slot.2.load(Ordering::SeqCst) { return Ok(()); }
                                        let frame = pool.TryGetNextFrame().map_err(|e| e.to_string());
                                        if slot.as_ref().is_some_and(Result::is_err) { if let Ok(frame) = frame { let _ = frame.Close(); } return Ok(()); }
                                        if let Some(Ok(old)) = slot.replace(frame) { let _ = old.Close(); }
                                        frame_slot.1.notify_one();
                                    }
                                }
                                Ok(())
                            })).map_err(|e| e.to_string())?;
                            let session = pool.CreateCaptureSession(&item).map_err(|e| e.to_string())?;
                            session.StartCapture().map_err(|e| e.to_string())?;
                            core.Navigate(&HSTRING::from(&url)).map_err(|e| e.to_string())?;
                            STATE.with(|state| *state.borrow_mut() = Some(CompositionState { _queue: queue, _compositor: compositor, root, _web_visual: web_visual, controller, _composition: composition.clone(), _environment: environment.clone(), _item: item, pool, frame_token, session, device: device.clone() }));
                            Ok(())
                        };
                        let _ = ready.send(initialize());
                        Ok(())
                    }));
                    environment3.CreateCoreWebView2CompositionController(HWND(hwnd as *mut _), &controller_handler).map_err(|e| e.to_string())
                };
                if let Err(error) = setup() { let _ = completed.send(Err(error)); }
                Ok(())
            }));
            let options = CoreWebView2EnvironmentOptions::default();
            options.set_additional_browser_arguments("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows".into());
            let options: ICoreWebView2EnvironmentOptions = options.into();
            let data = HSTRING::from(data.as_os_str());
            if let Err(error) = CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), PCWSTR(data.as_ptr()), &options, &handler) { let _ = tx.send(Err(error.to_string())); }
        }).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(25)).map_err(|_| "网页 GPU 渲染初始化超时".to_owned())??;
        Ok(Self { app: app.clone(), frames })
    }

    pub(super) fn resize(&self, width: u32, height: u32) -> Result<(), String> {
        self.frames.2.store(true, Ordering::SeqCst);
        if let Some(Ok(frame)) = self.frames.0.lock().map_err(|e| e.to_string())?.take() { let _ = frame.Close(); }
        let (tx, rx) = mpsc::channel();
        let frames = self.frames.clone();
        let dispatch = self.app.run_on_main_thread(move || {
            let resize = || -> Result<(), String> {
                STATE.with(|state| {
                    let state = state.borrow();
                    let state = state.as_ref().ok_or("网页 GPU 渲染尚未初始化")?;
                    state.root.SetSize(windows_numerics::Vector2 { X: width as f32, Y: height as f32 }).map_err(|e| e.to_string())?;
                    unsafe { state.controller.SetBounds(RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 }).map_err(|e| e.to_string())?; }
                    let _guard = frames.0.lock().map_err(|e| e.to_string())?;
                    state.pool.Recreate(&state.device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, SizeInt32 { Width: width as i32, Height: height as i32 }).map_err(|e| e.to_string())
                })
            };
            let _ = tx.send(resize());
        }).map_err(|e| e.to_string());
        let result = dispatch.and_then(|_| rx.recv_timeout(Duration::from_secs(8)).map_err(|_| "网页 GPU 画面调整超时".to_owned())?);
        self.frames.2.store(false, Ordering::SeqCst);
        result
    }

    pub(super) fn next_frame(&self) -> Result<Option<GpuFrame>, String> {
        let mut slot = self.frames.0.lock().map_err(|e| e.to_string())?;
        if slot.is_none() { slot = self.frames.1.wait_timeout(slot, Duration::from_millis(100)).map_err(|e| e.to_string())?.0; }
        slot.take().transpose().map(|frame| frame.map(GpuFrame))
    }
}
