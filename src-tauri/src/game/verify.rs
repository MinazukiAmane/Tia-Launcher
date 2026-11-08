use super::{Control, model::Verification, transfer::md5_file};
use crate::{manifest::ManifestFile, paths, store::Store};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::{
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
#[derive(Clone, Serialize, Deserialize)]
pub struct Cached {
    pub md5: String,
    pub stamp: String,
}
pub type Cache = BTreeMap<String, Cached>;
pub fn ignored(path: &str, game: &str, canonical: bool) -> bool {
    let lower = path.to_lowercase();
    if lower.ends_with(".log") || canonical && path == "Bin/Renderer.dll" {
        return true;
    }
    game == "cedar_global"
        && [
            "silverpalace/saved/",
            "engine/saved/",
            "deriveddatacache/",
            "silverpalace/deriveddatacache/",
            "engine/deriveddatacache/",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}
pub fn validate_files(files: &[ManifestFile]) -> Result<()> {
    let canonical = files.iter().any(|f| f.path == "Bin/renderer.dll");
    let mut names = std::collections::HashSet::new();
    for file in files {
        paths::within(Path::new("."), &file.path)?;
        if file.md5.len() != 32
            || !file.md5.bytes().all(|b| b.is_ascii_hexdigit())
            || file.size > 1024u64.pow(4)
        {
            bail!("The file manifest contains invalid metadata.")
        }
        if canonical && file.path == "Bin/Renderer.dll" {
            continue;
        }
        if !names.insert(file.path.to_lowercase()) {
            bail!("The file manifest contains conflicting paths.")
        }
    }
    Ok(())
}
pub fn stamp(path: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = std::fs::symlink_metadata(path)?;
        if !info.is_file() || paths::linked(&info) {
            bail!("The installation contains a linked or invalid game file.")
        }
        Ok(format!(
            "unix:{}:{}:{}:{}:{}:{}:{}",
            info.size(),
            info.mtime(),
            info.mtime_nsec(),
            info.ctime(),
            info.ctime_nsec(),
            info.ino(),
            info.dev()
        ))
    }
    #[cfg(windows)]
    {
        use std::{
            mem::{size_of, zeroed},
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_BASIC_INFO, FILE_ID_INFO, FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx,
        };
        let file = std::fs::OpenOptions::new()
            .read(true)
            .access_mode(0x80)
            .share_mode(7)
            .open(path)?;
        let info = file.metadata()?;
        if !info.is_file() || paths::linked(&info) {
            bail!("The installation contains a linked or invalid game file.")
        }
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        let mut id: FILE_ID_INFO = unsafe { zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                &mut basic as *mut _ as _,
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
            || unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileIdInfo,
                    &mut id as *mut _ as _,
                    size_of::<FILE_ID_INFO>() as u32,
                )
            } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(format!(
            "windows:{}:{}:{}:{}:{}",
            info.len(),
            basic.LastWriteTime,
            basic.ChangeTime,
            id.VolumeSerialNumber,
            hex::encode(id.FileId.Identifier)
        ))
    }
}
pub fn check(
    root: &Path,
    game: &str,
    files: &[ManifestFile],
    quick: bool,
    cache: &Cache,
    control: &Control,
) -> Result<(Verification, Cache, u64)> {
    validate_files(files)?;
    let canonical = files.iter().any(|f| f.path == "Bin/renderer.dll");
    let files: Vec<_> = files
        .iter()
        .filter(|f| !ignored(&f.path, game, canonical))
        .collect();
    let cursor = AtomicUsize::new(0);
    let outputs: Mutex<Vec<Option<Result<(bool, Option<Cached>, u64)>>>> =
        Mutex::new((0..files.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..2 {
            let files = &files;
            let cursor = &cursor;
            let outputs = &outputs;
            scope.spawn(move || {
                loop {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    if index >= files.len() {
                        break;
                    }
                    let entry = files[index];
                    let result = (|| -> Result<(bool, Option<Cached>, u64)> {
                        control.check()?;
                        let path = paths::within(root, &entry.path)?;
                        let info = match std::fs::metadata(&path) {
                            Ok(i) => i,
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                return Ok((false, None, 0));
                            }
                            Err(e) => return Err(e.into()),
                        };
                        if !info.is_file() || info.len() != entry.size {
                            return Ok((true, None, 0));
                        }
                        let before = stamp(&path)?;
                        if quick
                            && cache.get(&entry.path).is_some_and(|v| {
                                v.md5.eq_ignore_ascii_case(&entry.md5) && v.stamp == before
                            })
                        {
                            return Ok((
                                true,
                                Some(Cached {
                                    md5: entry.md5.clone(),
                                    stamp: before,
                                }),
                                0,
                            ));
                        }
                        if !md5_file(&path)?.eq_ignore_ascii_case(&entry.md5)
                            || stamp(&path)? != before
                        {
                            return Ok((true, None, entry.size));
                        }
                        Ok((
                            true,
                            Some(Cached {
                                md5: entry.md5.clone(),
                                stamp: before,
                            }),
                            entry.size,
                        ))
                    })();
                    outputs.lock().unwrap()[index] = Some(result);
                }
            });
        }
    });
    let mut result = Verification::default();
    let mut next = Cache::new();
    let mut hashed = 0;
    for (file, value) in files.iter().zip(outputs.into_inner().unwrap()) {
        let (exists, cached, bytes) = value.unwrap()?;
        hashed += bytes;
        if !exists {
            result.missing_files.push(file.path.clone())
        } else if let Some(value) = cached {
            next.insert(file.path.clone(), value);
        } else {
            result.corrupt_files.push(file.path.clone())
        }
    }
    result.ok = result.missing_files.is_empty() && result.corrupt_files.is_empty();
    Ok((result, next, hashed))
}
pub fn read_cache(store: &Store, scope: &str) -> Cache {
    store
        .get(scope, "verifyCache")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
