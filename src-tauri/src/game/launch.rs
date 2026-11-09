#[cfg(not(target_os = "windows"))]
use super::runtime;
use super::{
    Progress,
    engine::Engine,
    model::{Definition, Verification},
};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub launched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_result: Option<Verification>,
}
struct ReportGuard(PathBuf);
impl Drop for ReportGuard {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
pub struct Session {
    pub child: tokio::process::Child,
    pub staging: PathBuf,
}
pub fn parse_options(text: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut started = false;
    for c in text.chars() {
        if let Some(q) = quote {
            if c == q { quote = None } else { token.push(c) }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            started = true
        } else if c.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut token));
                started = false
            }
        } else {
            token.push(c);
            started = true
        }
    }
    if quote.is_some() {
        bail!("Launch options contain an unclosed quote.")
    }
    if started {
        args.push(token)
    }
    Ok(args)
}
pub fn client_args(game: &str, settings: &Value) -> Result<(Vec<String>, Option<String>)> {
    let mut args = Vec::new();
    if game == "csore_global" {
        args.extend([
            "-lang".into(),
            settings["lang"].as_str().unwrap_or("na_en").into(),
        ]);
        if settings["classicUi"] == true {
            args.push("--classicui".into())
        }
        if settings["alternateRenderer"] == true {
            args.push("-renderer".into())
        }
        if let Some(fps) = settings["fpsLimit"]
            .as_u64()
            .filter(|n| [144, 165, 240].contains(n))
        {
            args.extend([
                "+developer".into(),
                "1".into(),
                "+fps_max".into(),
                fps.to_string(),
            ]);
        }
    }
    let text = settings["launchCommand"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return Ok((args, None));
    }
    if text.len() > 500 || text.chars().any(char::is_control) {
        bail!("Invalid launch options.")
    }
    if text.starts_with('-') && !text.contains("%command%") {
        args.extend(parse_options(text)?);
        Ok((args, None))
    } else {
        Ok((args, Some(text.into())))
    }
}
pub fn architecture(path: &Path) -> Result<&'static str> {
    let mut file = std::fs::File::open(path)?;
    let before = super::verify::stamp(path)?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header)?;
    if &header[..2] != b"MZ" {
        bail!("The client executable is not a supported Windows program.")
    }
    let offset = u32::from_le_bytes(header[60..64].try_into().unwrap()) as u64;
    if offset
        .checked_add(26)
        .is_none_or(|n| n > file.metadata().map(|m| m.len()).unwrap_or(0))
    {
        bail!("The client executable header is incomplete.")
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0u8; 26];
    file.read_exact(&mut pe)?;
    if &pe[..4] != b"PE\0\0" || u16::from_le_bytes(pe[20..22].try_into().unwrap()) < 2 {
        bail!("Invalid client executable header.")
    }
    let machine = u16::from_le_bytes(pe[4..6].try_into().unwrap());
    let magic = u16::from_le_bytes(pe[24..26].try_into().unwrap());
    if super::verify::stamp(path)? != before {
        bail!("The client changed during launch preparation.")
    }
    match (machine, magic) {
        (0x14c, 0x10b) => Ok("x86"),
        (0x8664, 0x20b) => Ok("x64"),
        _ => bail!("This client architecture is not supported."),
    }
}
fn helper(engine: &Engine, game: &Definition, exe: &Path) -> Result<PathBuf> {
    let name = if game.biz == "csore_global" {
        format!("csore-start-{}.exe", architecture(exe)?)
    } else {
        "cedar-start-x64.exe".into()
    };
    let folder = if game.biz == "csore_global" {
        "client-runtime"
    } else {
        "game-runtime"
    };
    let candidates = vec![
        engine.resources.join(folder).join(&name),
        engine.resources.join("resources").join(folder).join(&name),
    ];
    #[cfg(debug_assertions)]
    let candidates = {
        let mut candidates = candidates;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/native");
        candidates.push(if game.biz == "csore_global" {
            root.join(&name)
        } else {
            root.join("cedar").join(&name)
        });
        candidates
    };
    let executable = candidates
        .into_iter()
        .find(|p| p.is_file())
        .context("The native client runtime is missing. Reinstall the launcher.")?;
    if game.biz == "cedar_global" {
        let parent = executable.parent().unwrap();
        if !parent.join("cedar-client-x64.dll").is_file()
            || !parent.join("launcher-services.json").is_file()
        {
            bail!("The native game runtime is incomplete. Reinstall the launcher.")
        }
    }
    Ok(executable)
}
fn windows_path(path: &Path) -> Result<String> {
    let normalized = crate::paths::user_path(path);
    let text = normalized
        .to_str()
        .context("The game path contains unsupported characters")?;
    Ok(if cfg!(windows) {
        text.strip_prefix("\\\\?\\").unwrap_or(text).into()
    } else {
        format!("Z:{}", text.replace('/', "\\"))
    })
}
fn quote(arg: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", arg.replace('"', "\"\""))
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}
pub async fn start(
    engine: &Arc<Engine>,
    root: &Path,
    game: &Definition,
    settings: &Value,
    progress: Progress,
) -> Result<Session> {
    let exe = crate::paths::within(root, &game.executable)?;
    let helper = helper(engine, game, &exe)?;
    let (args, wrapper) = client_args(&game.biz, settings)?;
    let staging = engine
        .store
        .lock()
        .unwrap()
        .directory
        .join(format!("runtime-report-{:016x}", rand::random::<u64>()));
    std::fs::create_dir(&staging)?;
    let mut report_guard = ReportGuard(staging.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(target_os = "linux")]
    let helper = {
        // Steam's container replaces /usr; keep helpers in its visible user profile.
        let destination = staging.join(helper.file_name().context("Invalid runtime filename")?);
        std::fs::copy(&helper, &destination)?;
        if game.biz == "cedar_global" {
            for name in ["cedar-client-x64.dll", "launcher-services.json"] {
                std::fs::copy(helper.parent().unwrap().join(name), staging.join(name))?;
            }
        }
        destination
    };
    let report = staging.join("status.txt");
    let mut helper_args = vec![windows_path(&report)?, windows_path(&exe)?];
    helper_args.extend(args);
    let mut command: tokio::process::Command;
    #[cfg(target_os = "linux")]
    let mut runtime_deadline = None;
    let deadline = if game.biz == "csore_global" {
        Duration::from_secs(30)
    } else {
        Duration::from_secs(150)
    };
    #[cfg(target_os = "windows")]
    {
        let _ = &progress;
        command = tokio::process::Command::new(&helper);
        command.args(&helper_args);
    }
    #[cfg(target_os = "linux")]
    {
        let proton = runtime::ensure_proton(engine, false, progress.clone()).await?;
        let umu = runtime::ensure_umu(engine, progress).await?;
        let base = engine.store.lock().unwrap().directory.join("runtimes");
        let prefix = base.join(if game.biz == "csore_global" {
            "prefix".to_owned()
        } else {
            format!("prefix-{}", game.biz)
        });
        if !prefix.join("drive_c").is_dir() {
            runtime_deadline = Some(Duration::from_secs(15 * 60))
        }
        crate::paths::ensure_directory(&prefix)?;
        command = tokio::process::Command::new(umu);
        command
            .arg(&helper)
            .args(&helper_args)
            .env("PROTONPATH", proton)
            .env("GAMEID", "tia-launcher")
            .env("WINEPREFIX", prefix)
            .env("STEAM_COMPAT_INSTALL_PATH", exe.parent().unwrap());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &progress;
        let status = runtime::wrapper_status(engine)?;
        let wrapper_path = PathBuf::from(
            status["wrapperPath"]
                .as_str()
                .context("Select a Sikarugir wrapper in Game Settings before playing.")?,
        );
        runtime::inspect_wrapper(&wrapper_path)?;
        let batch = staging.join("launch-game.bat");
        let contents = super::macos::build_batch(&helper, &helper_args, exe.parent().unwrap())?;
        std::fs::write(&batch, contents)?;
        command =
            tokio::process::Command::new(wrapper_path.join("Contents/MacOS/wineskinlauncher"));
        command.arg("WSS-installer").arg(batch);
    }
    if let Some(wrapper) = wrapper {
        let real = std::iter::once(
            command
                .as_std()
                .get_program()
                .to_string_lossy()
                .into_owned(),
        )
        .chain(
            command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned()),
        )
        .map(|a| quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
        let text = if wrapper.contains("%command%") {
            wrapper.replace("%command%", &real)
        } else {
            format!("{wrapper} {real}")
        };
        let environment = command
            .as_std()
            .get_envs()
            .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
            .collect::<Vec<_>>();
        #[cfg(windows)]
        {
            command = tokio::process::Command::new(
                std::env::var_os("COMSPEC")
                    .unwrap_or_else(|| "C:\\Windows\\System32\\cmd.exe".into()),
            );
            command.args(["/d", "/s", "/c", &text]);
        }
        #[cfg(not(windows))]
        {
            command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", &text]);
        }
        for (key, value) in environment {
            if let Some(value) = value {
                command.env(key, value);
            } else {
                command.env_remove(key);
            }
        }
    }
    let directory = engine.store.lock().unwrap().directory.join("logs");
    crate::paths::ensure_directory(&directory)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("client-runtime.log"))?;
    command
        .stdout(log.try_clone()?)
        .stderr(log)
        .stdin(std::process::Stdio::null())
        .current_dir(exe.parent().unwrap())
        .kill_on_drop(false);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error.into());
        }
    };
    #[cfg(target_os = "linux")]
    let deadline = runtime_deadline.unwrap_or(deadline);
    let started = Instant::now();
    let ready = loop {
        if let Ok(status) = tokio::fs::read_to_string(&report).await {
            if status.starts_with("ready\n") {
                break Ok(());
            }
            if status.starts_with("error:") {
                engine.record(&format!("launch: runtime report: {}", status.trim()));
                break Err(anyhow::anyhow!(
                    "The native client could not initialize. See client-runtime.log for details."
                ));
            }
        }
        if let Some(status) = child.try_wait()? {
            break Err(anyhow::anyhow!(
                "The game runtime exited before confirming startup ({status}). See the launcher log."
            ));
        }
        if started.elapsed() > deadline {
            break Err(anyhow::anyhow!(
                "The game did not confirm startup. See client-runtime.log and try again."
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    if let Err(error) = ready {
        let _ = child.kill().await;
        let _ = tokio::fs::remove_dir_all(staging).await;
        return Err(error);
    }
    engine.control.running.store(true, Ordering::SeqCst);
    engine.record("launch: native client acknowledged startup");
    report_guard.0.clear();
    Ok(Session { child, staging })
}
impl Engine {
    pub async fn play(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        settings: &Value,
        progress: Progress,
    ) -> Result<(LaunchResult, Option<Session>)> {
        let _operation = self.control.acquire()?;
        let verification = self.verify_inner(root, game, true).await?;
        if !verification.ok {
            return Ok((
                LaunchResult {
                    launched: false,
                    verify_result: Some(verification),
                },
                None,
            ));
        }
        let session = start(self, root, game, settings, progress).await?;
        Ok((
            LaunchResult {
                launched: true,
                verify_result: None,
            },
            Some(session),
        ))
    }
}
