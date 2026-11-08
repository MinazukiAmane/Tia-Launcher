use std::path::{Path, PathBuf};

pub fn nix_store_path(path: &Path) -> bool {
    path.is_absolute() && path.starts_with("/nix/store") && path.components().count() > 3
}
pub fn nix_managed() -> bool {
    cfg!(target_os = "linux") && std::env::current_exe().is_ok_and(|path| nix_store_path(&path))
}
pub fn nix_umu() -> Option<PathBuf> {
    let selected = PathBuf::from(std::env::var_os("TIA_UMU_LAUNCHER")?);
    let canonical = std::fs::canonicalize(selected).ok()?;
    (nix_store_path(&canonical) && canonical.is_file()).then_some(canonical)
}
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn detects_immutable_nix_packages_without_matching_similarly_named_directories() {
        assert!(nix_store_path(Path::new(
            "/nix/store/abc-tia-launcher/bin/tia-launcher"
        )));
        for path in [
            "/nix/store",
            "/nix/storehouse/launcher",
            "nix/store/launcher",
            "/tmp/nix/store/launcher",
            "/usr/bin/tia-launcher",
        ] {
            assert!(!nix_store_path(Path::new(path)))
        }
    }
}
