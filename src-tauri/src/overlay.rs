use anyhow::Result;
use tauri::Manager;

fn anchor(app: &tauri::AppHandle, monitor: &tauri::Monitor) -> Result<()> {
    if let Some(window) = app.get_webview_window("launch-overlay") {
        let monitor = app
            .available_monitors()
            .ok()
            .and_then(|monitors| {
                monitors
                    .into_iter()
                    .filter(|m| m.name() == monitor.name())
                    .min_by_key(|m| {
                        let dx = i64::from(m.position().x) - i64::from(monitor.position().x);
                        let dy = i64::from(m.position().y) - i64::from(monitor.position().y);
                        dx * dx + dy * dy
                    })
            })
            .unwrap_or_else(|| monitor.clone());
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let size = window.outer_size()?;
        let (x, y) = crate::placement::bottom_right(
            (area.position.x, area.position.y),
            (area.size.width, area.size.height),
            (size.width, size.height),
            (24.0 * scale).round() as u32,
        );
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    Ok(())
}
pub fn show(app: &tauri::AppHandle) -> Result<()> {
    close(app);
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or(app.primary_monitor()?);
    #[cfg(target_os = "linux")]
    if crate::overlay_linux::needs_x11() {
        return crate::overlay_linux::show(monitor.as_ref());
    }
    let monitor = monitor.or_else(|| app.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "launch-overlay",
        tauri::WebviewUrl::App("launch-overlay.html".into()),
    )
    .title("Tia Game Library")
    .inner_size(236.0, 100.0)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible(false)
    .devtools(false)
    .on_navigation(|url| {
        matches!(
            url.host_str(),
            Some("localhost" | "tauri.localhost" | "127.0.0.1")
        )
    });
    let builder = builder.transparent(true);
    let window = builder.build()?;
    let handle = app.clone();
    let target = monitor.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            let _ = anchor(&handle, &target);
        }
    });
    anchor(app, &monitor)?;
    window.show()?;
    window.set_ignore_cursor_events(true)?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..6 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if handle.get_webview_window("launch-overlay").is_none() {
                return;
            }
            let _ = anchor(&handle, &monitor);
        }
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || close(&app));
    });
    Ok(())
}
pub fn close(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    crate::overlay_linux::close();
    if let Some(window) = app.get_webview_window("launch-overlay") {
        let _ = window.destroy();
    }
}
