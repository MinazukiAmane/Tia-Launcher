use serde_json::json;
use tia_launcher::{keystore, store::Store, uninstall_data};
#[test]
fn cleanup_validation_keeps_game_inside_profile_and_rejects_other_profile() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("profile");
    let other = directory.path().join("other");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&other).unwrap();
    let key = [51; 32];
    keystore::import_key(&profile, &key, false).unwrap();
    let store = Store::open(&profile, &key).unwrap();
    let game = profile.join("Game");
    std::fs::create_dir(&game).unwrap();
    std::fs::write(game.join("personal.txt"), b"keep").unwrap();
    store
        .put(
            "launcher",
            "selectedInstallation",
            &json!({"installDir":game}),
        )
        .unwrap();
    assert!(uninstall_data::validate(&profile, &profile).is_err());
    assert!(uninstall_data::validate(&profile, &other).is_err());
    assert_eq!(std::fs::read(game.join("personal.txt")).unwrap(), b"keep");
    store
        .put(
            "launcher",
            "selectedInstallation",
            &json!({"installDir":null}),
        )
        .unwrap();
    drop(store);
    assert!(uninstall_data::validate(&profile, &profile).is_ok());
    assert!(profile.join("launcher.db").exists());
}
#[test]
fn invalid_key_prevents_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path();
    let key = [52; 32];
    keystore::import_key(profile, &key, false).unwrap();
    let store = Store::open(profile, &key).unwrap();
    store
        .put("launcher", "settings", &json!({"lang":"na_id"}))
        .unwrap();
    drop(store);
    std::fs::write(profile.join("launcher.tauri.key"), b"damaged").unwrap();
    assert!(uninstall_data::validate(profile, profile).is_err());
    assert!(profile.join("launcher.db").is_file());
}
#[cfg(unix)]
#[test]
fn linked_profile_is_never_removed() {
    let directory = tempfile::tempdir().unwrap();
    let actual = directory.path().join("actual");
    let link = directory.path().join("link");
    std::fs::create_dir(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, &link).unwrap();
    assert!(uninstall_data::validate(&link, &actual).is_err());
    assert!(actual.exists());
}
