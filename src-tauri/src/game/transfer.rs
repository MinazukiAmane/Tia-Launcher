use super::{Control, Paused, Progress, model::Package};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use md5::{Digest, Md5};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
pub fn validate_url(text: &str) -> Result<url::Url> {
    let url = url::Url::parse(text)?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        bail!("The download address is not secure.")
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Invalid download address.")
    }
    Ok(url)
}
pub fn md5_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Md5::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
pub async fn checked_md5(path: PathBuf) -> Result<String> {
    tokio::task::spawn_blocking(move || md5_file(&path)).await?
}
pub async fn bounded_body(response: reqwest::Response, cap: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        bail!("The update service response is too large.")
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > cap {
            bail!("The update service response is too large.")
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
pub async fn download(
    client: &reqwest::Client,
    part: &Package,
    path: &Path,
    limit: Option<u64>,
    control: &Arc<Control>,
    progress: &Progress,
    phase: &str,
    base: u64,
    total: u64,
) -> Result<()> {
    validate_url(&part.url)?;
    if part.md5.len() != 32 || hex::decode(&part.md5).is_err() {
        bail!("The update service returned invalid package information.")
    }
    for attempt in 0..4 {
        control.check()?;
        let result = download_once(
            client, part, path, limit, control, progress, phase, base, total,
        )
        .await;
        match result {
            Ok(()) => return Ok(()),
            Err(error) if error.is::<Paused>() => return Err(error),
            Err(error) => {
                if attempt == 3 || error.downcast_ref::<std::io::Error>().is_some() {
                    return Err(error.context("The download could not finish. Your downloaded data is retained for retry."));
                }
                tokio::select! {_=control.cancelled()=>return Err(Paused.into()),_=tokio::time::sleep(Duration::from_millis(500<<attempt))=>{}}
            }
        }
    }
    unreachable!()
}
async fn download_once(
    client: &reqwest::Client,
    part: &Package,
    path: &Path,
    limit: Option<u64>,
    control: &Arc<Control>,
    progress: &Progress,
    phase: &str,
    base: u64,
    total: u64,
) -> Result<()> {
    if part.size == 0 {
        if !part
            .md5
            .eq_ignore_ascii_case("d41d8cd98f00b204e9800998ecf8427e")
        {
            bail!("Invalid empty-file hash.")
        }
        if let Ok(info) = tokio::fs::symlink_metadata(path).await {
            if !info.is_file() || crate::paths::linked(&info) {
                bail!("Unsafe empty-file cache path.")
            }
        }
        tokio::fs::File::create(path).await?.flush().await?;
        return Ok(());
    }
    let mut offset = match tokio::fs::symlink_metadata(path).await {
        Ok(info) => {
            if !info.is_file() || crate::paths::linked(&info) {
                bail!("The download cache contains an unsafe file.")
            }
            info.len()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    if offset == part.size
        && checked_md5(path.to_path_buf())
            .await?
            .eq_ignore_ascii_case(&part.md5)
    {
        progress(phase, base + part.size, total);
        return Ok(());
    }
    if offset >= part.size {
        tokio::fs::remove_file(path).await?;
        offset = 0;
    }
    let mut request = client.get(&part.url).header("Accept-Encoding", "identity");
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let response = tokio::select! {_=control.cancelled()=>return Err(Paused.into()),response=request.send()=>response?};
    validate_url(response.url().as_str())?;
    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let value = response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let expected = format!("bytes {offset}-");
        let parsed = value
            .strip_prefix(&expected)
            .and_then(|v| v.split_once('/'))
            .and_then(|(end, total)| Some((end.parse::<u64>().ok()?, total.parse::<u64>().ok()?)));
        if !parsed
            .is_some_and(|(end, total)| total == part.size && end.checked_add(1) == Some(part.size))
        {
            bail!("The server returned an invalid resumed download.")
        }
    } else if response.status().is_success() {
        offset = 0;
    } else {
        bail!(
            "Download service returned HTTP {}.",
            response.status().as_u16()
        )
    }
    if response
        .content_length()
        .is_some_and(|n| n != part.size - offset)
    {
        bail!("The server returned an incorrect download size.")
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .append(offset > 0)
        .open(path)
        .await?;
    let started = Instant::now();
    let initial = offset;
    let mut stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {_=control.cancelled()=>{file.flush().await?;return Err(Paused.into())},next=tokio::time::timeout(Duration::from_secs(30),stream.next())=>next.context("The download stopped responding.")?};
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        offset = offset
            .checked_add(chunk.len() as u64)
            .context("Download size overflow")?;
        if offset > part.size {
            bail!("The server sent more data than expected.")
        }
        file.write_all(&chunk).await?;
        progress(phase, base + offset, total);
        if let Some(limit) = limit.filter(|n| *n > 0) {
            let expected = Duration::from_secs_f64((offset - initial) as f64 / limit as f64);
            if let Some(wait) = expected.checked_sub(started.elapsed()) {
                tokio::select! {_=control.cancelled()=>{file.flush().await?;return Err(Paused.into())},_=tokio::time::sleep(wait)=>{}}
            }
        }
    }
    file.flush().await?;
    drop(file);
    if offset != part.size {
        bail!("The download ended before the file was complete.")
    }
    if !checked_md5(path.to_path_buf())
        .await?
        .eq_ignore_ascii_case(&part.md5)
    {
        tokio::fs::remove_file(path).await?;
        bail!("The downloaded file failed verification. It will be downloaded again.")
    }
    Ok(())
}
pub async fn parts(
    client: &reqwest::Client,
    packages: &[Package],
    directory: &Path,
    limit: Option<u64>,
    control: &Arc<Control>,
    progress: &Progress,
    phase: &str,
) -> Result<Vec<PathBuf>> {
    if packages.is_empty() || packages.len() > 4096 {
        bail!("The update does not contain valid package parts.")
    }
    crate::paths::ensure_directory(directory)?;
    let total = packages
        .iter()
        .try_fold(0u64, |n, p| n.checked_add(p.size))
        .context("Package size overflow")?;
    let mut base = 0;
    let mut paths = Vec::new();
    for part in packages {
        let path = directory.join(format!("part-{}", part.md5));
        if part.md5.len() != 32 || !part.md5.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Invalid package hash.")
        }
        download(
            client, part, &path, limit, control, progress, phase, base, total,
        )
        .await?;
        base += part.size;
        paths.push(path);
    }
    Ok(paths)
}
