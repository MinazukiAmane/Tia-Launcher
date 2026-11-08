use serde_json::json;
use std::path::{Path, PathBuf};
use tia_launcher::game::macos;
fn wrapper(root: &Path, name: &str) -> PathBuf {
    let app = root.join(name);
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::create_dir_all(app.join("Contents/SharedSupport/prefix/drive_c")).unwrap();
    std::fs::create_dir_all(app.join("Contents/SharedSupport/wine")).unwrap();
    let launcher = app.join("Contents/MacOS/wineskinlauncher");
    std::fs::write(&launcher, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    app
}
#[test]
fn stale_selection_does_not_switch_to_a_different_wine_prefix() {
    let root = tempfile::tempdir().unwrap();
    let default = wrapper(root.path(), "Default.app");
    let defaults = vec![default.clone()];
    assert_eq!(macos::find_wrapper(None, &defaults), Some(default));
    assert!(
        macos::find_wrapper(
            Some(&json!({"wrapperPath":root.path().join("Missing.app")})),
            &defaults
        )
        .is_none()
    );
    assert!(macos::find_wrapper(Some(&json!({"wrapperPath":null})), &defaults).is_none());
    let selected = wrapper(root.path(), "Selected.APP");
    assert_eq!(
        macos::find_wrapper(Some(&json!({"wrapperPath":selected})), &defaults),
        Some(selected)
    );
}
#[test]
fn wrapper_requires_initialized_prefix_and_executable_launcher() {
    let root = tempfile::tempdir().unwrap();
    let app = wrapper(root.path(), "Game.app");
    assert!(macos::inspect_wrapper(&app).is_ok());
    std::fs::remove_dir(app.join("Contents/SharedSupport/prefix/drive_c")).unwrap();
    assert!(macos::inspect_wrapper(&app).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir(app.join("Contents/SharedSupport/prefix/drive_c")).unwrap();
        std::fs::set_permissions(
            app.join("Contents/MacOS/wineskinlauncher"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(macos::inspect_wrapper(&app).is_err());
    }
}
#[test]
fn batch_preserves_arguments_spaces_percent_and_working_directory() {
    let batch = macos::build_batch(
        Path::new("/Applications/Tia Launcher.app/helper.exe"),
        &[
            "Z:\\tmp\\status.txt".into(),
            "-lang".into(),
            "na_id".into(),
            "100% ready! & safe".into(),
        ],
        Path::new("/Games/Tia's Game/Bin"),
    )
    .unwrap();
    assert_eq!(
        batch,
        "@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d \"Z:\\Games\\Tia's Game\\Bin\"\r\n\"Z:\\Applications\\Tia Launcher.app\\helper.exe\" \"Z:\\tmp\\status.txt\" \"-lang\" \"na_id\" \"100%% ready! & safe\"\r\n"
    );
}
#[test]
fn batch_rejects_command_breakout_and_ambiguous_paths() {
    for argument in ["name\r\nwhoami", "name\0", "name\" & whoami"] {
        assert!(
            macos::build_batch(
                Path::new("/helper.exe"),
                &[argument.into()],
                Path::new("/Games/Bin")
            )
            .is_err()
        );
    }
    for path in [
        "relative/helper.exe",
        "/Games\\other/helper.exe",
        "/Games\"/helper.exe",
    ] {
        assert!(macos::build_batch(Path::new(path), &[], Path::new("/Games/Bin")).is_err());
    }
}
