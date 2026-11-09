use md5::{Digest, Md5};
use std::{
    io::{Cursor, Write},
    sync::Arc,
};
use tia_launcher::{
    game::{Control, Progress, archive::extract},
    manifest::ManifestFile,
};

fn fixture() -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file("Bin/client.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"verified client").unwrap();
    archive.finish().unwrap().into_inner()
}

fn extract_fixture(bytes: Vec<u8>) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("game");
    std::fs::create_dir(&root).unwrap();
    let outside = directory.path().join("outside.exe");
    std::fs::write(&outside, b"unrelated file").unwrap();
    let part = directory.path().join("game.zip");
    std::fs::write(&part, bytes).unwrap();
    let file = ManifestFile {
        path: "Bin/client.exe".into(),
        md5: hex::encode(Md5::digest(b"verified client")),
        size: 15,
        url: None,
    };
    let progress: Progress = Arc::new(|_, _, _| {});
    extract(
        &[part],
        &root,
        "csore",
        &[file],
        &Control::default(),
        &progress,
        "extracting",
    )
    .unwrap();
    assert_eq!(
        std::fs::read(root.join("Bin/client.exe")).unwrap(),
        b"verified client"
    );
    assert_eq!(std::fs::read(outside).unwrap(), b"unrelated file");
}

#[test]
fn extracts_verified_files_from_matching_headers() {
    extract_fixture(fixture());
}

#[test]
fn conflicting_local_filename_cannot_change_the_verified_destination() {
    let mut bytes = fixture();
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    assert_eq!(&bytes[30..44], b"Bin/client.exe");
    bytes[30..44].copy_from_slice(b"../outside.exe");
    extract_fixture(bytes);
}
