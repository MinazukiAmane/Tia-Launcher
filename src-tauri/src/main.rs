#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments
        .get(1)
        .is_some_and(|arg| arg == "--cleanup-launcher-data")
    {
        let result = arguments
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("Missing launcher data folder"))
            .and_then(|path| tia_launcher::uninstall_data::cleanup(std::path::Path::new(path)));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1)
        }
        return;
    }
    #[cfg(target_os = "linux")]
    if arguments
        .get(1)
        .is_some_and(|arg| arg == "--install-signed-package")
    {
        let result = arguments
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("Missing package request"))
            .and_then(|path| {
                tia_launcher::package_update::privileged_install(std::path::Path::new(path))
            });
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1)
        }
        return;
    }
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| arg == "--prepare-uninstall-test") {
        if let Err(error) = tia_launcher::migration_probe::prepare_uninstall_test() {
            eprintln!("{error}");
            std::process::exit(1)
        }
        return;
    }
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| arg == "--migration-check") {
        if let Err(error) = tia_launcher::migration_probe::run() {
            eprintln!("{error}");
            std::process::exit(1)
        }
        return;
    }
    tia_launcher::desktop::run();
}
