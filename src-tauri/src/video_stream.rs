use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};

#[derive(Clone)]
enum Source {
    File(PathBuf),
    Bytes(Arc<[u8]>),
}
#[derive(Clone)]
struct Entry {
    source: Source,
    mime: &'static str,
    identity: String,
}
pub struct VideoStream {
    address: std::net::SocketAddr,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for VideoStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl VideoStream {
    pub async fn start() -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let entries = Arc::new(Mutex::new(HashMap::<String, Entry>::new()));
        let registry = entries.clone();
        let permits = Arc::new(Semaphore::new(8));
        let task = tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    continue;
                };
                let registry = registry.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = serve(socket, address, registry).await;
                });
            }
        });
        Ok(Self {
            address,
            entries,
            task,
        })
    }
    fn register(&self, source: Source, mime: &'static str, identity: String) -> String {
        if let Some(url) = self.existing(&identity) {
            return url;
        }
        let token = format!("{:032x}", rand::random::<u128>());
        let mut entries = self.entries.lock().unwrap();
        if let Some((token, _)) = entries.iter().find(|(_, entry)| entry.identity == identity) {
            return format!("http://{}/{token}", self.address);
        }
        if entries.len() >= 8 {
            entries.retain(|_, entry| matches!(entry.source, Source::Bytes(_)));
        }
        entries.insert(
            token.clone(),
            Entry {
                source,
                mime,
                identity,
            },
        );
        format!("http://{}/{token}", self.address)
    }
    pub fn existing(&self, identity: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, entry)| entry.identity == identity)
            .map(|(token, _)| format!("http://{}/{token}", self.address))
    }
    pub fn file(&self, path: PathBuf) -> String {
        let mime = mime(&path.to_string_lossy());
        let identity = path.to_string_lossy().into_owned();
        self.register(Source::File(path), mime, identity)
    }
    pub fn bytes(&self, bytes: Vec<u8>, name: &str) -> String {
        self.register(Source::Bytes(bytes.into()), mime(name), name.into())
    }
}
fn mime(path: &str) -> &'static str {
    if path.ends_with(".webm") {
        "video/webm"
    } else {
        "video/mp4"
    }
}
fn range(header: Option<&str>, size: u64) -> Result<(u64, u64, bool)> {
    ensure!(size > 0, "Empty video");
    let Some(value) = header else {
        return Ok((0, size - 1, false));
    };
    let (start, end) = value
        .strip_prefix("bytes=")
        .context("Invalid range")?
        .split_once('-')
        .context("Invalid range")?;
    let (start, end) = if start.is_empty() {
        let count = end.parse::<u64>()?;
        ensure!(count > 0, "Invalid suffix");
        (size.saturating_sub(count), size - 1)
    } else {
        (
            start.parse()?,
            if end.is_empty() {
                size - 1
            } else {
                end.parse::<u64>()?.min(size - 1)
            },
        )
    };
    ensure!(start < size && start <= end, "Unsatisfiable range");
    Ok((start, end, true))
}
async fn serve(
    mut socket: TcpStream,
    address: std::net::SocketAddr,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
) -> Result<()> {
    let mut header = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !header.ends_with(b"\r\n\r\n") {
            ensure!(header.len() < 8192, "Oversized request");
            let byte = socket.read_u8().await?;
            header.push(byte);
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let text = std::str::from_utf8(&header)?;
    let mut lines = text.split("\r\n");
    let request = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>();
    ensure!(
        request.len() == 3 && ["GET", "HEAD"].contains(&request[0]) && request[2] == "HTTP/1.1",
        "Unsupported request"
    );
    let mut host = None;
    let mut requested = None;
    for line in lines.filter(|s| !s.is_empty()) {
        let (name, value) = line.split_once(':').context("Invalid header")?;
        if name.eq_ignore_ascii_case("host") {
            ensure!(host.is_none(), "Duplicate host");
            host = Some(value.trim());
        }
        if name.eq_ignore_ascii_case("range") {
            ensure!(requested.is_none(), "Duplicate range");
            requested = Some(value.trim());
        }
    }
    ensure!(
        host == Some(address.to_string().as_str()),
        "Wrong media host"
    );
    let token = request[1].strip_prefix('/').context("Invalid media path")?;
    let entry = entries.lock().unwrap().get(token).cloned();
    let Some(entry) = entry else {
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };
    let (mut file, bytes, size) = match entry.source {
        Source::File(path) => {
            use std::os::unix::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)?;
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file() && metadata.len() <= crate::media::VIDEO_LIMIT,
                "Invalid video"
            );
            (Some(tokio::fs::File::from_std(file)), None, metadata.len())
        }
        Source::Bytes(bytes) => {
            let size = bytes.len() as u64;
            (None, Some(bytes), size)
        }
    };
    let (start, end, partial) = match range(requested, size) {
        Ok(value) => value,
        Err(_) => {
            socket.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await?;
            return Ok(());
        }
    };
    let count = end - start + 1;
    let status = if partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let extra = if partial {
        format!("Content-Range: bytes {start}-{end}/{size}\r\n")
    } else {
        String::new()
    };
    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{extra}\r\n",entry.mime).as_bytes()).await?;
    if request[0] == "HEAD" {
        return Ok(());
    }
    if let Some(file) = file.as_mut() {
        file.seek(std::io::SeekFrom::Start(start)).await?;
        tokio::io::copy(&mut file.take(count), &mut socket).await?;
    } else if let Some(bytes) = bytes {
        socket
            .write_all(&bytes[start as usize..=end as usize])
            .await?;
    } else {
        bail!("Missing video")
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stream_limits_access_and_serves_seek_ranges() {
        let server = VideoStream::start().await.unwrap();
        let url = server.bytes(b"0123456789".to_vec(), "test.mp4");
        assert_eq!(server.bytes(b"0123456789".to_vec(), "test.mp4"), url);
        for number in 0..12 {
            server.file(PathBuf::from(format!("/unused/{number}.mp4")));
        }
        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header("Range", "bytes=3-6")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 3-6/10");
        assert_eq!(response.bytes().await.unwrap(), "3456");
        assert_eq!(
            client.head(&url).send().await.unwrap().headers()["content-length"],
            "10"
        );
        assert_eq!(
            client
                .get(&url)
                .header("Range", "bytes=99-")
                .send()
                .await
                .unwrap()
                .status(),
            416
        );
        assert_eq!(
            client
                .get(format!("http://{}/guess", server.address))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert!(
            client
                .get(&url)
                .header("Host", "evil.example")
                .send()
                .await
                .is_err()
        );
        assert_eq!(range(Some("bytes=-3"), 10).unwrap(), (7, 9, true));
        assert!(range(Some("bytes=0-1,3-4"), 10).is_err());
    }
}
