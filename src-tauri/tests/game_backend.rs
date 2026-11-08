use std::{
    fs,
    io::Write,
    sync::{Arc, atomic::Ordering},
};
use tia_launcher::{
    game::{Control, delta, launch, verify},
    manifest::ManifestFile,
};

fn integer(n: i64) -> [u8; 8] {
    let mut bytes = n.unsigned_abs().to_le_bytes();
    if n < 0 {
        bytes[7] |= 128;
    }
    bytes
}
fn compress(bytes: &[u8]) -> Vec<u8> {
    let mut stream = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
    stream.write_all(bytes).unwrap();
    stream.finish().unwrap()
}
fn patch(control: &[i64], difference: &[u8], extra: &[u8], size: i64) -> Vec<u8> {
    let controls = compress(&control.iter().flat_map(|n| integer(*n)).collect::<Vec<_>>());
    let differences = compress(difference);
    let extras = compress(extra);
    let mut bytes = b"BSDIFF40".to_vec();
    bytes.extend(integer(controls.len() as i64));
    bytes.extend(integer(differences.len() as i64));
    bytes.extend(integer(size));
    bytes.extend(controls);
    bytes.extend(differences);
    bytes.extend(extras);
    bytes
}
#[test]
fn applies_streaming_patch_and_rejects_out_of_bounds_control() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old");
    let diff = dir.path().join("patch");
    let output = dir.path().join("new");
    fs::write(&old, b"hello").unwrap();
    fs::write(&diff, patch(&[5, 1, 0], &[0, 0, 0, 0, 0], b"!", 6)).unwrap();
    delta::apply(&old, &diff, &output, 6, &Control::default()).unwrap();
    assert_eq!(fs::read(&output).unwrap(), b"hello!");
    fs::write(&diff, patch(&[7, 0, 0], &[0; 7], b"", 6)).unwrap();
    assert!(delta::apply(&old, &diff, &output, 6, &Control::default()).is_err());
    fs::write(&diff, patch(&[-1, 0, 0], b"", b"", 6)).unwrap();
    assert!(delta::apply(&old, &diff, &output, 6, &Control::default()).is_err());
}
#[test]
fn patch_requires_signed_size_and_complete_payload() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old");
    let diff = dir.path().join("patch");
    let output = dir.path().join("new");
    fs::write(&old, b"hello").unwrap();
    fs::write(&diff, patch(&[5, 1, 0], &[0; 5], b"!", 6)).unwrap();
    assert!(delta::apply(&old, &diff, &output, 5, &Control::default()).is_err());
    fs::write(&diff, patch(&[5, 1, 0], &[0; 4], b"!", 6)).unwrap();
    assert!(delta::apply(&old, &diff, &output, 6, &Control::default()).is_err());
}
#[test]
fn warm_verification_skips_hashing_and_detects_replaced_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("Bin")).unwrap();
    let path = dir.path().join("Bin/client.exe");
    fs::write(&path, b"hello").unwrap();
    let files = vec![ManifestFile {
        path: "Bin/client.exe".into(),
        md5: "5d41402abc4b2a76b9719d911017c592".into(),
        size: 5,
        url: None,
    }];
    let (result, cache, bytes) = verify::check(
        dir.path(),
        "csore_global",
        &files,
        true,
        &Default::default(),
        &Control::default(),
    )
    .unwrap();
    assert!(result.ok);
    assert_eq!(bytes, 5);
    let (result, _, bytes) = verify::check(
        dir.path(),
        "csore_global",
        &files,
        true,
        &cache,
        &Control::default(),
    )
    .unwrap();
    assert!(result.ok);
    assert_eq!(bytes, 0);
    let replacement = dir.path().join("replacement");
    fs::write(&replacement, b"world").unwrap();
    fs::remove_file(&path).unwrap();
    fs::rename(replacement, path).unwrap();
    let (result, _, bytes) = verify::check(
        dir.path(),
        "csore_global",
        &files,
        true,
        &cache,
        &Control::default(),
    )
    .unwrap();
    assert!(!result.ok);
    assert_eq!(bytes, 5);
}
#[test]
fn operations_release_on_failure_and_pause_does_not_poison_retry() {
    let control = Arc::new(Control::default());
    let operation = control.acquire().unwrap();
    assert!(control.acquire().is_err());
    control.pause();
    assert!(control.check().is_err());
    drop(operation);
    let retry = control.acquire().unwrap();
    assert!(control.check().is_ok());
    drop(retry);
    control.running.store(true, Ordering::SeqCst);
    assert!(control.acquire().is_err());
}
#[test]
fn forwards_client_flags_without_turning_them_into_wrapper_options() {
    let (args, wrapper) = launch::client_args(
        "csore_global",
        &serde_json::json!({
            "lang":"na_id", "classicUi":true, "fpsLimit":240,
            "launchCommand":"-ip example.test -port 30003 -name \"Player One\""
        }),
    )
    .unwrap();
    assert_eq!(
        args,
        [
            "-lang",
            "na_id",
            "--classicui",
            "+developer",
            "1",
            "+fps_max",
            "240",
            "-ip",
            "example.test",
            "-port",
            "30003",
            "-name",
            "Player One"
        ]
    );
    assert!(wrapper.is_none());
    assert!(launch::parse_options("-name \"unfinished").is_err());
}
