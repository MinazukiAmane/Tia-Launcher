#![cfg(unix)]
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha512};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
};
use tia_launcher::{
    bridge_ops,
    unix_update::{self, BundleIdentity, Startup},
};
fn digest(bytes: &[u8]) -> String {
    STANDARD.encode(Sha512::digest(bytes))
}
fn image() -> Vec<u8> {
    [b"\x7fELF\x02\x01\x01\0AI\x02\0".as_slice(), b"replacement"].concat()
}
fn image_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let current = root.join("Custom Tia Launcher.AppImage");
    let download = root.join("download.AppImage");
    fs::write(&current, b"original launcher").unwrap();
    fs::set_permissions(&current, fs::Permissions::from_mode(0o751)).unwrap();
    fs::write(&download, image()).unwrap();
    (dir, current, download)
}
#[test]
fn appimage_replacement_preserves_path_permissions_and_rolls_back_on_failed_start() {
    let (_dir, current, download) = image_fixture();
    let context = unix_update::appimage_context(&current).unwrap();
    let fail = unix_update::replace_appimage(&context, &download, &digest(&image()), |path| {
        assert_eq!(path, current);
        assert_eq!(fs::read(path)?, image());
        assert_eq!(fs::metadata(path)?.permissions().mode() & 0o777, 0o751);
        anyhow::bail!("startup failed")
    });
    assert!(fail.is_err());
    assert_eq!(fs::read(&current).unwrap(), b"original launcher");
    assert_eq!(
        unix_update::replace_appimage(&context, &download, &digest(&image()), |_| Ok(123)).unwrap(),
        123
    );
    assert_eq!(fs::read(current).unwrap(), image());
    assert!(fs::read_dir(download.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tia-update-")));
}
#[test]
fn appimage_rejects_tampered_wrong_format_linked_and_replaced_installations() {
    let (_dir, current, download) = image_fixture();
    let context = unix_update::appimage_context(&current).unwrap();
    fs::write(&download, b"tampered").unwrap();
    assert!(
        unix_update::replace_appimage(&context, &download, &digest(&image()), |_| Ok(1)).is_err()
    );
    assert!(
        unix_update::replace_appimage(&context, &download, &digest(b"tampered"), |_| Ok(1))
            .is_err()
    );
    let link = current.with_extension("link");
    symlink(&current, &link).unwrap();
    assert!(unix_update::appimage_context(&link).is_err());
    assert!(unix_update::appimage_context(Path::new("relative.AppImage")).is_err());
    let changed = current.with_extension("changed");
    fs::write(&changed, b"external update").unwrap();
    fs::set_permissions(&changed, fs::Permissions::from_mode(0o751)).unwrap();
    fs::rename(changed, &current).unwrap();
    assert!(
        unix_update::replace_appimage(&context, &download, &digest(b"tampered"), |_| Ok(1))
            .is_err()
    );
    assert_eq!(fs::read(current).unwrap(), b"external update");
}
#[test]
fn installer_hashing_rejects_links_changed_files_and_invalid_digests() {
    let (_dir, _current, download) = image_fixture();
    bridge_ops::verify_installer(&download, &digest(&image())).unwrap();
    assert!(bridge_ops::verify_installer(&download, "not a digest").is_err());
    assert!(bridge_ops::verify_installer(&download, &digest(b"wrong")).is_err());
    let link = download.with_extension("link");
    symlink(download, &link).unwrap();
    assert!(bridge_ops::verify_installer(&link, &digest(&image())).is_err());
}
#[test]
fn removes_only_old_appimage_mount_entries_from_startup_environment() {
    let env = BTreeMap::from([
        ("APPDIR".into(), "/old-mount/".into()),
        ("APPIMAGE".into(), "/old".into()),
        ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
        (
            "LD_LIBRARY_PATH".into(),
            "/keep:/old-mount/lib:/old-mount2".into(),
        ),
        ("GIO_MODULE_DIR".into(), "/old-mount/modules".into()),
        ("OTHER".into(), "retained".into()),
    ]);
    let clean = unix_update::clean_environment(env);
    assert_eq!(clean["LD_LIBRARY_PATH"], "/keep:/old-mount2");
    assert_eq!(clean["OTHER"], "retained");
    for name in [
        "APPDIR",
        "APPIMAGE",
        "ELECTRON_RUN_AS_NODE",
        "GIO_MODULE_DIR",
    ] {
        assert!(!clean.contains_key(name));
    }
}
fn identity(path: &Path) -> Result<BundleIdentity> {
    Ok(serde_json::from_slice(&fs::read(
        path.join("Contents/Info.plist"),
    )?)?)
}
fn bundle_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let bundle = root.join("Custom Tia.app");
    let binary = bundle.join("Contents/MacOS/Tia Launcher");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(&binary, b"original launcher").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(
        bundle.join("Contents/Info.plist"),
        br#"{"id":"com.serenetia.tia-launcher","executable":"Tia Launcher","version":"1.19.2"}"#,
    )
    .unwrap();
    let archive = root.join("update.zip");
    write_bundle(&archive, false);
    (dir, binary, archive)
}
fn write_bundle(path: &Path, linked: bool) {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default().unix_permissions(0o755);
    zip.start_file("Tia Launcher.app/Contents/Info.plist", options)
        .unwrap();
    zip.write_all(
        br#"{"id":"com.serenetia.tia-launcher","executable":"Tia Launcher","version":"2.0.0"}"#,
    )
    .unwrap();
    zip.start_file("Tia Launcher.app/Contents/MacOS/Tia Launcher", options)
        .unwrap();
    zip.write_all(b"replacement launcher").unwrap();
    if linked {
        zip.add_symlink("Tia Launcher.app/Contents/linked", "/tmp", options)
            .unwrap();
    }
    zip.finish().unwrap();
}
#[test]
fn mac_bundle_replacement_preserves_custom_path_and_rolls_back_complete_bundle() {
    let (_dir, binary, archive) = bundle_fixture();
    let context =
        unix_update::mac_context(&binary, "com.serenetia.tia-launcher", identity).unwrap();
    let hash = digest(&fs::read(&archive).unwrap());
    assert!(unix_update::replace_mac(
        &context,
        &archive,
        &hash,
        "2.0.0",
        |_| anyhow::bail!("failed startup"),
        identity
    )
    .is_err());
    assert_eq!(fs::read(&binary).unwrap(), b"original launcher");
    assert_eq!(
        unix_update::replace_mac(
            &context,
            &archive,
            &hash,
            "2.0.0",
            |path| {
                assert_eq!(path, binary);
                assert_eq!(fs::read(path)?, b"replacement launcher");
                Ok(123)
            },
            identity
        )
        .unwrap(),
        123
    );
}
#[test]
fn mac_bundle_rejects_linked_archives_wrong_versions_and_changed_installs() {
    let (_dir, binary, archive) = bundle_fixture();
    let context =
        unix_update::mac_context(&binary, "com.serenetia.tia-launcher", identity).unwrap();
    let hash = digest(&fs::read(&archive).unwrap());
    assert!(
        unix_update::replace_mac(&context, &archive, &hash, "2.0.1", |_| Ok(1), identity).is_err()
    );
    write_bundle(&archive, true);
    let hash = digest(&fs::read(&archive).unwrap());
    assert!(
        unix_update::replace_mac(&context, &archive, &hash, "2.0.0", |_| Ok(1), identity).is_err()
    );
    assert_eq!(fs::read(&binary).unwrap(), b"original launcher");
    assert!(unix_update::mac_context(&binary, "other.application", identity).is_err());
}
#[test]
#[ignore = "Subprocess fixture for the startup handshake tests"]
fn startup_fixture_child() {
    use std::os::unix::net::UnixStream;
    let Ok(socket) = std::env::var("TIA_MIGRATION_SOCKET") else {
        return;
    };
    assert!(
        socket.len() < 104,
        "Startup socket must fit macOS sockaddr_un"
    );
    let mode = std::env::var("TIA_STARTUP_FIXTURE_MODE").unwrap_or_else(|_| "ready".into());
    if mode != "silent" {
        let mut pipe = UnixStream::connect(socket).unwrap();
        let nonce = if mode == "forged" {
            "forged".into()
        } else {
            std::env::var("TIA_MIGRATION_NONCE").unwrap()
        };
        writeln!(
            pipe,
            "{}",
            serde_json::json!({"protocol":1,"nonce":nonce,"status":"ready"})
        )
        .unwrap();
    }
    std::thread::sleep(std::time::Duration::from_secs(5));
}
#[test]
fn startup_requires_the_correct_nonce_and_times_out_silent_children() {
    let executable = std::env::current_exe().unwrap();
    let startup = Startup {
        args: vec![
            "--exact".into(),
            "startup_fixture_child".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ],
        environment: None,
        timeout_ms: Some(1000),
    };
    for (mode, timeout) in [("forged", 1000), ("silent", 100)] {
        let mut environment: BTreeMap<String, String> = std::env::vars().collect();
        environment.insert("TIA_STARTUP_FIXTURE_MODE".into(), mode.into());
        assert!(unix_update::start(
            &executable,
            &Startup {
                environment: Some(environment),
                timeout_ms: Some(timeout),
                ..startup.clone()
            }
        )
        .is_err());
    }
    let pid = unix_update::start(&executable, &startup).unwrap();
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
        libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
    }
}

#[test]
fn filesystem_identifiers_survive_the_javascript_bridge_without_rounding() {
    let context = unix_update::FileContext {
        path: "/tmp/launcher.AppImage".into(),
        device: u64::MAX,
        inode: u64::MAX - 1,
        mode: 0o755,
    };
    let value = serde_json::to_value(&context).unwrap();
    assert_eq!(value["device"], u64::MAX.to_string());
    let restored: unix_update::FileContext = serde_json::from_value(value).unwrap();
    assert_eq!(restored.inode, context.inode);
}
