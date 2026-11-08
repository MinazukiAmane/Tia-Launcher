use anyhow::Result;
use tauri::Manager;

fn anchor(app: &tauri::AppHandle, monitor: &tauri::Monitor) -> Result<()> {
    if let Some(window) = app.get_webview_window("launch-overlay") {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        window.set_position(tauri::PhysicalPosition::new(
            area.position
                .x
                .max(area.position.x + area.size.width as i32 - (260.0 * scale).round() as i32),
            area.position
                .y
                .max(area.position.y + area.size.height as i32 - (124.0 * scale).round() as i32),
        ))?;
    }
    Ok(())
}
pub fn show(app: &tauri::AppHandle) -> Result<()> {
    close(app);
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or(app.primary_monitor()?);
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
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder.build()?;
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
            let current = handle
                .available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().find(|m| m.name() == monitor.name()))
                .unwrap_or_else(|| monitor.clone());
            let _ = anchor(&handle, &current);
        }
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || close(&app));
    });
    Ok(())
}
pub fn close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("launch-overlay") {
        let _ = window.destroy();
    }
}
