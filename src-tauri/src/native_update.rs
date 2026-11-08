use crate::game::engine::Engine;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::Emitter;
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    enabled: bool,
    endpoints: Vec<String>,
    public_key: String,
}
#[cfg(debug_assertions)]
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestConfiguration {
    pub configuration: serde_json::Value,
    pub report: std::path::PathBuf,
    pub expect: String,
    pub version: String,
}
#[cfg(debug_assertions)]
pub fn test_configuration() -> Result<Option<TestConfiguration>> {
    let arguments: Vec<_> = std::env::args_os().collect();
    let Some(index) = arguments
        .iter()
        .position(|arg| arg == "--native-update-test")
    else {
        return Ok(None);
    };
    let file = std::path::Path::new(
        arguments
            .get(index + 1)
            .context("Missing native update test configuration")?,
    );
    if std::fs::metadata(file)?.len() > 16384 {
        bail!("Test configuration is too large.")
    }
    let test: TestConfiguration = serde_json::from_slice(&std::fs::read(file)?)?;
    let config: Configuration = serde_json::from_value(test.configuration.clone())?;
    if !config.enabled || config.endpoints.len() != 1 || config.public_key.is_empty() {
        bail!("Invalid test update configuration.")
    }
    let endpoint = url::Url::parse(&config.endpoints[0])?;
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.port() != Some(18479)
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        bail!("Only the isolated loopback feed is allowed for native updater tests.")
    }
    if !matches!(test.expect.as_str(), "download" | "reject" | "install")
        || !test.report.is_absolute()
        || test
            .report
            .parent()
            .map(std::fs::canonicalize)
            .transpose()?
            != file.parent().map(std::fs::canonicalize).transpose()?
    {
        bail!("Invalid test report destination.")
    }
    Ok(Some(test))
}
fn configuration(app: &tauri::AppHandle) -> Result<(Configuration, bool)> {
    #[cfg(debug_assertions)]
    if let Some(test) = test_configuration()? {
        return Ok((serde_json::from_value(test.configuration)?, true));
    }
    if app.config().identifier.ends_with(".preview") {
        return Ok((
            Configuration {
                enabled: false,
                endpoints: Vec::new(),
                public_key: String::new(),
            },
            false,
        ));
    }
    Ok((
        serde_json::from_str(include_str!("../native-updates.json"))?,
        false,
    ))
}
pub struct NativeUpdate {
    state: Mutex<Value>,
    pending: Mutex<Option<Update>>,
    download: Mutex<Option<Vec<u8>>>,
    checking: AtomicBool,
}
impl Default for NativeUpdate {
    fn default() -> Self {
        Self {
            state: Mutex::new(
                json!({"versionStatus":"checking","available":null,"progress":null,"downloaded":false,"downloading":false,"downloadProgress":null,"error":null}),
            ),
            pending: Mutex::new(None),
            download: Mutex::new(None),
            checking: AtomicBool::new(false),
        }
    }
}
fn emit(app: &tauri::AppHandle, event: &str, value: Value) {
    let _ = app.emit(event, value);
}
impl NativeUpdate {
    pub fn snapshot(&self) -> Value {
        self.state.lock().unwrap().clone()
    }
    fn publish(&self, app: &tauri::AppHandle) {
        emit(app, "update-state", self.snapshot());
    }
    fn failure(&self, app: &tauri::AppHandle, error: &str) {
        let mut state = self.state.lock().unwrap();
        if state["available"].is_null() {
            state["versionStatus"] = json!("failed");
        }
        state["downloading"] = json!(false);
        state["error"] = json!(error);
        drop(state);
        emit(app, "update-error", json!(error));
        self.publish(app);
    }
    pub async fn check(&self, app: &tauri::AppHandle, engine: &Engine) -> Result<()> {
        if self
            .checking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let result = async {
            if crate::system_package::nix_managed() {
                let mut state = self.state.lock().unwrap();
                *state = json!({"versionStatus":"current","available":null,"progress":null,"downloaded":false,"downloading":false,"downloadProgress":null,"error":null,"managedBy":"nix"});
                drop(state);
                engine.record("updater: updates managed by Nix");
                self.publish(app);
                return Ok(());
            }
            let current = self.snapshot();
            if current["downloading"] == true || current["downloaded"] == true {
                return Ok(());
            }
            let (config, test) = configuration(app)?;
            if !config.enabled {
                bail!("Native updates are not configured for this preview.")
            }
            if config.endpoints.is_empty() || config.public_key.trim().is_empty() {
                bail!("The native update configuration is incomplete.")
            }
            let mut endpoints = Vec::new();
            for endpoint in config.endpoints {
                let url = url::Url::parse(&endpoint)?;
                if (url.scheme() != "https"
                    && !(test
                        && url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(18479)))
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    bail!("The native update address is invalid.")
                }
                endpoints.push(url);
            }
            let builder = app
                .updater_builder()
                .endpoints(endpoints)?
                .pubkey(config.public_key)
                .timeout(std::time::Duration::from_secs(15));
            #[cfg(windows)]
            let builder = builder
                .installer_args(windows_install_arguments(test)?)
                .restart_after_install(!test);
            #[cfg(target_os = "linux")]
            let builder = if package_kind(app).as_deref() == Some("pacman") {
                builder.target(format!("linux-{}-pacman", std::env::consts::ARCH))
            } else {
                builder
            };
            let update = builder.build()?.check().await?;
            let mut state = self.state.lock().unwrap();
            state["error"] = Value::Null;
            if let Some(update) = update {
                crate::game::transfer::validate_url(update.download_url.as_str())?;
                if update.download_url.scheme() != "https"
                    && !(test
                        && update.download_url.scheme() == "http"
                        && update.download_url.host_str() == Some("127.0.0.1")
                        && update.download_url.port() == Some(18479))
                {
                    bail!("The native update download address is invalid.")
                }
                state["versionStatus"] = json!("required");
                state["available"] = json!({"version":update.version,"isInitialCheck":true});
                emit(app, "update-available", state["available"].clone());
                *self.pending.lock().unwrap() = Some(update);
            } else {
                state["versionStatus"] = json!("current");
                state["available"] = Value::Null;
                *self.pending.lock().unwrap() = None;
                emit(app, "update-not-available", Value::Null);
            }
            drop(state);
            self.publish(app);
            Ok::<_, anyhow::Error>(())
        }
        .await;
        self.checking.store(false, Ordering::SeqCst);
        if let Err(error) = &result {
            engine.record(&format!("updater: check failed: {error}"));
            self.failure(app, &error.to_string());
        }
        result
    }
    pub async fn download(&self, app: &tauri::AppHandle, engine: &Arc<Engine>) -> Result<()> {
        let _operation = engine.control.acquire()?;
        let update = self
            .pending
            .lock()
            .unwrap()
            .clone()
            .context("Check for a launcher update first")?;
        if self.download.lock().unwrap().is_some() {
            return Ok(());
        }
        {
            let mut state = self.state.lock().unwrap();
            state["downloading"] = json!(true);
            state["error"] = Value::Null;
        }
        self.publish(app);
        let mut transferred = 0u64;
        let start = std::time::Instant::now();
        let mut last = std::time::Instant::now();
        let bytes=update.download(|chunk,total|{
            transferred=transferred.saturating_add(chunk as u64);
            if last.elapsed()<std::time::Duration::from_millis(100) && total!=Some(transferred){return}
            last=std::time::Instant::now();let total=total.unwrap_or(0);
            let progress=json!({"percent":if total==0{0.0}else{(transferred as f64/total as f64*100.0).min(100.0)},"transferred":transferred,"total":total,"bytesPerSecond":transferred as f64/start.elapsed().as_secs_f64().max(0.001),"updatedAt":chrono::Utc::now().timestamp_millis()});
            {let mut state=self.state.lock().unwrap();state["progress"]=progress["percent"].clone();state["downloadProgress"]=progress.clone();}
            emit(app,"update-download-progress",progress);self.publish(app);
        },||{}).await;
        match bytes {
            Ok(bytes) => {
                *self.download.lock().unwrap() = Some(bytes);
                let mut state = self.state.lock().unwrap();
                state["downloading"] = json!(false);
                state["downloaded"] = json!(true);
                state["progress"] = json!(100);
                drop(state);
                emit(app, "update-downloaded", Value::Null);
                self.publish(app);
                Ok(())
            }
            Err(error) => {
                engine.record(&format!("updater: download failed: {error}"));
                self.failure(
                    app,
                    "The launcher update could not be downloaded or verified. Please retry.",
                );
                Err(error.into())
            }
        }
    }
    pub fn install(&self, app: &tauri::AppHandle, engine: &Arc<Engine>) -> Result<()> {
        let _operation = engine.control.acquire()?;
        let update = self
            .pending
            .lock()
            .unwrap()
            .clone()
            .context("Check for a launcher update first")?;
        let bytes = self
            .download
            .lock()
            .unwrap()
            .take()
            .context("Download the launcher update first")?;
        #[cfg(target_os = "linux")]
        let installed: Result<()> = if package_kind(app).as_deref() == Some("pacman") {
            crate::package_update::install_pacman(app, &bytes, &update.signature, &update.version)
        } else {
            update.install(&bytes).map_err(Into::into)
        };
        #[cfg(not(target_os = "linux"))]
        let installed = update.install(&bytes);
        match installed {
            Ok(()) => app.restart(),
            Err(error) => {
                *self.download.lock().unwrap() = Some(bytes);
                self.failure(
                    app,
                    "The launcher update could not be installed. Please retry.",
                );
                Err(error.into())
            }
        }
    }
}
#[cfg(windows)]
fn windows_install_arguments(test: bool) -> Result<Vec<std::ffi::OsString>> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY,
        RRF_SUBKEY_WOW6464KEY, RegGetValueW,
    };
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    let directory = executable.parent().context("Missing launcher directory")?;
    let guid = if test && cfg!(debug_assertions) {
        "4d6c4dce-8498-543d-b9ba-7708982fb33a"
    } else {
        "9740b805-18aa-59a9-80e6-10324b8f739e"
    };
    let subkey: Vec<u16> = format!("Software\\{guid}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = "InstallLocation".encode_utf16().chain(Some(0)).collect();
    let mut matches = std::collections::HashSet::new();
    for (root, scope) in [
        (HKEY_CURRENT_USER, "/currentuser"),
        (HKEY_LOCAL_MACHINE, "/allusers"),
    ] {
        for view in [RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY] {
            let mut buffer = vec![0u16; 32768];
            let mut size = (buffer.len() * 2) as u32;
            let status = unsafe {
                RegGetValueW(
                    root,
                    subkey.as_ptr(),
                    name.as_ptr(),
                    RRF_RT_REG_SZ | view,
                    std::ptr::null_mut(),
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if status != 0 || size < 2 || size as usize > buffer.len() * 2 || size % 2 != 0 {
                continue;
            }
            let length = buffer.iter().position(|n| *n == 0).unwrap_or(buffer.len());
            let path = String::from_utf16(&buffer[..length])?;
            if std::fs::canonicalize(path).ok().as_deref() == Some(directory) {
                matches.insert(scope);
            }
        }
    }
    if matches.len() != 1 {
        bail!(
            "The launcher installation scope could not be confirmed. Reinstall it in the same location before updating."
        )
    }
    let text = directory.to_str().context("Unsupported launcher path")?;
    let text = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
    };
    if text.contains(['"', '\r', '\n']) {
        bail!("Unsupported launcher path.")
    }
    Ok(vec![
        matches.into_iter().next().unwrap().into(),
        format!("/D={text}").into(),
    ])
}

#[cfg(target_os = "linux")]
fn package_kind(app: &tauri::AppHandle) -> Option<String> {
    let marker = app.path().resource_dir().ok()?.join("package-type");
    std::fs::read_to_string(marker)
        .ok()
        .map(|s| s.trim().to_owned())
}
