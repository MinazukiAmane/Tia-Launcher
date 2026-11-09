use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixListener,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileContext {
    pub path: PathBuf,
    #[serde(with = "identifier")]
    pub device: u64,
    #[serde(with = "identifier")]
    pub inode: u64,
    pub mode: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacContext {
    pub bundle: PathBuf,
    #[serde(with = "identifier")]
    pub device: u64,
    #[serde(with = "identifier")]
    pub inode: u64,
    pub id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleIdentity {
    pub id: String,
    pub executable: String,
    pub version: String,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Startup {
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub environment: Option<BTreeMap<String, String>>,
    pub timeout_ms: Option<u64>,
}
fn safe_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected a regular file");
    Ok(file)
}
pub fn appimage_context(path: &Path) -> Result<FileContext> {
    ensure!(
        path.is_absolute(),
        "Automatic migration requires an AppImage; use the package manager for other installations"
    );
    let info = fs::symlink_metadata(path)?;
    ensure!(
        info.is_file()
            && !info.file_type().is_symlink()
            && fs::canonicalize(path)? == path
            && info.mode() & 0o111 != 0,
        "The current AppImage location could not be verified"
    );
    writable_parent(path)?;
    Ok(FileContext {
        path: path.into(),
        device: info.dev(),
        inode: info.ino(),
        mode: info.mode() & 0o777,
    })
}
fn writable_parent(path: &Path) -> Result<()> {
    let probe = tempfile::Builder::new()
        .prefix(".tia-write-")
        .tempdir_in(path.parent().context("Missing installation parent")?)?;
    drop(probe);
    Ok(())
}
fn copy_exclusive(from: &Path, to: &Path) -> Result<()> {
    let mut source = safe_file(from)?;
    ensure!(
        source.metadata()?.len() <= 512 * 1024 * 1024,
        "The launcher update is too large"
    );
    let mut dest = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(to)?;
    let bytes = std::io::copy(&mut (&mut source).take(512 * 1024 * 1024 + 1), &mut dest)?;
    ensure!(
        bytes <= 512 * 1024 * 1024,
        "The launcher update is too large"
    );
    dest.sync_all()?;
    Ok(())
}
fn image_header(path: &Path) -> Result<()> {
    let mut header = [0; 12];
    safe_file(path)?.read_exact(&mut header)?;
    ensure!(
        &header[..4] == b"\x7fELF" && &header[8..11] == b"AI\x02",
        "The downloaded update is not a supported AppImage"
    );
    Ok(())
}
pub fn replace_appimage(
    context: &FileContext,
    download: &Path,
    sha512: &str,
    start: impl FnOnce(&Path) -> Result<u32>,
) -> Result<u32> {
    let current = appimage_context(&context.path)?;
    ensure!(
        current.device == context.device
            && current.inode == context.inode
            && current.mode == context.mode,
        "The launcher installation changed while preparing the update"
    );
    let staging = tempfile::Builder::new()
        .prefix(".tia-update-")
        .tempdir_in(context.path.parent().unwrap())?;
    let next = staging.path().join("next.AppImage");
    let previous = staging.path().join("previous.AppImage");
    copy_exclusive(download, &next)?;
    crate::bridge_ops::verify_installer(&next, sha512)?;
    image_header(&next)?;
    fs::set_permissions(&next, fs::Permissions::from_mode(context.mode))?;
    safe_file(&next)?.sync_all()?;
    fs::hard_link(&context.path, &previous)?;
    let saved = fs::symlink_metadata(&previous)?;
    ensure!(
        saved.is_file() && saved.dev() == context.device && saved.ino() == context.inode,
        "The launcher installation changed while preparing the update"
    );
    fs::rename(&next, &context.path)?;
    match start(&context.path) {
        Ok(pid) => Ok(pid),
        Err(error) => {
            if fs::rename(&previous, &context.path).is_err() {
                let backup = staging.keep().join("previous.AppImage");
                bail!(
                    "The update could not start. Your previous launcher is saved at {}. {error}",
                    backup.display()
                );
            }
            Err(error)
        }
    }
}
pub fn clean_environment(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    if let Some(mount) = env
        .get("APPDIR")
        .map(|s| s.trim_end_matches('/').to_owned())
        .filter(|s| s.starts_with('/') && s.len() > 1)
    {
        let belongs = |value: &str| value == mount || value.starts_with(&format!("{mount}/"));
        for name in [
            "PATH",
            "LD_LIBRARY_PATH",
            "XDG_DATA_DIRS",
            "GI_TYPELIB_PATH",
            "GIO_EXTRA_MODULES",
            "QT_PLUGIN_PATH",
            "QT_QPA_PLATFORM_PLUGIN_PATH",
        ] {
            if let Some(value) = env.get(name) {
                let value = value
                    .split(':')
                    .filter(|part| !belongs(part))
                    .collect::<Vec<_>>()
                    .join(":");
                env.insert(name.into(), value);
            }
        }
        for name in [
            "GTK_PATH",
            "GTK_DATA_PREFIX",
            "GTK_EXE_PREFIX",
            "GTK_IM_MODULE_FILE",
            "GIO_MODULE_DIR",
            "GDK_PIXBUF_MODULE_FILE",
            "GSETTINGS_SCHEMA_DIR",
            "GST_PLUGIN_PATH_1_0",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GST_PLUGIN_SCANNER_1_0",
        ] {
            if env.get(name).is_some_and(|value| belongs(value)) {
                env.remove(name);
            }
        }
    }
    for name in [
        "APPIMAGE",
        "APPDIR",
        "ARGV0",
        "OWD",
        "APPIMAGE_EXIT_AFTER_INSTALL",
        "APPIMAGE_SILENT_INSTALL",
        "ELECTRON_RUN_AS_NODE",
    ] {
        env.remove(name);
    }
    env
}
fn stop(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    let until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < until {
        if child.try_wait().ok().flatten().is_some() {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}
pub fn start(path: &Path, startup: &Startup) -> Result<u32> {
    ensure!(
        path.is_absolute(),
        "The launcher executable must be an absolute path"
    );
    let timeout = startup.timeout_ms.unwrap_or(90_000);
    ensure!((50..=90_000).contains(&timeout), "Invalid startup timeout");
    let directory = tempfile::Builder::new()
        .prefix("tia-ready-")
        .tempdir_in("/tmp")
        .context("The private startup socket directory could not be created")?;
    let socket = directory.path().join("ready.sock");
    let listener =
        UnixListener::bind(&socket).context("The startup socket could not be created")?;
    listener
        .set_nonblocking(true)
        .context("The startup listener could not be configured")?;
    let nonce = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );
    let mut child = Command::new(path)
        .args(&startup.args)
        .env_clear()
        .envs(clean_environment(
            startup
                .environment
                .clone()
                .unwrap_or_else(|| std::env::vars().collect()),
        ))
        .env("TIA_MIGRATION_SOCKET", &socket)
        .env("TIA_MIGRATION_NONCE", &nonce)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("The updated launcher could not start")?;
    let result = (|| -> Result<u32> {
        let deadline = Instant::now() + Duration::from_millis(timeout);
        loop {
            ensure!(
                child
                    .try_wait()
                    .context("The updated launcher status could not be read")?
                    .is_none(),
                "The updated launcher closed before it was ready"
            );
            ensure!(
                Instant::now() < deadline,
                "The updated launcher did not become ready. Your previous launcher will be restored"
            );
            match listener.accept() {
                Ok((mut pipe, _)) => {
                    pipe.set_nonblocking(true).context(
                        "The startup acknowledgement connection could not be configured",
                    )?;
                    let peer_deadline = deadline.min(Instant::now() + Duration::from_secs(1));
                    let mut bytes = Vec::new();
                    loop {
                        ensure!(
                            bytes.len() < 16384 && Instant::now() < peer_deadline,
                            "The updated launcher sent an invalid startup acknowledgement"
                        );
                        let mut byte = [0];
                        match pipe.read(&mut byte) {
                            Ok(0) => anyhow::bail!("Incomplete startup acknowledgement"),
                            Ok(_) => {
                                if byte[0] == b'\n' {
                                    break;
                                }
                                bytes.push(byte[0]);
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(10))
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue;
                            }
                            Err(error) => {
                                return Err(error)
                                    .context("The startup acknowledgement could not be read");
                            }
                        }
                    }
                    #[derive(Deserialize)]
                    struct Ready {
                        protocol: u8,
                        nonce: String,
                        status: String,
                    }
                    let ready: Ready = serde_json::from_slice(&bytes)
                        .context("Invalid startup acknowledgement")?;
                    ensure!(
                        ready.protocol == 1 && ready.nonce == nonce && ready.status == "ready",
                        "The updated launcher sent an invalid startup acknowledgement"
                    );
                    ensure!(
                        child
                            .try_wait()
                            .context("The updated launcher status could not be read")?
                            .is_none(),
                        "The updated launcher closed before it was ready"
                    );
                    return Ok(child.id());
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e).context("The startup acknowledgement connection failed"),
            }
        }
    })();
    if result.is_err() {
        stop(&mut child);
    }
    result
}
pub fn bundle_identity(bundle: &Path) -> Result<BundleIdentity> {
    let plist = bundle.join("Contents/Info.plist");
    let read = |field: &str| -> Result<String> {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", field, "raw", "-o", "-"])
            .arg(&plist)
            .output()?;
        ensure!(
            output.status.success() && output.stdout.len() <= 8192,
            "The application identity could not be read"
        );
        Ok(String::from_utf8(output.stdout)?.trim().to_owned())
    };
    let identity = BundleIdentity {
        id: read("CFBundleIdentifier")?,
        executable: read("CFBundleExecutable")?,
        version: read("CFBundleShortVersionString")?,
    };
    validate_binary_name(&identity.executable)?;
    Ok(identity)
}
fn validate_binary_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0']),
        "The application executable is invalid"
    );
    Ok(())
}
pub fn mac_context(
    executable: &Path,
    id: &str,
    read: impl Fn(&Path) -> Result<BundleIdentity>,
) -> Result<MacContext> {
    ensure!(
        executable.is_absolute(),
        "The application location could not be verified"
    );
    let bundle = executable
        .ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .context("Missing installed application bundle")?;
    let info = fs::symlink_metadata(bundle)?;
    ensure!(
        info.is_dir() && !info.file_type().is_symlink() && fs::canonicalize(bundle)? == bundle,
        "The installed application bundle could not be verified"
    );
    let identity = read(bundle)?;
    validate_binary_name(&identity.executable)?;
    ensure!(
        identity.id == id && bundle.join("Contents/MacOS").join(&identity.executable) == executable,
        "The installed application identity does not match this launcher"
    );
    writable_parent(bundle)?;
    Ok(MacContext {
        bundle: bundle.into(),
        device: info.dev(),
        inode: info.ino(),
        id: id.into(),
    })
}
fn extract_bundle(archive: &Path, root: &Path) -> Result<PathBuf> {
    let mut zip = zip::ZipArchive::new(safe_file(archive)?)?;
    ensure!(
        zip.len() <= 30_000,
        "The application archive has too many entries"
    );
    let mut bundle = None;
    let mut names = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name()?.into_owned();
        let name = name.trim_end_matches('/');
        let parts: Vec<_> = name.split('/').collect();
        ensure!(
            !name.is_empty()
                && !name.contains(['\\', '\0'])
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && *p != "." && *p != ".."),
            "The update contains an unsafe application path"
        );
        if parts[0] == "__MACOSX" {
            continue;
        }
        ensure!(
            parts[0].ends_with(".app") && names.insert(name.to_owned()),
            "The application archive contains unexpected or duplicate files"
        );
        if let Some(ref previous) = bundle {
            ensure!(
                previous == parts[0],
                "The update contains multiple application bundles"
            );
        } else {
            bundle = Some(parts[0].to_owned());
        }
        total = total
            .checked_add(entry.size())
            .context("Application archive size overflow")?;
        ensure!(
            total <= 1024 * 1024 * 1024,
            "The application archive is too large"
        );
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        ensure!(
            kind == 0 || kind == 0o100000 || kind == 0o040000,
            "The update contains an unsupported linked or special file"
        );
        let path = crate::paths::within(root, name)?;
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().unwrap())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let expected = entry.size();
        let actual = std::io::copy(&mut (&mut entry).take(expected + 1), &mut file)?;
        ensure!(
            actual == expected,
            "The application archive size is invalid"
        );
        file.sync_all()?;
        let permissions = mode & 0o755;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if permissions == 0 { 0o644 } else { permissions }),
        )?;
    }
    Ok(root.join(bundle.context("The update has no application bundle")?))
}
pub fn replace_mac(
    context: &MacContext,
    download: &Path,
    sha512: &str,
    version: &str,
    start: impl FnOnce(&Path) -> Result<u32>,
    read: impl Fn(&Path) -> Result<BundleIdentity>,
) -> Result<u32> {
    let staging = tempfile::Builder::new().prefix(".tia-update-").tempdir_in(
        context
            .bundle
            .parent()
            .context("Missing application parent")?,
    )?;
    let archive = staging.path().join("update.zip");
    copy_exclusive(download, &archive)?;
    crate::bridge_ops::verify_installer(&archive, sha512)?;
    let root = staging.path().join("extracted");
    fs::create_dir(&root)?;
    let next = extract_bundle(&archive, &root)?;
    let identity = read(&next)?;
    validate_binary_name(&identity.executable)?;
    ensure!(
        identity.id == context.id && identity.version == version,
        "The downloaded application identity or version does not match the signed update"
    );
    let code = fs::symlink_metadata(next.join("Contents/MacOS").join(&identity.executable))?;
    ensure!(
        code.is_file() && !code.file_type().is_symlink() && code.mode() & 0o111 != 0,
        "The updated launcher executable could not be verified"
    );
    let current = fs::symlink_metadata(&context.bundle)?;
    ensure!(
        current.is_dir()
            && !current.file_type().is_symlink()
            && current.dev() == context.device
            && current.ino() == context.inode,
        "The installed launcher changed while preparing the update"
    );
    let backup = staging.path().join("previous.app");
    fs::rename(&context.bundle, &backup)?;
    let mut installed = false;
    let result = (|| {
        fs::rename(next, &context.bundle)?;
        installed = true;
        start(
            &context
                .bundle
                .join("Contents/MacOS")
                .join(&identity.executable),
        )
    })();
    match result {
        Ok(pid) => Ok(pid),
        Err(error) => {
            let rollback = (|| -> Result<()> {
                if installed {
                    fs::rename(&context.bundle, staging.path().join("failed.app"))?;
                }
                fs::rename(&backup, &context.bundle)?;
                Ok(())
            })();
            if rollback.is_err() {
                let backup = staging.keep().join("previous.app");
                bail!(
                    "The previous launcher is retained at {}. Restore it before retrying. {error}",
                    backup.display()
                );
            }
            Err(error)
        }
    }
}

mod identifier {
    pub fn serialize<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = <String as serde::Deserialize>::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}
