use serde_json::json;
use tia_launcher::{preferences, store::Store};
#[test]
fn legacy_migration_only_fills_missing_values_and_keeps_each_game_folder() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), &[71; 32]).unwrap();
    store.put("launcher","preferences",&json!({"backgroundMode":"image","launcherLanguage":"en","confirmedInstallDir":"C:/Game A"})).unwrap();
    store
        .put(
            "title:cedar_global",
            "preferences",
            &json!({"confirmedInstallDir":"D:/Game B"}),
        )
        .unwrap();
    let prior = preferences::read(&store, "cedar_global").unwrap();
    let next = preferences::merge(
        prior,
        &json!({"backgroundMode":null,"launcherLanguage":"id","confirmedInstallDir":null}),
        true,
    )
    .unwrap();
    preferences::write(&store, "cedar_global", &next).unwrap();
    assert_eq!(next["backgroundMode"], "image");
    assert_eq!(next["launcherLanguage"], "en");
    assert_eq!(next["confirmedInstallDir"], "D:/Game B");
    assert_eq!(
        preferences::read(&store, "csore_global").unwrap()["confirmedInstallDir"],
        "C:/Game A"
    );
    let explicit = preferences::merge(
        next,
        &json!({"backgroundMode":"video","launcherLanguage":"id","confirmedInstallDir":null}),
        false,
    )
    .unwrap();
    preferences::write(&store, "cedar_global", &explicit).unwrap();
    assert_eq!(
        preferences::read(&store, "cedar_global").unwrap()["confirmedInstallDir"],
        serde_json::Value::Null
    );
    assert_eq!(
        preferences::read(&store, "csore_global").unwrap()["confirmedInstallDir"],
        "C:/Game A"
    );
    assert_eq!(
        preferences::read(&store, "csore_global").unwrap()["backgroundMode"],
        "video"
    );
}
#[test]
fn migration_fills_empty_preferences_and_rejects_invalid_updates() {
    let initial = json!({"backgroundMode":null,"confirmedInstallDir":null});
    let next = preferences::merge(
        initial.clone(),
        &json!({"backgroundMode":"video","launcherLanguage":"id","confirmedInstallDir":"D:/Game"}),
        true,
    )
    .unwrap();
    assert_eq!(next["backgroundMode"], "video");
    assert_eq!(next["launcherLanguage"], "id");
    assert_eq!(next["confirmedInstallDir"], "D:/Game");
    assert!(
        preferences::merge(initial.clone(), &json!({"backgroundMode":"unknown"}), true).is_err()
    );
    assert!(
        preferences::merge(
            initial.clone(),
            &json!({"launcherLanguage":"unknown"}),
            true
        )
        .is_err()
    );
    assert!(preferences::merge(initial, &json!([]), true).is_err());
}
