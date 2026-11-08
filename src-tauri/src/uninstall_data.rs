use crate::{keystore, paths, store::Store};
use anyhow::{Context, Result, bail};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const REMOVE_DATA_FLAG: &str = "--tia-delete-launcher-data";
pub fn validate(directory: &Path, allowed: &Path) -> Result<()> {
    let info = fs::symlink_metadata(directory)?;
    if paths::linked(&info) || !info.is_dir() {
        bail!("The launcher data folder could not be confirmed.")
    }
    if fs::canonicalize(directory)? != fs::canonicalize(allowed)? {
        bail!("Only the current user's launcher data can be removed.")
    }
    let key = zeroize::Zeroizing::new(keystore::load_key(directory)?);
    let store = Store::open(directory, &key)?;
    if store.has_installation_under(&fs::canonicalize(directory)?)? {
        bail!("Move the game outside the launcher data folder before removing saved data.")
    }
    Ok(())
}
pub fn expected(profile: &Path) -> Result<PathBuf> {
    let root = dirs::config_dir().context("The current user's data folder is unavailable")?;
    let normal = root.join("tia-launcher-bootstrap");
    #[cfg(debug_assertions)]
    if profile
        .file_name()
        .is_some_and(|name| name == "tia-launcher-uninstall-test")
    {
        return Ok(root.join("tia-launcher-uninstall-test"));
    }
    let _ = profile;
    Ok(normal)
}
pub fn cleanup(directory: &Path) -> Result<()> {
    let allowed = expected(directory)?;
    if !directory.exists() {
        return Ok(());
    }
    validate(directory, &allowed)?;
    fs::remove_dir_all(directory)?;
    Ok(())
}
