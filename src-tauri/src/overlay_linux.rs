use anyhow::{Context, Result, ensure};
use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
};
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
#[cfg(debug_assertions)]
static REPORT: Mutex<Option<(u32, serde_json::Value)>> = Mutex::new(None);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Monitor {
    name: Option<String>,
    x: i32,
    y: i32,
}
pub fn needs_x11() -> bool {
    std::env::var_os("DISPLAY").is_some()
        && gtk::gdk::Display::default()
            .is_some_and(|display| display.type_().name().contains("Wayland"))
}
pub fn show(monitor: Option<&tauri::Monitor>) -> Result<()> {
    close();
    let position = monitor
        .map(|monitor| *monitor.position())
        .unwrap_or(tauri::PhysicalPosition::new(0, 0));
    let request = Monitor {
        name: monitor.and_then(|monitor| monitor.name().cloned()),
        x: position.x,
        y: position.y,
    };
    let child = Command::new(std::env::current_exe()?)
        .arg("--launch-overlay")
        .arg(serde_json::to_string(&request)?)
        .env("GDK_BACKEND", "x11")
        .stdin(Stdio::null())
        .stdout(if cfg!(debug_assertions) {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()?;
    let pid = child.id();
    #[cfg(debug_assertions)]
    let (child, output) = {
        let mut child = child;
        let output = child.stdout.take();
        (child, output)
    };
    *CHILD.lock().unwrap() = Some(child);
    #[cfg(debug_assertions)]
    if let Some(output) = output {
        std::thread::spawn(move || {
            use std::io::{BufRead, Read};
            let mut line = String::new();
            if std::io::BufReader::new(output.take(4096))
                .read_line(&mut line)
                .is_ok()
            {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if CHILD
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|child| child.id() == pid)
                    {
                        *REPORT.lock().unwrap() = Some((pid, value));
                    }
                }
            }
        });
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(3500));
        let mut child = CHILD.lock().unwrap();
        if child
            .as_mut()
            .is_some_and(|child| child.id() == pid && child.try_wait().ok().flatten().is_some())
        {
            *child = None;
        }
    });
    Ok(())
}
pub fn close() {
    if let Some(mut child) = CHILD.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
#[cfg(debug_assertions)]
pub fn snapshot() -> Option<serde_json::Value> {
    let mut child = CHILD.lock().unwrap();
    let child = child.as_mut()?;
    if child.try_wait().ok()?.is_some() {
        return None;
    }
    let report = REPORT.lock().unwrap();
    let (pid, value) = report.as_ref()?;
    if *pid != child.id() {
        return None;
    }
    let mut value = value.clone();
    value["visible"] = true.into();
    value["margin"] = 24.into();
    Some(value)
}
pub fn run() -> Result<()> {
    let argument = std::env::args().nth(2).context("Missing overlay monitor")?;
    ensure!(argument.len() < 4096, "Invalid overlay monitor");
    let target: Monitor = serde_json::from_str(&argument)?;
    gtk::init().map_err(|e| anyhow::anyhow!("Overlay display unavailable: {e}"))?;
    let display = gtk::gdk::Display::default().context("Overlay display unavailable")?;
    ensure!(
        display.type_().name().contains("X11"),
        "The overlay requires X11 positioning"
    );
    let monitor = (0..display.n_monitors())
        .filter_map(|i| display.monitor(i))
        .filter(|m| target.name.is_some() && m.model().as_deref() == target.name.as_deref())
        .min_by_key(|m| {
            let area = m.geometry();
            let x = i64::from(area.x()) * i64::from(m.scale_factor()) - i64::from(target.x);
            let y = i64::from(area.y()) * i64::from(m.scale_factor()) - i64::from(target.y);
            x * x + y * y
        })
        .or_else(|| display.monitor_at_point(target.x, target.y))
        .or_else(|| display.primary_monitor())
        .context("Overlay monitor unavailable")?;
    let loader = gtk::gdk_pixbuf::PixbufLoader::with_type("png")?;
    loader.write(include_bytes!("../assets/launch-overlay.png"))?;
    loader.close()?;
    let image = loader
        .pixbuf()
        .and_then(|p| p.scale_simple(236, 100, gtk::gdk_pixbuf::InterpType::Bilinear))
        .context("Overlay artwork unavailable")?;
    let window = gtk::Window::new(gtk::WindowType::Popup);
    window.set_title("Tia Game Library");
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_accept_focus(false);
    window.set_focus_on_map(false);
    window.set_keep_above(true);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    window.set_type_hint(gtk::gdk::WindowTypeHint::Notification);
    window.add(&gtk::Image::from_pixbuf(Some(&image)));
    anchor(&window, &monitor);
    window.connect_realize(|window| {
        if let Some(surface) = window.window() {
            surface.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
        }
    });
    window.show_all();
    anchor(&window, &monitor);
    let weak = window.downgrade();
    monitor.connect_workarea_notify(move |monitor| {
        if let Some(window) = weak.upgrade() {
            anchor(&window, monitor);
        }
    });
    let weak = window.downgrade();
    monitor.connect_geometry_notify(move |monitor| {
        if let Some(window) = weak.upgrade() {
            anchor(&window, monitor);
        }
    });
    let weak = window.downgrade();
    monitor.connect_scale_factor_notify(move |monitor| {
        if let Some(window) = weak.upgrade() {
            anchor(&window, monitor);
        }
    });
    let placed = window.clone();
    gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(100), move || {
        anchor(&placed, &monitor);
        let area = monitor.workarea();
        let (actual_x, actual_y) = placed.position();
        let (width, height) = placed.size();
        println!(
            "{}",
            serde_json::json!({"ready":true,"x":actual_x,"y":actual_y,"width":width,"height":height,"right":area.x()+area.width(),"bottom":area.y()+area.height()})
        );
    });
    gtk::glib::timeout_add_local_once(std::time::Duration::from_secs(3), gtk::main_quit);
    gtk::main();
    Ok(())
}

fn anchor(window: &gtk::Window, monitor: &gtk::gdk::Monitor) {
    let area = monitor.workarea();
    let (x, y) = crate::placement::bottom_right(
        (area.x(), area.y()),
        (area.width().max(0) as u32, area.height().max(0) as u32),
        (236, 100),
        24,
    );
    window.move_(x, y);
}
