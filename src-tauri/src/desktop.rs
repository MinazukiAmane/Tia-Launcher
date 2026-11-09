use crate::{keystore, store::Store};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub struct State {
    pub store: Arc<Mutex<Store>>,
    pub engine: Arc<crate::game::engine::Engine>,
    pub catalog: Value,
    pub feeds: crate::feeds::Feeds,
    pub updater: crate::native_update::NativeUpdate,
    #[cfg(target_os = "linux")]
    pub video_stream: crate::video_stream::VideoStream,
    pub media_candidate: Mutex<Option<crate::media::Candidate>>,
}
fn selected(state: &State) -> Result<String> {
    let value = state
        .store
        .lock()
        .unwrap()
        .get("launcher", "selectedGame")?;
    Ok(value
        .and_then(|v| v.as_str().map(String::from))
        .filter(|biz| {
            state.catalog["games"]
                .as_array()
                .unwrap()
                .iter()
                .any(|g| g["biz"] == *biz)
        })
        .unwrap_or_else(|| "csore_global".into()))
}
fn game(state: &State) -> Result<Value> {
    let biz = selected(state)?;
    Ok(state.catalog["games"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["biz"] == biz)
        .unwrap()
        .clone())
}
fn preference_scope(biz: &str) -> String {
    if biz == "csore_global" {
        "launcher".into()
    } else {
        format!("title:{biz}")
    }
}
fn settings(state: &State) -> Result<Value> {
    let mut result = json!({"lang":"na_en","classicUi":false,"alternateRenderer":false,"fpsLimit":null,"downloadSpeedLimitKbps":null,"launchCommand":null,"troubleshootingMode":false,"windowCloseBehavior":"exit","customBackground":null,"customVideo":null});
    let store = state.store.lock().unwrap();
    if let Some(Value::Object(saved)) = store.get("launcher", "settings")? {
        for (k, v) in saved {
            result[k] = v
        }
    }
    drop(store);
    let biz = selected(state)?;
    if biz != "csore_global" {
        if let Some(Value::Object(saved)) = state
            .store
            .lock()
            .unwrap()
            .get(&preference_scope(&biz), "launchOptions")?
        {
            for (k, v) in saved {
                result[k] = v
            }
        }
    }
    Ok(result)
}
fn selected_dir(state: &State) -> Result<Option<String>> {
    let scope = preference_scope(&selected(state)?);
    Ok(state
        .store
        .lock()
        .unwrap()
        .get(&scope, "selectedInstallation")?
        .and_then(|v| v["installDir"].as_str().map(String::from)))
}
fn approved(state: &State, directory: &str) -> Result<PathBuf> {
    let requested = std::fs::canonicalize(directory)?;
    let saved = selected_dir(state)?
        .ok_or_else(|| anyhow::anyhow!("Choose an installation folder first."))?;
    if std::fs::canonicalize(saved)? != requested {
        bail!("Choose an installation folder first.")
    }
    Ok(requested)
}
fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
fn emit(app: &tauri::AppHandle, event: &str, value: Value) {
    let _ = app.emit(&event.replace(':', "-"), value);
}

#[tauri::command]
async fn launcher_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<State>>,
    channel: String,
    args: Vec<Value>,
) -> std::result::Result<Value, String> {
    if window.label() != "main" {
        return Err("Untrusted window.".into());
    }
    let result = request(&window, &app, state.inner().clone(), &channel, args).await;
    if let Err(error) = &result {
        state
            .engine
            .record(&format!("IPC request failed: {channel}: {error}"));
    }
    result.map_err(|error| error.to_string())
}

async fn request(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
    state: Arc<State>,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value> {
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    if state.updater.snapshot()["versionStatus"] == "required"
        && matches!(
            channel,
            "game:launch"
                | "game:startInstallOrUpdate"
                | "game:repairInstall"
                | "game:verifyInstall"
                | "game:moveInstallation"
                | "game:uninstall"
                | "game:select"
                | "game:setSettings"
                | "launcher:chooseBackground"
                | "launcher:chooseBackgroundVideo"
        )
    {
        bail!("Update the launcher before continuing.");
    }
    if [
        "game:setSettings",
        "launcher:setPreferences",
        "launcher:migrateLegacyPreferences",
        "launcher:clearBackground",
        "launcher:clearBackgroundVideo",
    ]
    .contains(&channel)
        && (state.engine.control.busy.load(Ordering::SeqCst)
            || state.engine.control.running.load(Ordering::SeqCst))
    {
        bail!("Wait for the current operation or close the game first.")
    }

    match channel {
        "launcher:ready" => {
            crate::startup_ack::acknowledge()?;
            Ok(Value::Null)
        }
        "preview:nativeUpdateTest" => {
            #[cfg(debug_assertions)]
            if let Some(test) = crate::native_update::test_configuration()? {
                return Ok(json!({"expect":test.expect,"version":test.version}));
            }
            bail!("Unavailable command.")
        }
        "preview:nativeUpdateReport" => {
            #[cfg(debug_assertions)]
            if let Some(test) = crate::native_update::test_configuration()? {
                let report = arg(0);
                tokio::fs::write(test.report, serde_json::to_vec_pretty(&report)?).await?;
                if report["stage"] != "verified-ready" {
                    app.exit(if report["ok"] == true { 0 } else { 1 });
                }
                return Ok(Value::Null);
            }
            bail!("Unavailable command.")
        }
        "preview:overlayCheck" => {
            if !cfg!(debug_assertions) || !std::env::args().any(|arg| arg == "--smoke-test") {
                bail!("Unavailable command.")
            }
            let handle = app.clone();
            let (send, receive) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let _ = send.send(crate::overlay::show(&handle).map_err(|e| e.to_string()));
            })?;
            receive.await?.map_err(anyhow::Error::msg)?;
            #[cfg(all(target_os = "linux", debug_assertions))]
            if app.get_webview_window("launch-overlay").is_none() {
                for _ in 0..80 {
                    if let Some(snapshot) = crate::overlay_linux::snapshot() {
                        return Ok(snapshot);
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                bail!("The native overlay did not become ready");
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            let overlay = app
                .get_webview_window("launch-overlay")
                .ok_or_else(|| anyhow::anyhow!("Overlay was not created"))?;
            let position = overlay.outer_position()?;
            let monitor = overlay
                .current_monitor()?
                .ok_or_else(|| anyhow::anyhow!("Overlay monitor unavailable"))?;
            let area = monitor.work_area();
            let size = overlay.outer_size()?;
            Ok(
                json!({"visible":overlay.is_visible()?,"x":position.x,"y":position.y,"width":size.width,"height":size.height,"margin":(24.0*monitor.scale_factor()).round() as i32,"right":area.position.x+area.size.width as i32,"bottom":area.position.y+area.size.height as i32}),
            )
        }
        "preview:smokeReport" => {
            if !cfg!(debug_assertions) || !std::env::args().any(|arg| arg == "--smoke-test") {
                bail!("Unavailable command.")
            }
            println!("{}", arg(0));
            if arg(0).get("ok").is_some() {
                app.exit(if arg(0)["ok"] == true { 0 } else { 1 });
            }
            Ok(Value::Null)
        }
        "ping" => Ok(json!("pong")),
        "app:getPlatform" => Ok(json!(platform())),
        "app:getVersion" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "app:getUserDataDir" => Ok(json!(state.store.lock().unwrap().directory)),
        "game:catalog" => Ok(json!({"games":state.catalog["games"],"selected":selected(&state)?})),
        "game:select" => {
            if state.engine.control.busy.load(Ordering::SeqCst)
                || state.engine.control.running.load(Ordering::SeqCst)
            {
                bail!("Close the game and finish the current operation first.")
            }
            let biz = arg(0);
            let chosen = state.catalog["games"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["biz"] == biz)
                .ok_or_else(|| anyhow::anyhow!("Unknown game."))?
                .clone();
            state
                .store
                .lock()
                .unwrap()
                .put("launcher", "selectedGame", &biz)?;
            Ok(chosen)
        }
        "launcher:getPreferences" => {
            let biz = selected(&state)?;
            crate::preferences::read(&state.store.lock().unwrap(), &biz)
        }
        "launcher:setPreferences" | "launcher:migrateLegacyPreferences" => {
            let biz = selected(&state)?;
            let prior = crate::preferences::read(&state.store.lock().unwrap(), &biz)?;
            let value = crate::preferences::merge(
                prior.clone(),
                &arg(0),
                channel == "launcher:migrateLegacyPreferences",
            )?;
            if value["confirmedInstallDir"] != prior["confirmedInstallDir"]
                && !value["confirmedInstallDir"].is_null()
            {
                approved(&state, value["confirmedInstallDir"].as_str().unwrap())?;
            }
            crate::preferences::write(&state.store.lock().unwrap(), &biz, &value)?;
            Ok(value)
        }
        "game:getSettings" => settings(&state),
        "game:setSettings" => {
            let incoming = arg(0);
            let mut saved = settings(&state)?;
            for name in ["classicUi", "alternateRenderer", "troubleshootingMode"] {
                if let Some(value) = incoming.get(name) {
                    if !value.is_boolean() {
                        bail!("Invalid game settings.")
                    }
                    saved[name] = value.clone()
                }
            }
            if let Some(lang) = incoming.get("lang") {
                if lang != "na_id" && lang != "na_en" {
                    bail!("Invalid game language.")
                }
                saved["lang"] = lang.clone()
            }
            if let Some(fps) = incoming.get("fpsLimit") {
                if !fps.is_null() && ![Some(144), Some(165), Some(240)].contains(&fps.as_u64()) {
                    bail!("Invalid FPS limit.")
                }
                saved["fpsLimit"] = fps.clone()
            }
            if let Some(speed) = incoming.get("downloadSpeedLimitKbps") {
                if !speed.is_null() && !speed.as_u64().is_some_and(|n| (100..=20480).contains(&n)) {
                    bail!("Invalid download limit.")
                }
                saved["downloadSpeedLimitKbps"] = speed.clone()
            }
            if let Some(cmd) = incoming.get("launchCommand") {
                if !cmd.is_null()
                    && !cmd
                        .as_str()
                        .is_some_and(|s| s.len() <= 500 && !s.chars().any(|c| c.is_control()))
                {
                    bail!("Invalid launch command.")
                }
                saved["launchCommand"] = cmd.clone()
            }
            if let Some(close) = incoming.get("windowCloseBehavior") {
                if close != "exit" && close != "minimize_to_tray" {
                    bail!("Invalid close behavior.")
                }
                saved["windowCloseBehavior"] = close.clone()
            }
            let biz = selected(&state)?;
            let store = state.store.lock().unwrap();
            if biz != "csore_global" {
                let mut options = json!({});
                for key in [
                    "lang",
                    "classicUi",
                    "alternateRenderer",
                    "launchCommand",
                    "fpsLimit",
                ] {
                    options[key] = saved[key].clone()
                }
                store.put(&preference_scope(&biz), "launchOptions", &options)?;
            }
            if biz != "csore_global" {
                let global=store.get("launcher","settings")?.unwrap_or_else(||json!({"lang":"na_en","classicUi":false,"alternateRenderer":false,"fpsLimit":null,"launchCommand":null}));
                for key in [
                    "lang",
                    "classicUi",
                    "alternateRenderer",
                    "launchCommand",
                    "fpsLimit",
                ] {
                    saved[key] = global[key].clone()
                }
            }
            store.put("launcher", "settings", &saved)?;
            Ok(Value::Null)
        }
        "game:getSelectedInstallDir" => Ok(json!(selected_dir(&state)?)),
        "game:getInstallState" => {
            let root = approved(&state, arg(0).as_str().unwrap_or(""))?;
            let definition: crate::game::model::Definition = serde_json::from_value(game(&state)?)?;
            let record = state.engine.selected_state(&root, &definition).await?;
            let pending = state
                .store
                .lock()
                .unwrap()
                .get(&crate::paths::scope(&root)?, "pendingAudio")?
                .is_some_and(|v| !v.is_null());
            Ok(record.map(|install|json!({"version":install.version,"installDir":crate::paths::user_path(&root),"pendingAudioPatch":pending,"needsRepair":install.needs_repair})).unwrap_or(Value::Null))
        }
        "game:verifyInstall"
        | "game:startInstallOrUpdate"
        | "game:repairInstall"
        | "game:launch" => {
            let root = approved(&state, arg(0).as_str().unwrap_or(""))?;
            let definition: crate::game::model::Definition = serde_json::from_value(game(&state)?)?;
            let handle = app.clone();
            let progress: crate::game::Progress = Arc::new(move |phase, processed, total| {
                emit(
                    &handle,
                    "game:progress",
                    json!({"phase":phase,"processed":processed,"total":total}),
                );
            });
            match channel {
                "game:verifyInstall" => Ok(serde_json::to_value(
                    state.engine.verify(&root, &definition, false).await?,
                )?),
                "game:startInstallOrUpdate" => Ok(serde_json::to_value(
                    state.engine.update(&root, &definition, progress).await?,
                )?),
                "game:repairInstall" => Ok(serde_json::to_value(
                    state.engine.repair(&root, &definition, progress).await?,
                )?),
                _ => {
                    let (result, session) = state
                        .engine
                        .play(&root, &definition, &settings(&state)?, progress)
                        .await?;
                    if let Some(mut session) = session {
                        let app = app.clone();
                        let engine = state.engine.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            let handle = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                let _ = crate::overlay::show(&handle);
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.destroy();
                                }
                            });
                            let status = session.child.wait().await;
                            engine.record(&format!("launch: client runtime exited: {status:?}"));
                            engine.control.running.store(false, Ordering::SeqCst);
                            let _ = tokio::fs::remove_dir_all(session.staging).await;
                            restore_window(&app);
                        });
                    }
                    Ok(serde_json::to_value(result)?)
                }
            }
        }
        "game:moveInstallation" => {
            let root = approved(&state, arg(0).as_str().unwrap_or(""))?;
            if state.engine.control.busy.load(Ordering::SeqCst)
                || state.engine.control.running.load(Ordering::SeqCst)
            {
                bail!("Close the game and finish the current operation first.")
            }
            let chosen = app
                .dialog()
                .file()
                .set_title("Move game — choose an empty destination folder")
                .blocking_pick_folder();
            let Some(chosen) = chosen else {
                return Ok(Value::Null);
            };
            let definition = serde_json::from_value(game(&state)?)?;
            let handle = app.clone();
            let progress: crate::game::Progress = Arc::new(move |phase, processed, total| {
                emit(
                    &handle,
                    "game:moveProgress",
                    json!({"phase":phase,"processed":processed,"total":total}),
                )
            });
            state
                .engine
                .move_installation(
                    &root,
                    &chosen.into_path()?,
                    &definition,
                    &preference_scope(&selected(&state)?),
                    progress,
                )
                .await
        }
        "game:uninstall" => {
            let root = approved(&state, arg(0).as_str().unwrap_or(""))?;
            let definition = serde_json::from_value(game(&state)?)?;
            state
                .engine
                .uninstall_game(&root, &definition, &preference_scope(&selected(&state)?))
                .await?;
            Ok(Value::Null)
        }
        "game:clearDownloadCache" => {
            let _operation = state.engine.control.acquire()?;
            let root = approved(&state, arg(0).as_str().unwrap_or(""))?;
            let cache = crate::paths::within(&root, ".csore_download_tmp")?;
            if cache.exists() {
                tokio::fs::remove_dir_all(cache).await?;
            }
            state.store.lock().unwrap().put(
                &crate::paths::scope(&root)?,
                "checkpoint",
                &Value::Null,
            )?;
            Ok(Value::Null)
        }
        "game:chooseInstallFolder" => {
            if state.engine.control.busy.load(Ordering::SeqCst)
                || state.engine.control.running.load(Ordering::SeqCst)
            {
                bail!("Close the game and finish the current operation first.")
            }
            let chosen = app
                .dialog()
                .file()
                .set_title("Choose game installation folder")
                .blocking_pick_folder();
            let Some(chosen) = chosen else {
                return Ok(Value::Null);
            };
            let chosen = chosen.into_path()?;
            let definition = game(&state)?;
            let prior = selected_dir(&state)?;
            let legacy = definition["biz"] == "csore_global"
                && chosen.file_name().is_some_and(|n| {
                    n.to_string_lossy()
                        .eq_ignore_ascii_case("Counter-Strike Online Re-Server Edition")
                });
            let keep = legacy
                || chosen.file_name().is_some_and(|n| {
                    n.to_string_lossy() == definition["installFolder"].as_str().unwrap_or("")
                })
                || prior.as_ref().is_some_and(|p| Path::new(p) == chosen);
            let directory = if keep {
                chosen
            } else {
                chosen.join(definition["installFolder"].as_str().unwrap())
            };
            std::fs::create_dir_all(&directory)?;
            let directory = crate::paths::user_path(&std::fs::canonicalize(directory)?);
            let preference = preference_scope(&selected(&state)?);
            state.store.lock().unwrap().put(
                &preference,
                "selectedInstallation",
                &json!({"installDir":directory}),
            )?;
            Ok(json!(directory))
        }
        "game:getLauncherInfo" => Ok(serde_json::to_value(
            state.engine.metadata(&selected(&state)?, false).await?,
        )?),
        "game:serverStatus" => Ok(state
            .feeds
            .status(
                &state.engine,
                settings(&state)?["launchCommand"].as_str().unwrap_or(""),
            )
            .await),
        "news:get" => Ok(state.feeds.news(&state.engine).await),
        "silver-notices:get" => Ok(state.feeds.silver(&state.engine).await),
        "launcher:getSilverIntroduction" => {
            let choice = state
                .store
                .lock()
                .unwrap()
                .get("launcher", "silverPalaceIntroduction")?;
            Ok(
                json!({"eligible": !matches!(choice.as_ref().and_then(Value::as_str),Some("interested" | "dismissed"))}),
            )
        }
        "launcher:setSilverIntroductionChoice" => {
            if arg(0) != "interested" && arg(0) != "dismissed" {
                bail!("Invalid introduction choice.")
            }
            state
                .store
                .lock()
                .unwrap()
                .put("launcher", "silverPalaceIntroduction", &arg(0))?;
            Ok(Value::Null)
        }
        "launcher:videoSource" => {
            let value = arg(0);
            let source = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid video source"))?;
            let saved = settings(&state)?;
            let selected = crate::media::saved_path(&state.engine, &saved["customVideo"], true)?;
            let authorized = {
                let pending = state.media_candidate.lock().unwrap();
                crate::media_source::authorize(
                    source,
                    selected.as_deref(),
                    pending.as_ref().map(|candidate| candidate.path.as_path()),
                )?
            };
            #[cfg(target_os = "linux")]
            {
                match authorized {
                    crate::media_source::VideoSource::Builtin(identity) => {
                        if let Some(url) = state.video_stream.existing(&identity) {
                            return Ok(json!(url));
                        }
                        let handle = app.clone();
                        let asset_path = identity.clone();
                        let bytes =
                            tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
                                let asset =
                                    handle.asset_resolver().get(asset_path).ok_or_else(|| {
                                        anyhow::anyhow!("The built-in video is missing")
                                    })?;
                                anyhow::ensure!(
                                    asset.bytes.len() as u64 <= crate::media::VIDEO_LIMIT,
                                    "Video too large"
                                );
                                Ok(asset.bytes)
                            })
                            .await??;
                        Ok(json!(state.video_stream.bytes(bytes, &identity)))
                    }
                    crate::media_source::VideoSource::File(path) => {
                        Ok(json!(state.video_stream.file(path)))
                    }
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                match authorized {
                    crate::media_source::VideoSource::Builtin(path) => Ok(json!(path)),
                    crate::media_source::VideoSource::File(path) => Ok(json!(path)),
                }
            }
        }
        "launcher:getBackground" | "launcher:getBackgroundSources" => {
            let saved = settings(&state)?;
            let image = crate::media::saved_path(&state.engine, &saved["customBackground"], false)?;
            let video = crate::media::saved_path(&state.engine, &saved["customVideo"], true)?;
            for path in [image.as_ref(), video.as_ref()].into_iter().flatten() {
                app.asset_protocol_scope().allow_file(path)?;
            }
            if channel == "launcher:getBackground" {
                Ok(json!(image))
            } else {
                Ok(json!({"image":image,"video":video}))
            }
        }
        "launcher:uninstall" => {
            let remove_data = arg(0)
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("Invalid uninstall option."))?;
            crate::uninstall::run(app, &state.engine, remove_data).await
        }
        "launcher:chooseBackground" | "launcher:chooseBackgroundVideo" => {
            let operation = state.engine.control.acquire()?;
            let video = channel == "launcher:chooseBackgroundVideo";
            let chosen = app
                .dialog()
                .file()
                .add_filter(
                    if video { "Videos" } else { "Images" },
                    if video {
                        crate::media::VIDEOS
                    } else {
                        crate::media::IMAGES
                    },
                )
                .blocking_pick_file();
            let Some(chosen) = chosen else {
                return Ok(Value::Null);
            };
            let path = crate::media::prepare(&state.engine, &chosen.into_path()?, video).await?;
            app.asset_protocol_scope().allow_file(&path)?;
            if !video {
                if let Err(error) = crate::media::commit(&state.engine, &path, false) {
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(error);
                }
                return Ok(json!(path));
            }
            let token = format!("{:016x}", rand::random::<u64>());
            *state.media_candidate.lock().unwrap() = Some(crate::media::Candidate {
                token: token.clone(),
                path: path.clone(),
                converted: false,
                operation,
            });
            let pending = state.clone();
            let expires = token.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(180)).await;
                let mut candidate = pending.media_candidate.lock().unwrap();
                if candidate.as_ref().is_some_and(|c| c.token == expires) {
                    candidate.take();
                }
            });
            Ok(json!({"token":token,"path":path,"committed":false}))
        }
        "launcher:finishBackgroundVideo" | "launcher:discardBackgroundVideo" => {
            let token = arg(0);
            let mut candidate = {
                let mut pending = state.media_candidate.lock().unwrap();
                if !pending
                    .as_ref()
                    .is_some_and(|c| Some(c.token.as_str()) == token.as_str())
                {
                    bail!("Choose the video again. Its preview has expired.")
                }
                pending.take().unwrap()
            };
            if channel == "launcher:discardBackgroundVideo" {
                return Ok(Value::Null);
            }
            if arg(1) == true {
                crate::media::commit(&state.engine, &candidate.path, true)?;
                let path = candidate.path.clone();
                candidate.path.clear();
                return Ok(json!({"path":path,"committed":true}));
            }
            if candidate.converted {
                bail!("This video cannot play on this device. Try another video.")
            }
            let convert = app.dialog().message("This video cannot play directly. Convert a copy for the launcher? A conversion component will be downloaded if needed (up to 80 MB). Your original video stays unchanged.")
                .title("Convert this video?").buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel).blocking_show();
            if !convert {
                return Ok(Value::Null);
            }
            crate::media::convert(&state.engine, &mut candidate).await?;
            app.asset_protocol_scope().allow_file(&candidate.path)?;
            let result = json!({"token":candidate.token,"path":candidate.path,"committed":false});
            let token = candidate.token.clone();
            *state.media_candidate.lock().unwrap() = Some(candidate);
            let pending = state.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(180)).await;
                let mut candidate = pending.media_candidate.lock().unwrap();
                if candidate.as_ref().is_some_and(|c| c.token == token) {
                    candidate.take();
                }
            });
            Ok(result)
        }
        "launcher:clearBackground" | "launcher:clearBackgroundVideo" => {
            let _operation = state.engine.control.acquire()?;
            let mut saved = settings(&state)?;
            saved[if channel == "launcher:clearBackground" {
                "customBackground"
            } else {
                "customVideo"
            }] = Value::Null;
            state
                .store
                .lock()
                .unwrap()
                .put("launcher", "settings", &saved)?;
            crate::media::cleanup(
                &state.engine,
                channel == "launcher:clearBackgroundVideo",
                None,
            )?;
            Ok(Value::Null)
        }
        "shell:open-external" => {
            let value = arg(0);
            let url = url::Url::parse(value.as_str().unwrap_or(""))?;
            let host = url.host_str().unwrap_or("");
            if !["https", "http"].contains(&url.scheme())
                || !["cso-rse.my.id", "discord.gg", "tako.id", "github.com"].contains(&host)
            {
                bail!("External link is not allowed.")
            }
            if !url.username().is_empty() || url.password().is_some() {
                bail!("External link is not allowed.")
            }
            if host == "github.com"
                && (url.scheme() != "https"
                    || url.path().trim_end_matches('/') != "/Sikarugir-App/Sikarugir")
            {
                bail!("External link is not allowed.")
            }
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_url(url.as_str(), None::<&str>)?;
            Ok(Value::Null)
        }
        "window:minimize" => {
            window.minimize()?;
            Ok(Value::Null)
        }
        "window:close" => {
            if settings(&state)?["windowCloseBehavior"] == "minimize_to_tray" {
                window.hide()?;
            } else if state.engine.control.busy.load(Ordering::SeqCst) {
                bail!("Wait for the current operation to finish before closing the launcher.")
            } else {
                app.exit(0);
            }
            Ok(Value::Null)
        }
        "game:pauseInstallOrUpdate" => {
            state.engine.control.pause();
            Ok(Value::Null)
        }
        "game:getDWProtonStatus" => crate::game::runtime::proton_status(&state.engine),
        "game:redownloadDWProton" => {
            let _operation = state.engine.control.acquire()?;
            #[cfg(target_os = "linux")]
            {
                let handle = app.clone();
                let progress: crate::game::Progress = Arc::new(move |phase, processed, total| {
                    emit(
                        &handle,
                        "game:progress",
                        json!({"phase":phase,"processed":processed,"total":total}),
                    )
                });
                crate::game::runtime::ensure_proton(&state.engine, true, progress).await?;
            }
            Ok(Value::Null)
        }
        "game:getSikarugirStatus" => crate::game::runtime::wrapper_status(&state.engine),
        "game:chooseSikarugirWrapper" => {
            let _operation = state.engine.control.acquire()?;
            #[cfg(target_os = "macos")]
            let chosen = app
                .dialog()
                .file()
                .set_title("Choose Sikarugir .app")
                .add_filter("Sikarugir wrapper", &["app"])
                .blocking_pick_file();
            #[cfg(not(target_os = "macos"))]
            let chosen = app
                .dialog()
                .file()
                .set_title("Choose Sikarugir .app")
                .blocking_pick_folder();
            if let Some(chosen) = chosen {
                let path = chosen.into_path()?;
                crate::game::runtime::inspect_wrapper(&path)?;
                state.store.lock().unwrap().put(
                    "launcher",
                    "sikarugir",
                    &json!({"wrapperPath":path}),
                )?;
                return crate::game::runtime::wrapper_status(&state.engine);
            }
            Ok(Value::Null)
        }
        "game:getLogFilePath" => Ok(json!(
            state
                .store
                .lock()
                .unwrap()
                .directory
                .join("logs/launcher.log")
        )),
        "game:showLogFileInFolder" | "game:showInstallDirInFolder" => {
            use tauri_plugin_opener::OpenerExt;
            let path = if channel == "game:showInstallDirInFolder" {
                approved(&state, arg(0).as_str().unwrap_or(""))?
            } else {
                state
                    .store
                    .lock()
                    .unwrap()
                    .directory
                    .join("logs/launcher.log")
            };
            app.opener().reveal_item_in_dir(path)?;
            Ok(Value::Null)
        }
        "update:get-state" => Ok(state.updater.snapshot()),
        "update:check" => {
            state.updater.check(app, &state.engine).await?;
            Ok(Value::Null)
        }
        "update:start-download" => {
            state.updater.download(app, &state.engine).await?;
            Ok(Value::Null)
        }
        "update:quit-and-install" => {
            state.updater.install(app, &state.engine)?;
            Ok(Value::Null)
        }
        _ => bail!("This action is unavailable. Update the launcher and try again."),
    }
}

fn create_window(app: &tauri::AppHandle, smoke: bool) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title(
            app.config()
                .product_name
                .as_deref()
                .unwrap_or("Tia Launcher"),
        )
        .inner_size(1100.0, 650.0)
        .min_inner_size(1100.0, 650.0)
        .max_inner_size(1100.0, 650.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .visible(true)
        .devtools(cfg!(debug_assertions))
        .on_navigation(|url| {
            matches!(url.scheme(), "tauri" | "http" | "https")
                && matches!(
                    url.host_str(),
                    Some("localhost" | "tauri.localhost" | "127.0.0.1")
                )
        })
        .on_page_load(move |window, event| {
            if event.event() == tauri::webview::PageLoadEvent::Finished {
                if smoke {
                    if std::env::args().any(|arg| arg == "--smoke-overlay-only") {
                        let _ = window.eval("window.__TIA_SMOKE_OVERLAY_ONLY__=true");
                    }
                    let _ = window.eval(include_str!("smoke.js"));
                }
                #[cfg(debug_assertions)]
                if crate::native_update::test_configuration()
                    .ok()
                    .flatten()
                    .is_some()
                {
                    let _ = window.eval(include_str!("native_update_smoke.js"));
                }
            }
        })
        .build()?;
    Ok(())
}
fn restore_window(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::overlay::close(&handle);
        let _ = create_window(&handle, false);
    });
}

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if crate::native_update::test_configuration()
            .expect("Invalid native updater test configuration")
            .is_some()
        {
            context.config_mut().plugins.0.insert("updater".into(),json!({"dangerousInsecureTransportProtocol":true,"pubkey":"","endpoints":[],"requireSignedVersion":true,"allowDowngrades":false}));
        }
        context
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            restore_window(app)
        }))
        .invoke_handler(tauri::generate_handler![launcher_request])
        .setup(|app| {
            let directory = dirs::config_dir()
                .ok_or_else(|| anyhow::anyhow!("No application data directory."))?
                .join(if app.config().identifier.ends_with(".preview") {
                    "tia-launcher-preview"
                } else {
                    "tia-launcher-bootstrap"
                });
            #[cfg(any(debug_assertions, feature = "migration-test"))]
            let directory = {
                let args: Vec<_> = std::env::args().collect();
                if let Some(index) = args.iter().position(|a| a == "--profile") {
                    #[cfg(all(feature = "migration-test", not(debug_assertions)))]
                    if !app.config().identifier.ends_with(".preview") {
                        return Err("Isolated profiles require a preview test build.".into());
                    }
                    PathBuf::from(
                        args.get(index + 1)
                            .ok_or_else(|| anyhow::anyhow!("Missing preview profile."))?,
                    )
                } else {
                    directory
                }
            };
            let key = keystore::load_or_create(&directory)?;
            let store = Arc::new(Mutex::new(Store::open(&directory, &key)?));
            let catalog: Value = serde_json::from_str(include_str!("../../src/shared/games.json"))?;
            let engine = crate::game::engine::Engine::new(
                store.clone(),
                catalog["apiBaseUrl"].as_str().unwrap().to_owned(),
                app.path().resource_dir()?,
            )?;
            let state = Arc::new(State {
                store,
                engine,
                catalog,
                feeds: crate::feeds::Feeds::default(),
                updater: crate::native_update::NativeUpdate::default(),
                #[cfg(target_os = "linux")]
                video_stream: tauri::async_runtime::block_on(
                    crate::video_stream::VideoStream::start(),
                )?,
                media_candidate: Mutex::new(None),
            });
            app.manage(state.clone());
            let update_app = app.handle().clone();
            let update_state = state.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = update_state
                        .updater
                        .check(&update_app, &update_state.engine)
                        .await;
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
            });
            let feed_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let news = state.feeds.news(&state.engine).await;
                    emit(&feed_app, "news:update", news);
                    let silver = state.feeds.silver(&state.engine).await;
                    emit(&feed_app, "silver-notices:update", silver);
                    tokio::time::sleep(Duration::from_secs(900)).await;
                }
            });
            let open = tauri::menu::MenuItem::with_id(
                app,
                "open",
                "Open Tia Launcher",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("Tia Launcher")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => restore_window(app),
                    "quit" => {
                        let state = app.state::<Arc<State>>();
                        if !state.engine.control.busy.load(Ordering::SeqCst) {
                            app.exit(0);
                        } else {
                            restore_window(app);
                        }
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let smoke = cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--smoke-test");
            if smoke {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(60));
                    handle.exit(2)
                });
            }
            create_window(app.handle(), smoke)?;
            Ok(())
        })
        .build(context)
        .expect("Could not start Tia Launcher")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                let state = app.state::<Arc<State>>();
                if state.engine.control.running.load(Ordering::SeqCst)
                    || state.engine.control.busy.load(Ordering::SeqCst)
                {
                    api.prevent_exit();
                }
            }
        });
}
