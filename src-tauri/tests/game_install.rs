use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
use md5::{Digest, Md5};
use serde_json::json;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tia_launcher::{
    game::{engine::Engine, model::Definition},
    manifest::PublicKey,
    store::Store,
};
fn hash(bytes: &[u8]) -> String {
    hex::encode(Md5::digest(bytes))
}
struct Server {
    base: String,
    routes: Arc<Mutex<HashMap<String, (Vec<u8>, String)>>>,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
}
impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = Arc::new(Mutex::new(HashMap::<String, (Vec<u8>, String)>::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (r, q, s) = (routes.clone(), requests.clone(), stop.clone());
        thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                if !request.ends_with(b"\r\n\r\n") {
                    continue;
                }
                let text = String::from_utf8_lossy(&request);
                let target = text.split_whitespace().nth(1).unwrap_or("/");
                let path = url::Url::parse(target)
                    .map(|url| url.path().to_owned())
                    .unwrap_or_else(|_| target.split('?').next().unwrap_or("/").to_owned());
                q.lock().unwrap().push(path.clone());
                let item = r.lock().unwrap().get(&path).cloned();
                if let Some((body, headers)) = item {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
                        body.len(),
                        headers
                    );
                    let _ = stream.write_all(&body);
                } else {
                    eprintln!(
                        "Test HTTP route not configured: {target}; request: {:?}",
                        text.lines().next()
                    );
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
        });
        Self {
            base,
            routes,
            requests,
            stop,
        }
    }
    fn put(&self, path: &str, body: Vec<u8>, headers: String) {
        self.routes
            .lock()
            .unwrap()
            .insert(path.into(), (body, headers));
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
#[test]
fn incomplete_proxy_connections_are_not_routed_as_requests() {
    let server = Server::start();
    let mut connection =
        std::net::TcpStream::connect(server.base.strip_prefix("http://").unwrap()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    connection.write_all(b"GET").unwrap();
    connection.shutdown(std::net::Shutdown::Write).unwrap();
    let mut response = Vec::new();
    connection.read_to_end(&mut response).unwrap();
    assert!(response.is_empty());
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn signed_install_repairs_only_changed_file_and_rejects_unsigned_manifest() {
    exercise_signed_install(false, false).await;
}
#[tokio::test]
async fn signed_install_also_works_through_an_explicit_http_proxy() {
    exercise_signed_install(true, false).await;
}
#[tokio::test]
async fn predownload_keeps_game_unchanged_and_reuses_verified_parts_on_release() {
    exercise_signed_install(false, true).await;
}
async fn exercise_signed_install(proxy: bool, predownload: bool) {
    let server = Server::start();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Game");
    std::fs::create_dir(&root).unwrap();
    let content = b"first-party test client";
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    archive
        .start_file("Bin/client.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(content).unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let midpoint = bytes.len() / 2;
    for (index, part) in [&bytes[..midpoint], &bytes[midpoint..]].iter().enumerate() {
        server.put(&format!("/part{index}"), part.to_vec(), String::new());
    }
    server.put("/repair", content.to_vec(), String::new());
    let key = SigningKey::from_bytes(&[31; 32]);
    let public = PublicKey {
        id: "test-key".into(),
        public_key: key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap(),
    };
    let manifest=serde_json::to_vec(&json!({"version":"1.0","repair_supported":true,"files":[{"path":"Bin/client.exe","size":content.len(),"md5":hash(content),"url":format!("{}/repair",server.base)}]})).unwrap();
    let mut message = b"Tia version manifest v1\0csore_global\0".to_vec();
    message.extend(&manifest);
    let headers = format!(
        "X-Tia-Manifest-Key: test-key\r\nX-Tia-Manifest-Game: csore_global\r\nX-Tia-Manifest-Signature: {}\r\n",
        STANDARD.encode(key.sign(&message).to_bytes())
    );
    server.put("/manifest", manifest.clone(), headers);
    let parts:Vec<_>=[&bytes[..midpoint],&bytes[midpoint..]].iter().enumerate().map(|(index,part)|json!({"url":format!("{}/part{index}",server.base),"md5":hash(part),"size":part.len().to_string()})).collect();
    let live_info = json!({"retcode":0,"data":{"game_packages":[{"game":{"biz":"csore_global"},"main":{"major":{"version":"1.0","game_pkgs":parts,"res_list_url":format!("{}/manifest",server.base)}}}]}});
    server.put(
        "/api/launcher_info",
        serde_json::to_vec(&live_info).unwrap(),
        String::new(),
    );
    let store = Arc::new(Mutex::new(
        Store::open(&directory.path().join("profile"), &[42; 32]).unwrap(),
    ));
    let mut engine = Engine::with_keys(
        store,
        server.base.clone(),
        directory.path().join("resources"),
        vec![public],
    )
    .unwrap();
    let client = reqwest::Client::builder().no_proxy();
    let client = if proxy {
        client.proxy(reqwest::Proxy::all(&server.base).unwrap())
    } else {
        client
    };
    Arc::get_mut(&mut engine).unwrap().client = client.build().unwrap();
    let game = Definition {
        biz: "csore_global".into(),
        executable: "Bin/client.exe".into(),
        install_folder: "Tia-CSORSE".into(),
    };
    let progress = Arc::new(|_: &str, _: u64, _: u64| {});
    let pause_control = engine.control.clone();
    let pause_progress = Arc::new(move |phase: &str, processed: u64, _: u64| {
        if phase == "downloading" && processed > 0 {
            pause_control.pause();
        }
    });
    if predownload {
        let mut future_info = live_info.clone();
        future_info["data"]["game_packages"][0]["enable_base_pkg_predownload"] = json!(true);
        future_info["data"]["game_packages"][0]["pre_download"] =
            future_info["data"]["game_packages"][0]["main"].clone();
        future_info["data"]["game_packages"][0]["main"]["major"] = serde_json::Value::Null;
        server.put(
            "/api/launcher_info",
            serde_json::to_vec(&future_info).unwrap(),
            String::new(),
        );
        future_info["data"]["game_packages"][0]["enable_base_pkg_predownload"] = json!(false);
        server.put(
            "/api/launcher_info",
            serde_json::to_vec(&future_info).unwrap(),
            String::new(),
        );
        assert!(
            engine
                .predownload(&root, &game, progress.clone())
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("No predownload")
        );
        assert!(
            engine
                .predownload_status(&root, &game)
                .await
                .unwrap()
                .is_none()
        );
        future_info["data"]["game_packages"][0]["enable_base_pkg_predownload"] = json!(true);
        future_info["data"]["game_packages"][0]["pre_download"]["required_client_version"] =
            json!("999.0.0");
        server.put(
            "/api/launcher_info",
            serde_json::to_vec(&future_info).unwrap(),
            String::new(),
        );
        assert!(
            engine
                .predownload(&root, &game, progress.clone())
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("Update the launcher")
        );
        assert!(
            engine
                .predownload_status(&root, &game)
                .await
                .unwrap()
                .unwrap()
                .launcher_update_required
        );
        assert!(
            !engine
                .metadata(&game.biz, true)
                .await
                .unwrap()
                .launcher_update_required
        );
        engine.check_launcher_policy(&game.biz).await.unwrap();
        future_info["data"]["game_packages"][0]["pre_download"]["required_client_version"] =
            json!("");
        server.put(
            "/api/launcher_info",
            serde_json::to_vec(&future_info).unwrap(),
            String::new(),
        );
        assert_eq!(
            engine
                .predownload(&root, &game, pause_progress.clone())
                .await
                .unwrap()
                .status,
            "paused"
        );
        assert!(!engine.control.busy.load(Ordering::SeqCst));
        assert_eq!(
            engine
                .predownload(&root, &game, progress.clone())
                .await
                .unwrap()
                .status,
            "completed"
        );
        assert!(
            engine
                .predownload_status(&root, &game)
                .await
                .unwrap()
                .unwrap()
                .ready
        );
        assert!(!root.join("Bin/client.exe").exists());
        assert!(engine.install_state(&root, &game).unwrap().is_none());
        server.put(
            "/api/launcher_info",
            serde_json::to_vec(&live_info).unwrap(),
            String::new(),
        );
        server.requests.lock().unwrap().clear();
        assert_eq!(
            engine
                .update(&root, &game, progress.clone())
                .await
                .unwrap()
                .status,
            "completed"
        );
        assert_eq!(std::fs::read(root.join("Bin/client.exe")).unwrap(), content);
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.starts_with("/part")),
            "predownloaded parts were downloaded again"
        );
        return;
    }
    let installed = engine.update(&root, &game, pause_progress).await;
    assert!(
        installed.is_ok(),
        "initial install failed: {:?}; request paths: {:?}",
        installed.as_ref().err(),
        server.requests.lock().unwrap()
    );
    assert_eq!(installed.unwrap().status, "paused");
    assert!(!engine.control.busy.load(Ordering::SeqCst));
    assert_eq!(
        engine
            .update(&root, &game, progress.clone())
            .await
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(std::fs::read(root.join("Bin/client.exe")).unwrap(), content);
    assert!(engine.verify(&root, &game, true).await.unwrap().ok);
    server.requests.lock().unwrap().clear();
    std::fs::write(root.join("Bin/client.exe"), b"corrupted").unwrap();
    assert_eq!(
        engine
            .repair(&root, &game, progress.clone())
            .await
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(std::fs::read(root.join("Bin/client.exe")).unwrap(), content);
    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(
        requests.iter().filter(|p| p.as_str() == "/repair").count(),
        1
    );
    assert!(!requests.iter().any(|p| p.starts_with("/part")));
    server.put("/manifest", manifest, String::new());
    assert!(engine.update(&root, &game, progress).await.is_err());
    assert!(!engine.control.busy.load(Ordering::SeqCst));
    assert_eq!(std::fs::read(root.join("Bin/client.exe")).unwrap(), content);
    let destination = directory.path().join("Moved Game");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("unrelated.txt"), b"keep destination").unwrap();
    assert!(
        engine
            .move_installation(
                &root,
                &destination,
                &game,
                "launcher",
                Arc::new(|_, _, _| {})
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(destination.join("unrelated.txt")).unwrap(),
        b"keep destination"
    );
    std::fs::remove_file(destination.join("unrelated.txt")).unwrap();
    let destination_scope = tia_launcher::paths::scope(&destination).unwrap();
    engine
        .store
        .lock()
        .unwrap()
        .put(
            &destination_scope,
            "install",
            &serde_json::json!({"version":"other"}),
        )
        .unwrap();
    assert!(
        engine
            .move_installation(
                &root,
                &destination,
                &game,
                "launcher",
                Arc::new(|_, _, _| {})
            )
            .await
            .is_err()
    );
    assert!(root.join("Bin/client.exe").is_file());
    assert!(std::fs::read_dir(&destination).unwrap().next().is_none());
    engine
        .store
        .lock()
        .unwrap()
        .put(&destination_scope, "install", &serde_json::Value::Null)
        .unwrap();
    std::fs::write(root.join("personal.txt"), b"keep me").unwrap();
    let moved = engine
        .move_installation(
            &root,
            &destination,
            &game,
            "launcher",
            Arc::new(|_, _, _| {}),
        )
        .await
        .unwrap();
    let expected_destination =
        tia_launcher::paths::user_path(&std::fs::canonicalize(&destination).unwrap());
    assert_eq!(moved["installDir"], serde_json::json!(expected_destination));
    assert!(!root.exists());
    assert_eq!(
        std::fs::read(destination.join("Bin/client.exe")).unwrap(),
        content
    );
    assert_eq!(
        engine
            .store
            .lock()
            .unwrap()
            .get("launcher", "selectedInstallation")
            .unwrap()
            .unwrap()["installDir"],
        serde_json::json!(expected_destination)
    );
    engine
        .uninstall_game(&destination, &game, "launcher")
        .await
        .unwrap();
    assert!(!destination.join("Bin/client.exe").exists());
    assert_eq!(
        std::fs::read(destination.join("personal.txt")).unwrap(),
        b"keep me"
    );
    assert!(!engine.control.busy.load(Ordering::SeqCst));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn launch_waits_for_ready_and_preserves_runtime_environment_and_arguments() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("profile");
    let root = directory.path().join("Game");
    let resources = directory.path().join("resources");
    std::fs::create_dir_all(root.join("Bin")).unwrap();
    std::fs::create_dir_all(resources.join("client-runtime")).unwrap();
    std::fs::write(
        resources.join("client-runtime/csore-start-x86.exe"),
        b"opaque helper fixture",
    )
    .unwrap();
    let mut executable = vec![0u8; 128];
    executable[..2].copy_from_slice(b"MZ");
    executable[60..64].copy_from_slice(&64u32.to_le_bytes());
    executable[64..68].copy_from_slice(b"PE\0\0");
    executable[68..70].copy_from_slice(&0x14cu16.to_le_bytes());
    executable[84..86].copy_from_slice(&2u16.to_le_bytes());
    executable[88..90].copy_from_slice(&0x10bu16.to_le_bytes());
    std::fs::write(root.join("Bin/client.exe"), executable).unwrap();
    let store = Arc::new(Mutex::new(Store::open(&profile, &[43; 32]).unwrap()));
    let proton = profile.join("runtimes/proton/dwproton-fixture");
    std::fs::create_dir_all(&proton).unwrap();
    std::fs::write(proton.join("proton"), b"fixture").unwrap();
    let umu = profile.join("runtimes/umu/umu-run");
    std::fs::create_dir_all(umu.parent().unwrap()).unwrap();
    std::fs::write(
        &umu,
        r#"#!/bin/sh
if [ "$1" = '--version' ]; then
 printf '%s\n' 'umu-launcher version 1.4.4'
 exit 0
fi
test -f "$1" || exit 41
case "$1" in
  */runtime-report-*/csore-start-x86.exe) ;;
  *) exit 42 ;;
esac
report=$(printf '%s' "${2#Z:}" | tr '\\' '/')
shift 2
printf '%s\n' "$@" > "$WINEPREFIX/arguments.txt"
printf '%s' "$STEAM_COMPAT_INSTALL_PATH" >> "$WINEPREFIX/arguments.txt"
printf 'ready\nflags_before_resume: 1\n' > "$report"
sleep 0.2
"#,
    )
    .unwrap();
    std::fs::set_permissions(&umu, std::fs::Permissions::from_mode(0o700)).unwrap();
    let engine = Engine::with_keys(store, "http://127.0.0.1:1".into(), resources, vec![]).unwrap();
    let game = Definition {
        biz: "csore_global".into(),
        executable: "Bin/client.exe".into(),
        install_folder: "Tia-CSORSE".into(),
    };
    let mut session = tia_launcher::game::launch::start(
        &engine,
        &root,
        &game,
        &json!({"lang":"na_id","launchCommand":"-port 30003"}),
        Arc::new(|_, _, _| {}),
    )
    .await
    .unwrap();
    assert!(engine.control.running.load(Ordering::SeqCst));
    assert!(session.child.wait().await.unwrap().success());
    let args = std::fs::read_to_string(profile.join("runtimes/prefix/arguments.txt")).unwrap();
    assert!(args.contains("-lang\nna_id\n-port\n30003"));
    assert!(args.ends_with(root.join("Bin").to_str().unwrap()));
    assert!(session.staging.join("status.txt").is_file());
    assert_eq!(
        std::fs::read(session.staging.join("csore-start-x86.exe")).unwrap(),
        b"opaque helper fixture"
    );
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires the first-party Windows clients and native runtime fixtures"]
async fn windows_real_native_helpers_initialize_both_architectures_and_forward_options() {
    let fixture_root = std::env::var_os("TIA_NATIVE_FIXTURE_DIR")
        .expect("TIA_NATIVE_FIXTURE_DIR must point to the first-party clients");
    let resources = std::env::var_os("TIA_NATIVE_RESOURCE_DIR")
        .expect("TIA_NATIVE_RESOURCE_DIR must point to the native runtime resources");
    for architecture in ["x86", "x64"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("Game");
        std::fs::create_dir_all(root.join("Bin")).unwrap();
        std::fs::copy(
            std::path::Path::new(&fixture_root).join(format!("client-{architecture}.exe")),
            root.join("Bin/client.exe"),
        )
        .unwrap();
        let store = Arc::new(Mutex::new(
            Store::open(&directory.path().join("profile"), &[61; 32]).unwrap(),
        ));
        let engine = Engine::with_keys(
            store,
            "http://127.0.0.1:1".into(),
            resources.clone().into(),
            vec![],
        )
        .unwrap();
        let game = Definition {
            biz: "csore_global".into(),
            executable: "Bin/client.exe".into(),
            install_folder: "Tia-CSORSE".into(),
        };
        let mut session=tia_launcher::game::launch::start(&engine,&root,&game,&json!({"lang":"na_id","classicUi":true,"fpsLimit":240,"launchCommand":"-ip server.example -port 30003 -name \"Player One\""}),Arc::new(|_,_,_|{})).await.unwrap();
        assert!(session.child.wait().await.unwrap().success());
        let report = std::fs::read_to_string(root.join("Bin/native-startup-result.txt")).unwrap();
        assert_eq!(
            report,
            "flags=1\n-lang\nna_id\n--classicui\n+developer\n1\n+fps_max\n240\n-ip\nserver.example\n-port\n30003\n-name\nPlayer One\n"
        );
    }
}

#[tokio::test]
async fn minimum_launcher_is_enforced_by_backend_and_retained_when_api_goes_down() {
    let server = Server::start();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Game");
    std::fs::create_dir(&root).unwrap();
    let store = Arc::new(Mutex::new(
        Store::open(&directory.path().join("profile"), &[29; 32]).unwrap(),
    ));
    let mut engine = Engine::with_keys(
        store,
        server.base.clone(),
        directory.path().join("resources"),
        vec![],
    )
    .unwrap();
    Arc::get_mut(&mut engine).unwrap().client =
        reqwest::Client::builder().no_proxy().build().unwrap();
    let game = Definition {
        biz: "csore_global".into(),
        executable: "Bin/client.exe".into(),
        install_folder: "Tia-CSORSE".into(),
    };
    server.put("/api/launcher_info",serde_json::to_vec(&json!({"retcode":0,"data":{"game_packages":[{"game":{"biz":"csore_global"},"main":{"required_client_version":"999.0.0","major":null},"pre_download":{"required_client_version":"999.0.0","major":null}}]}})).unwrap(),String::new());
    assert!(
        engine
            .metadata(&game.biz, false)
            .await
            .unwrap()
            .launcher_update_required
    );
    let progress = Arc::new(|_: &str, _: u64, _: u64| {});
    for operation in [
        engine.update(&root, &game, progress.clone()).await,
        engine.predownload(&root, &game, progress.clone()).await,
        engine.repair(&root, &game, progress.clone()).await,
    ] {
        assert!(
            operation
                .err()
                .unwrap()
                .to_string()
                .contains("Update the launcher")
        );
    }
    assert!(
        engine
            .play(&root, &game, &json!({}), progress)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("Update the launcher")
    );
    server.routes.lock().unwrap().remove("/api/launcher_info");
    assert!(engine.metadata(&game.biz, false).await.is_err());
    // Reopen the engine to discard its in-memory metadata cache.
    let mut reopened = Engine::with_keys(
        engine.store.clone(),
        server.base.clone(),
        directory.path().join("resources"),
        vec![],
    )
    .unwrap();
    Arc::get_mut(&mut reopened).unwrap().client =
        reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(
        reopened
            .check_launcher_policy(&game.biz)
            .await
            .unwrap_err()
            .to_string()
            .contains("Update the launcher")
    );
    assert!(!root.join("Bin").exists());
}
