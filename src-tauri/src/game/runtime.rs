use super::engine::Engine;
#[cfg(target_os = "linux")]
use super::{Progress, transfer};
use anyhow::Result;
#[cfg(target_os = "linux")]
use anyhow::{Context, bail};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::Arc;

pub fn proton_status(engine: &Engine) -> Result<Value> {
    let root = engine
        .store
        .lock()
        .unwrap()
        .directory
        .join("runtimes/proton");
    let preferred = engine
        .store
        .lock()
        .unwrap()
        .get("launcher", "dwproton")?
        .and_then(|v| v["tag"].as_str().map(String::from));
    let mut choices = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for item in entries {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            if valid_tag(&name)
                && item.file_type()?.is_dir()
                && item.path().join("proton").is_file()
            {
                choices.push((item.metadata()?.modified()?, name, item.path()));
            }
        }
    }
    choices.sort_by(|a, b| b.0.cmp(&a.0));
    let selected = choices
        .iter()
        .find(|(_, name, _)| Some(name) == preferred.as_ref())
        .or_else(|| choices.first());
    Ok(if let Some((_, tag, path)) = selected {
        json!({"installed":true,"tagName":tag,"tag":tag,"protonPath":path})
    } else {
        json!({"installed":false,"tagName":null,"tag":null,"protonPath":null})
    })
}
fn valid_tag(tag: &str) -> bool {
    tag.starts_with("dwproton-")
        && tag.len() < 128
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        && !tag.contains("..")
}
pub fn wrapper_status(engine: &Engine) -> Result<Value> {
    let saved = engine.store.lock().unwrap().get("launcher", "sikarugir")?;
    let mut defaults = Vec::new();
    if let Some(home) = dirs::home_dir() {
        defaults.push(home.join("Applications/Sikarugir/Tia Launcher.app"));
    }
    defaults.push(PathBuf::from("/Applications/Sikarugir/Tia Launcher.app"));
    let path = super::macos::find_wrapper(saved.as_ref(), &defaults);
    Ok(json!({"found":path.is_some(),"wrapperPath":path}))
}
pub fn inspect_wrapper(path: &Path) -> Result<()> {
    super::macos::inspect_wrapper(path)
}
#[cfg(target_os = "linux")]
async fn download_vendor(
    engine: &Engine,
    url: &str,
    path: &Path,
    sha: &str,
    sha512: bool,
    progress: &Progress,
) -> Result<()> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256, Sha512};
    use tokio::io::AsyncWriteExt;
    transfer::validate_url(url)?;
    let response = engine.client.get(url).send().await?.error_for_status()?;
    transfer::validate_url(response.url().as_str())?;
    let total = response.content_length().unwrap_or(0);
    if total > 4 * 1024u64.pow(3) {
        bail!("Runtime download exceeds its allowed size.")
    }
    let mut file = tokio::fs::File::create(path).await?;
    let mut a = Sha256::new();
    let mut b = Sha512::new();
    let mut stream = response.bytes_stream();
    let mut count = 0u64;
    loop {
        let value = tokio::select! {_=engine.control.cancelled()=>return Err(super::Paused.into()),next=tokio::time::timeout(std::time::Duration::from_secs(30),stream.next())=>next.context("Runtime download stalled")?};
        let Some(value) = value else { break };
        let bytes = value?;
        count += bytes.len() as u64;
        if count > 4 * 1024u64.pow(3) {
            bail!("Runtime download exceeds its allowed size.")
        }
        a.update(&bytes);
        b.update(&bytes);
        file.write_all(&bytes).await?;
        progress("downloading", count, total);
    }
    file.flush().await?;
    drop(file);
    let actual = if sha512 {
        hex::encode(b.finalize())
    } else {
        hex::encode(a.finalize())
    };
    if actual != sha.to_lowercase() || (total != 0 && count != total) {
        let _ = tokio::fs::remove_file(path).await;
        bail!("The runtime download failed checksum verification.")
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn unpack_tar(reader: impl std::io::Read, root: &Path, strip: bool) -> Result<()> {
    use std::path::Component;
    let mut archive = tar::Archive::new(reader);
    let mut links = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.is_absolute() {
            bail!("Absolute runtime archive path.")
        }
        let relative: PathBuf = if strip {
            path.components().skip(1).collect()
        } else {
            path
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let name = relative.to_str().context("Invalid runtime path")?;
        let target = crate::paths::within(root, name)?;
        if entry.header().entry_type().is_dir() {
            crate::paths::ensure_directory(&target)?;
            continue;
        }
        crate::paths::ensure_directory(target.parent().unwrap())?;
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            let link = entry
                .link_name()?
                .context("Missing runtime link target")?
                .into_owned();
            if link.is_absolute() {
                bail!("Absolute runtime link.")
            }
            let candidate = if entry.header().entry_type().is_hard_link() {
                if strip {
                    link.components().skip(1).collect::<PathBuf>()
                } else {
                    link
                }
            } else {
                relative.parent().unwrap_or(Path::new("")).join(link)
            };
            let mut components = Vec::new();
            for part in candidate.components() {
                match part {
                    Component::Normal(p) => components.push(p.to_os_string()),
                    Component::CurDir => {}
                    Component::ParentDir => {
                        if components.pop().is_none() {
                            bail!("Runtime archive link escapes its root.")
                        }
                    }
                    _ => bail!("Invalid runtime link."),
                }
            }
            links.push((
                relative,
                components.into_iter().collect::<PathBuf>(),
                entry.header().entry_type().is_hard_link(),
            ));
            continue;
        }
        if !entry.header().entry_type().is_file() || entry.size() > 4 * 1024u64.pow(3) {
            bail!("Invalid runtime archive entry.")
        }
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)?;
        std::io::copy(&mut entry, &mut file)?;
        drop(file);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &target,
            std::fs::Permissions::from_mode(entry.header().mode()? & 0o777),
        )?;
    }
    // Create links only after regular files, so archive contents cannot write through them.
    for (relative, target, hard) in links {
        let destination =
            crate::paths::within(root, relative.to_str().context("Invalid runtime link")?)?;
        if hard {
            let source =
                crate::paths::within(root, target.to_str().context("Invalid runtime link")?)?;
            std::fs::hard_link(source, destination)?;
        } else {
            let parent: Vec<_> = relative
                .parent()
                .unwrap_or(Path::new(""))
                .components()
                .collect();
            let target: Vec<_> = target.components().collect();
            let common = parent
                .iter()
                .zip(&target)
                .take_while(|(a, b)| a == b)
                .count();
            let mut link = PathBuf::new();
            for _ in common..parent.len() {
                link.push("..");
            }
            for part in &target[common..] {
                link.push(part.as_os_str());
            }
            if link.as_os_str().is_empty() {
                link.push(".");
            }
            std::os::unix::fs::symlink(link, destination)?;
        }
    }

    Ok(())
}
#[cfg(target_os = "linux")]
pub async fn ensure_proton(
    engine: &Arc<Engine>,
    force: bool,
    progress: Progress,
) -> Result<PathBuf> {
    if !force {
        let status = proton_status(engine)?;
        if let Some(path) = status["protonPath"].as_str() {
            return Ok(path.into());
        }
    }
    let previous = proton_status(engine)?["protonPath"]
        .as_str()
        .map(PathBuf::from);
    let response = engine
        .client
        .get("https://dawn.wine/api/v1/repos/dawn-winery/dwproton/releases?limit=1")
        .send()
        .await?
        .error_for_status()?;
    let releases: Value =
        serde_json::from_slice(&transfer::bounded_body(response, 4 * 1024 * 1024).await?)?;
    let release = &releases[0];
    let tag = release["tag_name"]
        .as_str()
        .context("No DWProton release is available")?;
    if !valid_tag(tag) {
        bail!("Invalid DWProton release tag.")
    }
    let assets = release["assets"]
        .as_array()
        .context("DWProton release assets are unavailable")?;
    let asset = |ending: &str| {
        assets
            .iter()
            .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(ending)))
            .context("The runtime release is incomplete")
    };
    let tar = asset("-x86_64.tar.xz")?;
    let checksum = asset("-x86_64.sha512sum")?;
    let checksum_url = checksum["browser_download_url"]
        .as_str()
        .context("Invalid checksum address")?;
    transfer::validate_url(checksum_url)?;
    let response = engine
        .client
        .get(checksum_url)
        .send()
        .await?
        .error_for_status()?;
    let text = String::from_utf8(transfer::bounded_body(response, 64 * 1024).await?)?;
    let sha = text
        .split_whitespace()
        .next()
        .context("Missing runtime checksum")?;
    if sha.len() != 128 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Invalid runtime checksum.")
    }
    let root = engine.store.lock().unwrap().directory.join("runtimes");
    crate::paths::ensure_directory(&root)?;
    let temp = root.join(format!("runtime-{:016x}", rand::random::<u64>()));
    std::fs::create_dir(&temp)?;
    let result = async {
        let archive = temp.join("proton.tar.xz");
        download_vendor(
            engine,
            tar["browser_download_url"]
                .as_str()
                .context("Invalid runtime download address")?,
            &archive,
            sha,
            true,
            &progress,
        )
        .await?;
        let extracted = temp.join("extracted");
        std::fs::create_dir(&extracted)?;
        let source = archive.clone();
        let destination = extracted.clone();
        tokio::task::spawn_blocking(move || {
            unpack_tar(
                xz2::read::XzDecoder::new(std::fs::File::open(source)?),
                &destination,
                true,
            )
        })
        .await??;
        if !extracted.join("proton").is_file() {
            bail!("The downloaded runtime does not contain its launcher.")
        }
        let parent = root.join("proton");
        crate::paths::ensure_directory(&parent)?;
        let destination = parent.join(tag);
        for name in ["user_settings.py", "dxvk.conf", "vkd3d-proton.conf"] {
            let old = destination.join(name);
            let old = if old.is_file() {
                Some(old)
            } else {
                previous
                    .as_ref()
                    .map(|path| path.join(name))
                    .filter(|path| path.is_file())
            };
            if let Some(old) = old {
                std::fs::copy(old, extracted.join(name))?;
            }
        }
        let backup = temp.join("previous");
        if destination.exists() {
            std::fs::rename(&destination, &backup)?;
        }
        if let Err(error) = std::fs::rename(&extracted, &destination) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &destination);
            }
            return Err(error.into());
        }
        engine
            .store
            .lock()
            .unwrap()
            .put("launcher", "dwproton", &json!({"tag":tag}))?;
        Ok(destination)
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    result
}
#[cfg(target_os = "linux")]
pub async fn ensure_umu(engine: &Arc<Engine>, progress: Progress) -> Result<PathBuf> {
    let profile = engine.store.lock().unwrap().directory.clone();
    let managed = profile.join("runtimes/umu/umu-run");
    let mut candidates = Vec::new();
    if let Some(runtime) = crate::system_package::nix_umu() {
        candidates.push(runtime);
    }
    if !crate::system_package::nix_managed() {
        candidates.push(managed.clone());
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/share/tia-umu/umu-run"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            if directory.is_absolute() {
                candidates.push(directory.join("umu-run"));
            }
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            let stamp = super::verify::stamp(&candidate)?;
            if engine.runtime_checked.lock().unwrap().get(&candidate) == Some(&stamp) {
                return Ok(candidate);
            }
            let mut command = tokio::process::Command::new(&candidate);
            command.arg("--version");
            if let Ok(Ok(output)) =
                tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await
            {
                let text = String::from_utf8_lossy(&output.stdout);
                let version = text.split_whitespace().find_map(|t| {
                    let p = t
                        .trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
                        .split('.')
                        .map(str::parse::<u32>)
                        .collect::<std::result::Result<Vec<_>, _>>()
                        .ok()?;
                    (p.len() == 3).then_some(p)
                });
                if output.status.success()
                    && version.is_some_and(|v| v.as_slice() >= [1, 4, 4].as_slice())
                {
                    engine
                        .runtime_checked
                        .lock()
                        .unwrap()
                        .insert(candidate.clone(), stamp);
                    return Ok(candidate);
                }
            }
        }
    }
    if crate::system_package::nix_managed() {
        bail!(
            "Update umu-launcher through your Nix configuration. Version 1.4.4 or newer is required."
        )
    }
    let response = engine
        .client
        .get("https://api.github.com/repos/Open-Wine-Components/umu-launcher/releases/latest")
        .send()
        .await?
        .error_for_status()?;
    let release: Value =
        serde_json::from_slice(&transfer::bounded_body(response, 4 * 1024 * 1024).await?)?;
    let asset = release["assets"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|a| {
                a["name"]
                    .as_str()
                    .is_some_and(|n| n.ends_with("-zipapp.tar"))
            })
        })
        .context("No standalone UMU release was found")?;
    let digest = asset["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .context("The UMU release has no verifiable checksum")?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Invalid UMU release checksum.")
    }
    let root = profile.join("runtimes");
    crate::paths::ensure_directory(&root)?;
    let temporary = root.join(format!("umu-{:016x}", rand::random::<u64>()));
    std::fs::create_dir(&temporary)?;
    let result = async {
        let archive = temporary.join("umu.tar");
        download_vendor(
            engine,
            asset["browser_download_url"]
                .as_str()
                .context("Invalid UMU address")?,
            &archive,
            digest,
            false,
            &progress,
        )
        .await?;
        let destination = temporary.join("extracted");
        std::fs::create_dir(&destination)?;
        let source = archive.clone();
        let target = destination.clone();
        tokio::task::spawn_blocking(move || {
            unpack_tar(std::fs::File::open(source)?, &target, true)
        })
        .await??;
        let binary = destination.join("umu-run");
        if !binary.is_file() {
            bail!("The UMU archive does not contain its launcher.")
        }
        crate::paths::ensure_directory(managed.parent().unwrap())?;
        crate::paths::replace(&binary, &managed)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o755))?;
        Ok(managed)
    }
    .await;
    let _ = tokio::fs::remove_dir_all(temporary).await;
    result
}
