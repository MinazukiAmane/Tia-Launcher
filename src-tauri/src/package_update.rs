use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub artifact: PathBuf,
    pub signature: String,
    pub version: String,
}

pub fn verify(bytes: &[u8], signature: &str, key: &str, target: &str, current: &str) -> Result<()> {
    let target_version = semver::Version::parse(target)?;
    if target_version <= semver::Version::parse(current)? {
        bail!("This package is not a newer launcher version")
    }
    if signature.len() > 16384 || key.is_empty() {
        bail!("Package signing configuration is missing or invalid")
    }
    let key = String::from_utf8(STANDARD.decode(key)?)?;
    let signature = String::from_utf8(STANDARD.decode(signature)?)?;
    let key = minisign_verify::PublicKey::decode(&key)?;
    let signature = minisign_verify::Signature::decode(&signature)?;
    key.verify(bytes, &signature, true)?;
    let versions: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|part| part.strip_prefix("version:"))
        .collect();
    if versions.len() != 1 || semver::Version::parse(versions[0])? != target_version {
        bail!("Package signature does not match the announced version")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > limit {
        bail!("Invalid package update file")
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("Package update file is too large")
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub fn system_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    if std::fs::canonicalize(path)? != path {
        bail!("The system launcher path could not be verified")
    }
    for entry in path.ancestors() {
        let info = std::fs::symlink_metadata(entry)?;
        if info.file_type().is_symlink() || info.uid() != 0 || info.mode() & 0o022 != 0 {
            bail!("Install launcher updates using your package manager for this location")
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn privileged_install(request_path: &Path) -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        bail!("Package installation needs administrator approval")
    }
    system_executable(&std::env::current_exe()?)?;
    let request: Request = serde_json::from_slice(&read_regular(request_path, 32768)?)?;
    if !request.artifact.is_absolute() {
        bail!("Invalid package location")
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../native-updates.json"))?;
    let key = config["publicKey"]
        .as_str()
        .context("Missing updater key")?;
    let bytes = read_regular(&request.artifact, MAX_PACKAGE)?;
    verify(
        &bytes,
        &request.signature,
        key,
        &request.version,
        env!("CARGO_PKG_VERSION"),
    )?;
    let temporary = tempfile::Builder::new()
        .prefix("tia-package-")
        .tempdir_in("/var/tmp")?;
    let artifact = temporary.path().join("update.pkg.tar.zst");
    std::fs::write(&artifact, &bytes)?;
    drop(bytes);
    let metadata = std::process::Command::new("/usr/bin/pacman")
        .args(["-Qp", "--"])
        .arg(&artifact)
        .env("LC_ALL", "C")
        .output()?;
    let text = std::str::from_utf8(&metadata.stdout)?;
    let fields: Vec<_> = text.split_whitespace().collect();
    let package_version = format!("{}-1", request.version.replace(['-', '+'], "_"));
    if !metadata.status.success() || fields.as_slice() != ["tia-launcher", package_version.as_str()]
    {
        bail!("The signed package has an unexpected name or version")
    }
    let status = std::process::Command::new("/usr/bin/pacman")
        .args(["-U", "--noconfirm", "--"])
        .arg(&artifact)
        .status()?;
    if !status.success() {
        bail!("The system package manager could not install the update")
    }
    Ok(())
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
pub fn install_pacman(
    app: &tauri::AppHandle,
    bytes: &[u8],
    signature: &str,
    version: &str,
) -> Result<()> {
    use tauri::Manager;
    let executable = std::env::current_exe()?;
    system_executable(&executable)?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../native-updates.json"))?;
    verify(
        bytes,
        signature,
        config["publicKey"]
            .as_str()
            .context("Missing updater key")?,
        version,
        app.package_info().version.to_string().as_str(),
    )?;
    let cache = app.path().app_cache_dir()?;
    std::fs::create_dir_all(&cache)?;
    let temporary = tempfile::Builder::new()
        .prefix("update-")
        .tempdir_in(cache)?;
    let artifact = temporary.path().join("update.pkg.tar.zst");
    std::fs::write(&artifact, bytes)?;
    let request = temporary.path().join("request.json");
    std::fs::write(
        &request,
        serde_json::to_vec(&Request {
            artifact,
            signature: signature.into(),
            version: version.into(),
        })?,
    )?;
    let status = std::process::Command::new("/usr/bin/pkexec")
        .arg(executable)
        .arg("--install-signed-package")
        .arg(request)
        .status()
        .context("Install polkit to update this package from the launcher")?;
    if !status.success() {
        bail!("The update was canceled or could not finish. Your installed launcher has been kept.")
    }
    Ok(())
}
