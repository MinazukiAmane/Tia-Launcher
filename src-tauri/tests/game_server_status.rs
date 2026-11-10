use std::sync::{Arc, Mutex};
use tia_launcher::{feeds::Feeds, game::engine::Engine, store::Store};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn accepts_offline_status_without_turning_it_into_maintenance() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let body = serde_json::json!({"status":"offline","checkedAt":chrono::Utc::now().to_rfc3339()}).to_string();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let count = socket.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /api/game_status "));
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Mutex::new(Store::open(&directory.path().join("profile"), &[9; 32]).unwrap()));
    let engine = Engine::with_keys(store, format!("http://{address}"), directory.path().join("resources"), vec![]).unwrap();
    let feeds = Feeds::default();
    let result = feeds.status(&engine, "").await;
    assert_eq!(result["status"], "offline");
    assert_eq!(feeds.status(&engine, "").await, result);
    server.await.unwrap();
}
