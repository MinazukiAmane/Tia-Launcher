use anyhow::{Result, bail};
use serde_json::json;
use std::path::PathBuf;

pub fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let profile = args
        .iter()
        .position(|arg| arg == "--profile")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("An explicit test profile is required."))?;
    if !profile.is_absolute() || !profile.join("launcher.db").is_file() {
        bail!("An existing test profile is required.")
    }
    let key = crate::keystore::load_or_create(&profile)?;
    let store = crate::store::Store::open(&profile, &key)?;
    let selected = store.get("launcher", "selectedInstallation")?;
    println!(
        "{}",
        json!({"version":env!("CARGO_PKG_VERSION"),"recordsVerified":store.verify_records()?,"settings":store.get("launcher","settings")?,"preferences":store.get("launcher","preferences")?,"installation":selected})
    );
    Ok(())
}

pub fn prepare_uninstall_test() -> Result<()> {
    let profile = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Missing test data root"))?
        .join("tia-launcher-uninstall-test");
    if profile.exists() {
        bail!("The isolated uninstall test profile already exists.")
    }
    let inside = std::env::args().any(|arg| arg == "--inside-profile");
    let game = if inside {
        profile.join("GameFixture")
    } else {
        std::env::temp_dir().join(format!("tia-uninstall-game-{:016x}", rand::random::<u64>()))
    };
    std::fs::create_dir_all(game.join("Bin"))?;
    std::fs::write(
        game.join("Bin/test-client.txt"),
        "First-party uninstall test game fixture",
    )?;
    let key = crate::keystore::load_or_create(&profile)?;
    let store = crate::store::Store::open(&profile, &key)?;
    store.put(
        "launcher",
        "settings",
        &json!({"lang":"na_id","fpsLimit":144}),
    )?;
    store.put(
        "launcher",
        "preferences",
        &json!({"backgroundMode":"image","launcherLanguage":"en"}),
    )?;
    store.put("launcher", "selectedGame", &json!("csore_global"))?;
    store.put(
        "launcher",
        "selectedInstallation",
        &json!({"installDir":game}),
    )?;
    println!("{}", json!({"profile":profile,"game":game}));
    Ok(())
}
