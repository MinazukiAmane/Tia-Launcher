#[cfg(feature = "desktop")]
use crate::game::engine::Engine;
#[cfg(feature = "desktop")]
use anyhow::{Context, Result, bail};
#[cfg(feature = "desktop")]
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
#[cfg(feature = "desktop")]
use std::sync::Arc;

#[derive(Debug, PartialEq)]
pub enum Plan {
    Windows(PathBuf),
    AppImage(PathBuf),
    Mac(PathBuf),
    Package(&'static str),
    Manual,
}
pub fn plan(
    executable: &Path,
    appimage: Option<&Path>,
    package: Option<&str>,
    platform: &str,
) -> Plan {
    match platform {
        "windows" => {
            let parent = executable.parent().unwrap_or(executable);
            ["Uninstall Tia Launcher.exe", "uninstall.exe"]
                .into_iter()
                .map(|name| parent.join(name))
                .find(|path| path.is_file())
                .map(Plan::Windows)
                .unwrap_or(Plan::Manual)
        }
        "macos" => executable
            .ancestors()
            .find(|path| path.extension().is_some_and(|s| s == "app"))
            .map(|path| Plan::Mac(path.into()))
            .unwrap_or(Plan::Manual),
        _ => {
            if let Some(path) = appimage.filter(|p| {
                p.is_absolute()
                    && p.extension()
                        .is_some_and(|s| s.eq_ignore_ascii_case("AppImage"))
            }) {
                Plan::AppImage(path.into())
            } else {
                match package {
                    Some("pacman") => Plan::Package("pacman"),
                    Some("deb") => Plan::Package("deb"),
                    Some("nix") => Plan::Package("nix"),
                    _ => Plan::Manual,
                }
            }
        }
    }
}
#[cfg(feature = "desktop")]
pub async fn run(app: &tauri::AppHandle, engine: &Arc<Engine>, remove_data: bool) -> Result<Value> {
    use tauri::Manager;
    let _operation = engine.control.acquire()?;
    if cfg!(debug_assertions) || app.config().identifier.ends_with(".preview") {
        return Ok(
            json!({"started":false,"message":"Use your system's app manager to remove this preview."}),
        );
    }
    if remove_data {
        let directory = engine.store.lock().unwrap().directory.clone();
        crate::uninstall_data::validate(&directory, &crate::uninstall_data::expected(&directory)?)?;
    }
    if crate::system_package::nix_managed() {
        return Ok(
            json!({"started":false,"message":"Remove Tia Launcher from your Nix configuration or profile, then rebuild. Your games and saved settings will stay in place."}),
        );
    }
    let executable = std::env::current_exe()?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let marker = app.path().resource_dir()?.join("package-type");
    let package = tokio::fs::read_to_string(marker).await.ok();
    let plan = plan(
        &executable,
        appimage.as_deref(),
        package.as_deref().map(str::trim),
        std::env::consts::OS,
    );
    match plan {
        Plan::Manual => {
            return Ok(
                json!({"started":false,"message":"Remove Tia Launcher using your system's app manager. Your game files will stay in place."}),
            );
        }
        Plan::Windows(path) => {
            if remove_data {
                let directory = engine.store.lock().unwrap().directory.clone();
                crate::uninstall_data::validate(
                    &directory,
                    &crate::uninstall_data::expected(&directory)?,
                )?;
            }
            #[cfg(windows)]
            windows_start(&path, remove_data)?;
            #[cfg(not(windows))]
            {
                let _ = (path, remove_data);
                bail!("The Windows uninstaller cannot run on this platform.")
            }
        }
        Plan::Package(kind) => {
            let args = if kind == "pacman" {
                vec!["pacman", "-R", "--noconfirm", "tia-launcher"]
            } else {
                vec!["apt-get", "remove", "-y", "tia-launcher"]
            };
            let status = tokio::process::Command::new("pkexec")
                .args(args)
                .stdin(std::process::Stdio::null())
                .status()
                .await
                .context("Install polkit to remove this package from the launcher")?;
            if !status.success() {
                bail!(
                    "Uninstall was canceled or could not finish. Your launcher data has been kept."
                )
            }
        }
        Plan::AppImage(path) => {
            tokio::fs::remove_file(path).await?;
        }
        Plan::Mac(path) => {
            let status = tokio::process::Command::new("/usr/bin/osascript")
                .args([
                    "-e",
                    "on run argv",
                    "-e",
                    "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
                    "-e",
                    "end run",
                    "--",
                ])
                .arg(path)
                .status()
                .await?;
            if !status.success() {
                bail!("The launcher could not be moved to Trash. Your saved data has been kept.")
            }
        }
    }
    if remove_data && !cfg!(windows) {
        let directory = engine.store.lock().unwrap().directory.clone();
        crate::uninstall_data::cleanup(&directory)?;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        handle.exit(0);
    });
    Ok(json!({"started":true,"message":"Removal has started. Your game files will stay in place."}))
}

#[cfg(all(windows, feature = "desktop"))]
fn windows_start(path: &Path, remove_data: bool) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let args: Vec<u16> = (if remove_data {
        crate::uninstall_data::REMOVE_DATA_FLAG
    } else {
        ""
    })
    .encode_utf16()
    .chain(Some(0))
    .collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            path.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        bail!("The uninstaller was canceled or could not start. Your saved data has been kept.")
    }
    Ok(())
}
