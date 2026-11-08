use serde_json::json;
use std::sync::{Arc, Mutex};
use tia_launcher::{
    feeds::{custom_server, parse_silver, plain_text},
    game::engine::Engine,
    media,
    store::Store,
};
#[tokio::test]
async fn image_replacement_keeps_video_and_clear_keeps_unmanaged_files() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("profile");
    let store = Arc::new(Mutex::new(Store::open(&profile, &[9; 32]).unwrap()));
    let engine = Engine::with_keys(
        store,
        "http://127.0.0.1:1".into(),
        dir.path().join("resources"),
        vec![],
    )
    .unwrap();
    let source = dir.path().join("image.gif");
    std::fs::write(&source, b"GIF89a fixture").unwrap();
    let first = media::prepare(&engine, &source, false).await.unwrap();
    media::commit(&engine, &first, false).unwrap();
    assert!(
        first
            .file_stem()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("custom-")
            .unwrap()
            .bytes()
            .all(|b| b.is_ascii_digit())
    );
    let video = media::directory(&engine)
        .unwrap()
        .join("custom-video-aabb.mp4");
    std::fs::write(&video, b"video").unwrap();
    let unrelated = media::directory(&engine)
        .unwrap()
        .join("personal-photo.png");
    std::fs::write(&unrelated, b"personal").unwrap();
    let second = media::prepare(&engine, &source, false).await.unwrap();
    media::commit(&engine, &second, false).unwrap();
    assert!(!first.exists());
    assert!(second.exists());
    assert!(video.exists());
    assert!(unrelated.exists());
    media::cleanup(&engine, false, None).unwrap();
    assert!(!second.exists());
    assert!(video.exists());
    assert!(unrelated.exists());
    assert!(!media::managed_name("../custom-aa.png", false));
    assert!(!media::managed_name("custom-aa.exe", false));
    assert!(
        media::saved_path(&engine, &json!("../image.gif"), false)
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read(source).unwrap(), b"GIF89a fixture");
}
#[test]
fn notices_preserve_escaped_text_and_reject_duplicate_identity() {
    assert_eq!(
        plain_text("<Title>Hello</> &lt;player&gt; &#x1f600;"),
        "Hello <player> 😀"
    );
    let row = json!({"noticeId":1,"noticeType":2,"contentList":[{"languageType":"en","longTitle":"Event","shortTitle":"Event","noticeContent":"<b>Welcome</>"}]});
    let result = parse_silver(&json!({"code":0,"ret":{"data":[row.clone()]}})).unwrap();
    assert_eq!(result[0]["translations"][0]["content"], "Welcome");
    assert_eq!(result[0]["category"], "event");
    let mut localized = row.clone();
    localized["contentList"][0]["longTitle"] = json!("日".repeat(120));
    assert!(parse_silver(&json!({"code":0,"ret":{"data":[localized]}})).is_ok());
    assert!(parse_silver(&json!({"code":0,"ret":{"data":[row.clone(),row]}})).is_err());
}
#[test]
fn custom_server_requires_valid_client_arguments() {
    for value in ["-port 30003", "-ip server.example", "-port 65535"] {
        assert!(custom_server(value), "{value}");
    }
    for value in [
        "-port",
        "-port 0",
        "-port 65536",
        "-ip -foo",
        "-name '-port 30003'",
        "env PORT=30003 %command%",
    ] {
        assert!(!custom_server(value), "{value}");
    }
}

#[tokio::test]
async fn conversion_removes_audio_and_keeps_original_file() {
    use std::process::Command;
    if Command::new("ffmpeg").arg("-version").output().is_err() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mkv");
    assert!(
        Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x64:r=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "0.4",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-y"
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success()
    );
    let original = std::fs::read(&source).unwrap();
    let store = Arc::new(Mutex::new(
        Store::open(&dir.path().join("profile"), &[10; 32]).unwrap(),
    ));
    let engine = Engine::with_keys(
        store,
        "http://127.0.0.1:1".into(),
        dir.path().join("resources"),
        vec![],
    )
    .unwrap();
    let path = media::prepare(&engine, &source, true).await.unwrap();
    let mut candidate = media::Candidate {
        token: "test".into(),
        path,
        converted: false,
        operation: engine.control.acquire().unwrap(),
    };
    media::convert(&engine, &mut candidate).await.unwrap();
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
        ])
        .arg(&candidate.path)
        .output()
        .unwrap();
    assert!(probe.status.success());
    let result: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
    assert_eq!(result["streams"].as_array().unwrap().len(), 1);
    assert_eq!(result["streams"][0]["codec_type"], "video");
    assert_eq!(std::fs::read(source).unwrap(), original);
    let path = candidate.path.clone();
    drop(candidate);
    assert!(!path.exists());
    assert!(
        !engine
            .control
            .busy
            .load(std::sync::atomic::Ordering::SeqCst)
    );
}
