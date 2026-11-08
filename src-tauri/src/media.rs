use crate::{
    game::{engine::Engine, transfer},
    paths,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IMAGES: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "webp", "gif", "avif", "apng", "bmp", "ico", "svg",
];
pub const VIDEOS: &[&str] = &[
    "mp4", "webm", "mov", "m4v", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "mpe", "m2v", "ts",
    "mts", "m2ts", "3gp", "3g2", "vob", "ogv", "ogg", "mxf", "f4v",
];
pub const VIDEO_LIMIT: u64 = 200 * 1024 * 1024;
pub struct Candidate {
    pub token: String,
    pub path: PathBuf,
    pub converted: bool,
    pub operation: crate::game::Operation,
}
impl Drop for Candidate {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
pub fn managed_name(name: &str, video: bool) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    let prefix = if video { "custom-video-" } else { "custom-" };
    let Some(id) = stem.strip_prefix(prefix) else {
        return false;
    };
    !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        && if video {
            VIDEOS.contains(&ext)
        } else {
            IMAGES.contains(&ext)
        }
}
pub fn directory(engine: &Engine) -> Result<PathBuf> {
    let root = engine.store.lock().unwrap().directory.clone();
    let directory = paths::within(&root, "backgrounds")?;
    paths::ensure_directory(&directory)?;
    Ok(directory)
}
pub fn saved_path(engine: &Engine, value: &Value, video: bool) -> Result<Option<PathBuf>> {
    let Some(name) = value.as_str().filter(|s| managed_name(s, video)) else {
        return Ok(None);
    };
    let path = paths::within(&directory(engine)?, name)?;
    Ok(path.is_file().then_some(path))
}
pub fn cleanup(engine: &Engine, video: bool, keep: Option<&str>) -> Result<()> {
    for entry in std::fs::read_dir(directory(engine)?)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if Some(name.as_str()) != keep && managed_name(&name, video) && !entry.file_type()?.is_dir()
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}
pub async fn prepare(engine: &Engine, source: &Path, video: bool) -> Result<PathBuf> {
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !(if video { VIDEOS } else { IMAGES }).contains(&ext.as_str()) {
        bail!("This background format is not supported.")
    }
    let mut input = tokio::fs::File::open(source).await?;
    let info = input.metadata().await?;
    let limit = if video { VIDEO_LIMIT } else { 25 * 1024 * 1024 };
    if !info.is_file() || info.len() == 0 || info.len() > limit {
        bail!("Choose an image up to 25 MB or a video up to 200 MB.")
    }
    let prefix = if video { "custom-video-" } else { "custom-" };
    let id = if video {
        format!("{:016x}", rand::random::<u64>())
    } else {
        rand::random::<u64>().to_string()
    };
    let path = directory(engine)?.join(format!("{prefix}{id}.{ext}"));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await?;
        let copied = tokio::io::copy(&mut (&mut input).take(limit + 1), &mut output).await?;
        output.flush().await?;
        if copied != info.len() {
            bail!("The selected background changed while it was being copied.")
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(path)
}
pub fn commit(engine: &Engine, path: &Path, video: bool) -> Result<()> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .context("Invalid background file")?;
    if !managed_name(name, video) || path.parent() != Some(directory(engine)?.as_path()) {
        bail!("Invalid background file.")
    }
    let store = engine.store.lock().unwrap();
    let mut settings = store
        .get("launcher", "settings")?
        .unwrap_or_else(|| json!({}));
    settings[if video {
        "customVideo"
    } else {
        "customBackground"
    }] = json!(name);
    store.put("launcher", "settings", &settings)?;
    drop(store);
    if let Err(error) = cleanup(engine, video, Some(name)) {
        engine.record(&format!("background cleanup deferred: {error}"));
    }
    Ok(())
}
async fn digest(path: &Path) -> Result<String> {
    let mut input = tokio::fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; 1024 * 1024];
    loop {
        let n = input.read(&mut bytes).await?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
async fn download(engine: &Engine, asset: &Value, target: &Path) -> Result<()> {
    let name = asset["name"].as_str().context("Invalid media component")?;
    let size = asset["size"]
        .as_u64()
        .context("Invalid media component size")?;
    let expected = asset["sha256"]
        .as_str()
        .context("Invalid media component checksum")?;
    let response = engine
        .client
        .get(format!(
            "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/{name}"
        ))
        .timeout(Duration::from_secs(600))
        .send()
        .await?
        .error_for_status()?;
    transfer::validate_url(response.url().as_str())?;
    let temp = target.with_extension(format!("download-{:016x}", rand::random::<u64>()));
    let result = async {
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await?;
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut hash = Sha256::new();
        while let Some(bytes) = stream.next().await {
            let bytes = bytes?;
            received = received
                .checked_add(bytes.len() as u64)
                .context("Component too large")?;
            if received > size {
                bail!("The video component download is invalid.")
            }
            output.write_all(&bytes).await?;
            hash.update(&bytes);
        }
        output.flush().await?;
        drop(output);
        if received != size || hex::encode(hash.finalize()) != expected {
            bail!("The video component did not pass verification.")
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700)).await?;
        }
        paths::replace(&temp, target)?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let _ = tokio::fs::remove_file(temp).await;
    result
}
pub async fn converter(engine: &Engine) -> Result<PathBuf> {
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path).filter(|p| p.is_absolute()) {
            let path = directory.join(name);
            if !path.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(&path)?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Ok(path);
        }
    }
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => bail!("Video conversion is unavailable on this device."),
    };
    let assets: Value =
        serde_json::from_str(include_str!("../../src/main/mediaConverterAssets.json"))?;
    let entry = &assets[format!("{platform}-{architecture}")];
    if entry.is_null() {
        bail!("Video conversion is unavailable on this device.")
    }
    let root = engine.store.lock().unwrap().directory.clone();
    let directory = paths::within(&root, "runtimes/media-b6.1.1")?;
    paths::ensure_directory(&directory)?;
    let binary = paths::within(&directory, name)?;
    if digest(&binary).await.ok().as_deref() == entry["binary"]["sha256"].as_str() {
        return Ok(binary);
    }
    for notice in entry["notices"]
        .as_array()
        .context("Missing media notices")?
    {
        let path = paths::within(
            &directory,
            notice["name"].as_str().context("Invalid media notice")?,
        )?;
        if digest(&path).await.ok().as_deref() != notice["sha256"].as_str() {
            download(engine, notice, &path).await?;
        }
    }
    download(engine, &entry["binary"], &binary).await?;
    Ok(binary)
}
pub async fn convert(engine: &Arc<Engine>, candidate: &mut Candidate) -> Result<()> {
    let executable = converter(engine).await?;
    let output =
        directory(engine)?.join(format!("custom-video-{:016x}.mp4", rand::random::<u64>()));
    let mut command = tokio::process::Command::new(executable);
    command.args(["-nostdin","-hide_banner","-loglevel","error","-protocol_whitelist","file,pipe","-i"]).arg(&candidate.path)
        .args(["-map","0:v:0","-an","-sn","-dn","-vf","scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2","-c:v","libx264","-preset","fast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-fs","209715201","-n"]).arg(&output)
        .kill_on_drop(true).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(1200), command.status()).await;
    if !matches!(result,Ok(Ok(status)) if status.success())
        || tokio::fs::metadata(&output)
            .await
            .map(|m| m.len() == 0 || m.len() > VIDEO_LIMIT)
            .unwrap_or(true)
    {
        let _ = tokio::fs::remove_file(&output).await;
        bail!("The video could not be converted. Try another video.")
    }
    let _ = tokio::fs::remove_file(&candidate.path).await;
    candidate.path = output;
    candidate.converted = true;
    Ok(())
}
