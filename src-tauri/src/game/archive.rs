use super::{
    Control, Progress,
    verify::{self, Cache, Cached},
};
use crate::{manifest::ManifestFile, paths};
use anyhow::{Context, Result, bail};
use md5::{Digest, Md5};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub struct PartsReader {
    files: Vec<File>,
    ends: Vec<u64>,
    cursors: Vec<u64>,
    position: u64,
    total: u64,
}
impl PartsReader {
    pub fn open(paths: &[PathBuf]) -> Result<Self> {
        let mut files = Vec::new();
        let mut ends = Vec::new();
        let mut total = 0u64;
        for path in paths {
            let f = File::open(path)?;
            total = total
                .checked_add(f.metadata()?.len())
                .context("Archive size overflow")?;
            files.push(f);
            ends.push(total);
        }
        let cursors = vec![0; files.len()];
        Ok(Self {
            files,
            ends,
            cursors,
            position: 0,
            total,
        })
    }
}
impl Read for PartsReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.total {
            return Ok(0);
        }
        let index = self.ends.partition_point(|end| *end <= self.position);
        let begin = if index == 0 { 0 } else { self.ends[index - 1] };
        let local = self.position - begin;
        if self.cursors[index] != local {
            self.files[index].seek(SeekFrom::Start(local))?;
        }
        let n = bytes.len().min((self.ends[index] - self.position) as usize);
        let n = self.files[index].read(&mut bytes[..n])?;
        self.cursors[index] = local + n as u64;
        self.position += n as u64;
        Ok(n)
    }
}
impl Seek for PartsReader {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let at = match to {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.total as i128 + n as i128,
            SeekFrom::Current(n) => self.position as i128 + n as i128,
        };
        self.position = u64::try_from(at).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid archive offset")
        })?;
        Ok(self.position)
    }
}
pub struct Stage(pub PathBuf);
impl Stage {
    pub fn new(root: &Path) -> Result<Self> {
        let parent = paths::within(root, ".csore_download_tmp")?;
        paths::ensure_directory(&parent)?;
        let path = parent.join(format!("stage-{:016x}", rand::random::<u64>()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn checked_zip<R: Read + Seek>(reader: R) -> Result<zip::ZipArchive<R>> {
    let mut zip = zip::ZipArchive::new(reader)?;
    let mut names = HashSet::new();
    if zip.len() > 1_000_000 {
        bail!("The game archive contains too many entries.")
    }
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let name = entry.name().trim_end_matches('/');
        if name.is_empty() {
            bail!("The game archive has an invalid entry.")
        }
        paths::within(Path::new("."), name)?;
        if entry.unix_mode().is_some_and(|m| {
            matches!(
                m & 0o170000,
                0o120000 | 0o060000 | 0o020000 | 0o010000 | 0o140000
            )
        }) {
            bail!("Linked or special archive entries are not allowed.")
        }
        if !names.insert(entry.name().to_owned()) {
            bail!("The game archive contains duplicate entries.")
        }
    }
    Ok(zip)
}
fn copy_verified(
    reader: &mut impl Read,
    path: &Path,
    expected: &ManifestFile,
    control: &Control,
    mut on_bytes: impl FnMut(u64),
) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let mut hash = Md5::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut bytes = 0u64;
    loop {
        control.check()?;
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).context("File size overflow")?;
        if bytes > expected.size {
            bail!("An extracted file exceeds its verified size.")
        }
        file.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
        on_bytes(bytes);
    }
    file.flush()?;
    drop(file);
    if bytes != expected.size || !hex::encode(hash.finalize()).eq_ignore_ascii_case(&expected.md5) {
        bail!("An extracted file failed verification: {}", expected.path)
    }
    Ok(())
}
pub fn extract(
    parts: &[PathBuf],
    root: &Path,
    game: &str,
    target: &[ManifestFile],
    control: &Control,
    progress: &Progress,
    phase: &str,
) -> Result<Cache> {
    verify::validate_files(target)?;
    let canonical = target.iter().any(|f| f.path == "Bin/renderer.dll");
    let allowed: BTreeMap<_, _> = target
        .iter()
        .filter(|f| !verify::ignored(&f.path, game, canonical))
        .map(|f| (f.path.as_str(), f))
        .collect();
    let mut zip = checked_zip(PartsReader::open(parts)?)?;
    let stage = Stage::new(root)?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let e = zip.by_index(i)?;
        if let Some(expected) = allowed.get(e.name()) {
            if e.is_dir() || e.size() != expected.size {
                bail!("Archive file size does not match the verified manifest.")
            }
            total = total
                .checked_add(expected.size)
                .context("Archive size overflow")?;
        }
    }
    let mut completed = 0;
    let mut cache = Cache::new();
    progress(phase, 0, total);
    for i in 0..zip.len() {
        control.check()?;
        let mut entry = zip.by_index(i)?;
        let Some(expected) = allowed.get(entry.name()).copied() else {
            continue;
        };
        let destination = paths::within(root, &expected.path)?;
        let temporary = stage.0.join("file.tmp");
        copy_verified(&mut entry, &temporary, expected, control, |n| {
            progress(phase, completed + n, total)
        })?;
        paths::ensure_directory(destination.parent().unwrap())?;
        paths::within(root, &expected.path)?;
        paths::replace(&temporary, &destination)?;
        cache.insert(
            expected.path.clone(),
            Cached {
                md5: expected.md5.clone(),
                stamp: verify::stamp(&destination)?,
            },
        );
        completed += expected.size;
        progress(phase, completed, total);
    }
    Ok(cache)
}
#[derive(serde::Deserialize)]
pub struct PatchManifest {
    pub entries: Vec<PatchEntry>,
}
#[derive(serde::Deserialize)]
pub struct PatchEntry {
    pub path: String,
    pub action: String,
    pub delta_file: Option<String>,
    pub old_md5: Option<String>,
    pub new_md5: Option<String>,
    pub size: Option<u64>,
}
#[derive(Debug)]
pub struct WrongBase;
impl std::fmt::Display for WrongBase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The installed file differs from the patch base.")
    }
}
impl std::error::Error for WrongBase {}
pub fn patch(
    parts: &[PathBuf],
    root: &Path,
    game: &str,
    target: &[ManifestFile],
    old_files: &[super::model::InstalledFile],
    control: &Control,
    progress: &Progress,
) -> Result<Cache> {
    let mut zip = checked_zip(PartsReader::open(parts)?)?;
    let mut bytes = Vec::new();
    {
        let mut manifest = zip.by_name("manifest.json")?;
        if manifest.size() > 10 * 1024 * 1024 {
            bail!("The patch manifest is too large.")
        }
        manifest
            .by_ref()
            .take(10 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
    }
    if bytes.len() > 10 * 1024 * 1024 {
        bail!("The patch manifest is too large.")
    }
    let manifest: PatchManifest = serde_json::from_slice(&bytes)?;
    let canonical = target.iter().any(|f| f.path == "Bin/renderer.dll");
    let allowed: BTreeMap<_, _> = target.iter().map(|f| (f.path.as_str(), f)).collect();
    let old: HashSet<_> = old_files.iter().map(|f| f.path.as_str()).collect();
    let mut seen = HashSet::new();
    for entry in &manifest.entries {
        paths::within(root, &entry.path)?;
        if let Some(path) = &entry.delta_file {
            paths::within(root, path)?;
        }
        if verify::ignored(&entry.path, game, canonical) {
            continue;
        }
        if !seen.insert(entry.path.to_lowercase()) {
            bail!("The patch contains conflicting paths.")
        }
        match entry.action.as_str() {
            "removed" => {
                if !old.contains(entry.path.as_str()) || allowed.contains_key(entry.path.as_str()) {
                    bail!("The patch would delete an unapproved file.")
                }
            }
            "added" | "modified" => {
                let expected = allowed
                    .get(entry.path.as_str())
                    .context("The patch contains a file outside the verified manifest")?;
                if entry
                    .new_md5
                    .as_ref()
                    .is_none_or(|m| !m.eq_ignore_ascii_case(&expected.md5))
                    || entry.size.is_some_and(|n| n != expected.size)
                {
                    bail!("The patch disagrees with the verified manifest.")
                }
            }
            _ => bail!("Unknown patch operation."),
        }
    }
    let stage = Stage::new(root)?;
    let mut staged = Vec::new();
    let mut removed = Vec::new();
    let mut cache = Cache::new();
    let total = manifest.entries.len() as u64;
    for (index, entry) in manifest.entries.iter().enumerate() {
        control.check()?;
        if verify::ignored(&entry.path, game, canonical) {
            continue;
        }
        let path = paths::within(root, &entry.path)?;
        if entry.action == "removed" {
            removed.push(path);
            continue;
        }
        let expected = allowed[entry.path.as_str()];
        let staged_path = stage.0.join(format!("file-{index}"));
        if entry.action == "added" {
            let mut data = zip.by_name(&entry.path)?;
            if data.size() != expected.size {
                bail!("Invalid added patch file size.")
            }
            copy_verified(&mut data, &staged_path, expected, control, |_| {})?;
        } else {
            let old_matches = path.is_file()
                && entry.old_md5.as_ref().is_some_and(|md5| {
                    super::transfer::md5_file(&path)
                        .is_ok_and(|digest| digest.eq_ignore_ascii_case(md5))
                });
            if !old_matches {
                return Err(WrongBase.into());
            }
            let delta_path = stage.0.join("delta.bsdiff");
            {
                let mut data =
                    zip.by_name(entry.delta_file.as_deref().context("Missing delta path")?)?;
                if data.size() > 1024 * 1024 * 1024 {
                    bail!("The compressed patch is too large.")
                }
                let mut file = File::create(&delta_path)?;
                std::io::copy(&mut data.by_ref().take(1024 * 1024 * 1024 + 1), &mut file)?;
                file.flush()?;
            }
            super::delta::apply(&path, &delta_path, &staged_path, expected.size, control)?;
            fs::remove_file(delta_path)?;
            if !super::transfer::md5_file(&staged_path)?.eq_ignore_ascii_case(&expected.md5) {
                bail!("The patched file failed verification.")
            }
        }
        staged.push((entry.path.clone(), staged_path));
        progress("applying_patch", index as u64 + 1, total);
    }
    control.check()?;
    for path in removed {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    for (relative, source) in staged {
        let destination = paths::within(root, &relative)?;
        paths::ensure_directory(destination.parent().unwrap())?;
        paths::within(root, &relative)?;
        paths::replace(&source, &destination)?;
        cache.insert(
            relative.clone(),
            Cached {
                md5: allowed[relative.as_str()].md5.clone(),
                stamp: verify::stamp(&destination)?,
            },
        );
    }
    Ok(cache)
}
