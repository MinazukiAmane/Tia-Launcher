use super::{Progress, engine::Engine, model::Definition};
use crate::paths;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

fn protected(root: &Path, engine: &Engine) -> Result<()> {
    let root = fs::canonicalize(root)?;
    if root.parent().is_none() || dirs::home_dir().is_some_and(|home| home == root) {
        bail!("Choose a dedicated game folder instead of a drive or home folder.")
    }
    for path in [
        engine.store.lock().unwrap().directory.clone(),
        engine.resources.clone(),
        std::env::current_exe()?,
    ] {
        if let Ok(path) = fs::canonicalize(path) {
            if path.starts_with(&root) {
                bail!(
                    "This folder contains the launcher or its saved data. Choose a dedicated game folder."
                )
            }
        }
    }
    Ok(())
}
fn hash(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; 1024 * 1024];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn copy_checked(source: &Path, stage: &Path, progress: &Progress) -> Result<()> {
    fs::create_dir(stage)?;
    let mut files = Vec::new();
    for item in walkdir::WalkDir::new(source)
        .min_depth(1)
        .follow_links(false)
    {
        let item = item?;
        let info = fs::symlink_metadata(item.path())?;
        if paths::linked(&info) || (!info.is_file() && !info.is_dir()) {
            bail!("Remove linked or special files before moving this installation.")
        }
        let relative = item
            .path()
            .strip_prefix(source)?
            .to_str()
            .context("Unsupported game file name")?
            .replace('\\', "/");
        let target = paths::within(stage, &relative)?;
        if info.is_dir() {
            fs::create_dir(&target)?
        } else {
            files.push((item.path().to_path_buf(), target));
        }
    }
    let total = files.len() as u64;
    for (index, (source, target)) in files.iter().enumerate() {
        let before = super::verify::stamp(source)?;
        fs::copy(source, target)?;
        progress("copying", index as u64 + 1, total);
        if hash(source)? != hash(target)? || before != super::verify::stamp(source)? {
            bail!("Game files changed while moving. The original installation has been kept.")
        }
        progress("verifying", index as u64 + 1, total);
    }
    Ok(())
}
impl Engine {
    pub async fn move_installation(
        self: &Arc<Self>,
        source: &Path,
        destination: &Path,
        game: &Definition,
        preference: &str,
        progress: Progress,
    ) -> Result<Value> {
        let _operation = self.control.acquire()?;
        self.selected_state(source, game)
            .await?
            .context("No installed game was found to move")?;
        protected(source, self)?;
        let source = fs::canonicalize(source)?;
        let destination = fs::canonicalize(destination)?;
        protected(&destination, self)?;
        if source.starts_with(&destination) || destination.starts_with(&source) {
            bail!("Choose a different folder outside the current installation.")
        }
        if fs::read_dir(&destination)?.next().is_some() {
            bail!("Choose an empty destination folder. Existing files will not be overwritten.")
        }
        let from = paths::scope(&source)?;
        let to = paths::scope(&destination)?;
        if from == to {
            bail!("Choose a different destination folder.")
        }

        let stage = destination
            .parent()
            .context("Invalid destination")?
            .join(format!(".csore-move-{:016x}", rand::random::<u64>()));
        let engine = self.clone();
        let preference = preference.to_owned();
        tokio::task::spawn_blocking(move || {
            progress("moving",0,1);
            let mut renamed=false;let mut removed=false;
            let result=(|| {
                match fs::rename(&source,&stage) {
                    Ok(())=>renamed=true,
                    Err(error) if error.kind()==std::io::ErrorKind::CrossesDevices=>copy_checked(&source,&stage,&progress)?,
                    Err(error)=>return Err(error.into()),
                }
                fs::remove_dir(&destination)?;removed=true;
                fs::rename(&stage,&destination)?;
                if let Err(error)=engine.store.lock().unwrap().relocate_game(&from,&to,&destination,&preference) {
                    fs::rename(&destination,&stage)?;return Err(error);
                }
                Ok::<_,anyhow::Error>(())
            })();
            if let Err(error)=result {
                if renamed && stage.exists(){fs::rename(&stage,&source)?}else if stage.exists(){let _=fs::remove_dir_all(&stage);}
                if removed && !destination.exists(){let _=fs::create_dir(&destination);}
                return Err(error);
            }
            let warning=if !renamed && fs::remove_dir_all(&source).is_err(){Some("The game was moved, but some files remain at the old location. Check the new installation before removing them.")}else{None};
            progress("moving",1,1);
            Ok(json!({"installDir":paths::user_path(&destination),"warning":warning}))
        }).await?
    }
    pub async fn uninstall_game(
        self: &Arc<Self>,
        root: &Path,
        game: &Definition,
        preference: &str,
    ) -> Result<()> {
        let _operation = self.control.acquire()?;
        protected(root, self)?;
        let mut install = self
            .install_state(root, game)?
            .context("No installed game was found")?;
        if install.files.is_empty() {
            let manifest = self.reference(root, game, &install, false).await?;
            install.files = manifest.files.iter().map(Into::into).collect();
        }
        let root = root.to_path_buf();
        let scope = paths::scope(&root)?;
        let engine = self.clone();
        let preference = preference.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut directories = std::collections::BTreeSet::<PathBuf>::new();
            // Remove tracked files only; custom files and unrelated folders stay in place.
            for file in install.files {
                let path = paths::within(&root, &file.path)?;
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                let mut parent = path.parent();
                while let Some(path) = parent.filter(|path| *path != root) {
                    directories.insert(path.to_path_buf());
                    parent = path.parent();
                }
            }
            let cache = paths::within(&root, ".csore_download_tmp")?;
            if cache.exists() {
                fs::remove_dir_all(cache)?;
            }
            for name in [".csore_install.json", ".csore_verify_cache.json"] {
                let path = paths::within(&root, name)?;
                if path.is_file() {
                    fs::remove_file(path)?;
                }
            }
            for directory in directories.iter().rev() {
                let _ = fs::remove_dir(directory);
            }
            engine
                .store
                .lock()
                .unwrap()
                .forget_game(&scope, &preference)?;
            let _ = fs::remove_dir(&root);
            engine.record("installation: tracked game files uninstalled");
            Ok(())
        })
        .await?
    }
}
