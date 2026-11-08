#[cfg(target_os = "linux")]
#[test]
fn signed_packages_require_matching_version_and_reject_downgrades_and_modified_bytes() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/package-signature.json")).unwrap();
    let data = fixture["data"].as_str().unwrap().as_bytes();
    let signature = fixture["signature"].as_str().unwrap();
    let key = fixture["publicKey"].as_str().unwrap();
    assert!(tia_launcher::package_update::verify(data, signature, key, "2.0.1", "2.0.0").is_ok());
    assert!(
        tia_launcher::package_update::verify(b"modified", signature, key, "2.0.1", "2.0.0")
            .is_err()
    );
    assert!(tia_launcher::package_update::verify(data, signature, key, "2.0.2", "2.0.0").is_err());
    assert!(tia_launcher::package_update::verify(data, signature, key, "2.0.1", "2.0.1").is_err());
    assert!(tia_launcher::package_update::verify(data, signature, key, "2.0.1", "3.0.0").is_err());
    assert!(tia_launcher::package_update::verify(data, signature, "", "2.0.1", "2.0.0").is_err());
}
#[cfg(target_os = "linux")]
#[test]
fn privileged_package_updates_reject_user_owned_executables() {
    let temporary = tempfile::tempdir().unwrap();
    let executable = temporary.path().join("launcher");
    std::fs::write(&executable, b"fixture").unwrap();
    assert!(tia_launcher::package_update::system_executable(&executable).is_err());
}
