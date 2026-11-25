use super::studio_one::StudioOneHost;
use std::sync::Mutex;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    ShowWindowAsync, GW_OWNER, SW_HIDE, SW_SHOWNA,
};

static HIDDEN: Mutex<Option<(usize, StudioOneHost)>> = Mutex::new(None);

fn same_window(hwnd: HWND, host: &StudioOneHost) -> bool {
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    thread != 0 && thread == host.thread && pid == host.pid
}

fn window_title(hwnd: HWND) -> String {
    let mut title = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    String::from_utf16_lossy(&title[..len])
}

pub(crate) fn hidden_host() -> Result<Option<StudioOneHost>, String> {
    let mut hidden = HIDDEN.lock().map_err(|e| e.to_string())?;
    if let Some((handle, host)) = hidden.as_ref() {
        let hwnd = HWND(*handle as _);
        if same_window(hwnd, host) {
            let mut host = host.clone();
            host.title = window_title(hwnd);
            host.hidden = !unsafe { IsWindowVisible(hwnd).as_bool() };
            return Ok(Some(host));
        }
    }
    *hidden = None;
    Ok(None)
}

pub(crate) fn hide(host: StudioOneHost) -> Result<(), String> {
    let mut hidden = HIDDEN.lock().map_err(|e| e.to_string())?;
    if hidden.is_some() {
        return Err("请先恢复之前隐藏的 Studio One 窗口".into());
    }
    struct Search<'a> {
        host: &'a StudioOneHost,
        hwnd: Option<HWND>,
    }
    unsafe extern "system" fn find(hwnd: HWND, param: LPARAM) -> BOOL {
        let search = unsafe { &mut *(param.0 as *mut Search<'_>) };
        if !same_window(hwnd, search.host)
            || !unsafe { IsWindowVisible(hwnd).as_bool() }
            || unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok()
        {
            return BOOL(1);
        }
        let title = window_title(hwnd);
        if title == search.host.title
            && matches!(search.host.name.as_str(), "Studio One" | "Studio Pro")
            && title.starts_with(&search.host.name)
        {
            search.hwnd = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search {
        host: &host,
        hwnd: None,
    };
    // A matched callback deliberately stops enumeration.
    let _ = unsafe { EnumWindows(Some(find), LPARAM(&mut search as *mut _ as isize)) };
    let hwnd = search
        .hwnd
        .ok_or("未找到 Studio One 主窗口，未隐藏其他窗口")?;
    if !same_window(hwnd, &host) || !unsafe { ShowWindowAsync(hwnd, SW_HIDE).as_bool() } {
        return Err("未能隐藏 Studio One 窗口".into());
    }
    *hidden = Some((hwnd.0 as usize, host));
    Ok(())
}

pub(crate) fn restore() -> Result<(), String> {
    let mut hidden = HIDDEN.lock().map_err(|e| e.to_string())?;
    if let Some((handle, host)) = hidden.as_ref() {
        let hwnd = HWND(*handle as _);
        // Queue the restore even if the previous hide is still pending.
        if same_window(hwnd, host) && !unsafe { ShowWindowAsync(hwnd, SW_SHOWNA).as_bool() } {
            return Err("未能恢复 Studio One 窗口，请重试".into());
        }
        *hidden = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, MSG, PM_REMOVE,
        WINDOW_EX_STYLE, WS_POPUP, WS_VISIBLE,
    };

    fn dispatch_window_commands(hwnd: HWND) {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&message);
            }
        }
    }

    #[test]
    fn hiding_the_host_preserves_the_connection_and_restores_the_same_window() {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Studio One - Test"),
                WS_POPUP | WS_VISIBLE,
                -20000,
                -20000,
                100,
                100,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap();
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let mut host = StudioOneHost {
            pid,
            thread,
            name: "Studio One".into(),
            title: "Studio One - Wrong window".into(),
            hidden: false,
        };
        assert!(hide(host.clone()).is_err());
        assert!(unsafe { IsWindowVisible(hwnd).as_bool() });
        host.title = "Studio One - Test".into();
        hide(host).unwrap();
        dispatch_window_commands(hwnd);
        let hidden = hidden_host().unwrap().unwrap();
        assert_eq!((hidden.pid, hidden.thread), (pid, thread));
        assert!(hidden.hidden);
        restore().unwrap();
        dispatch_window_commands(hwnd);
        assert!(unsafe { IsWindowVisible(hwnd).as_bool() });
        assert!(hidden_host().unwrap().is_none());
        unsafe { DestroyWindow(hwnd) }.unwrap();
    }
}
