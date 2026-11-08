use anyhow::{Result, bail};
use std::path::{Component, Path, PathBuf};

pub fn within(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.starts_with(['/', '\\'])
        || relative.contains(['\\', ':'])
        || relative.chars().any(|c| c.is_control())
    {
        bail!("Invalid game file path.")
    }
    for part in relative.split('/') {
        if part.is_empty() || [".", ".."].contains(&part) || part.ends_with(['.', ' ']) {
            bail!("Invalid game file path.")
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            bail!("Invalid game file path.")
        }
    }
    let joined = root.join(relative);
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        if let Component::Normal(part) = component {
            current.push(part);
            match std::fs::symlink_metadata(&current) {
                Ok(info) if linked(&info) => {
                    bail!("Linked paths are not allowed inside an installation.")
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => {}
            }
        } else {
            bail!("Invalid game file path.")
        }
    }
    Ok(joined)
}

pub fn user_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        return if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
            PathBuf::from(format!("\\\\{unc}"))
        } else {
            PathBuf::from(text.strip_prefix("\\\\?\\").unwrap_or(&text))
        };
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

pub fn scope(path: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(path).or_else(|_| {
        let parent = path.parent().unwrap_or(path);
        Ok::<_, std::io::Error>(
            std::fs::canonicalize(parent)?.join(path.file_name().unwrap_or_default()),
        )
    })?;
    let name = canonical.to_string_lossy();
    #[cfg(target_os = "windows")]
    let name = if let Some(unc) = name.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        name.strip_prefix("\\\\?\\").unwrap_or(&name).to_owned()
    }
    .to_lowercase();
    Ok(format!("game:{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_names() {
        for name in [
            "../a",
            "Bin/../a",
            "C:a",
            "Bin/NUL.txt",
            "Bin/a.",
            "Bin\\a",
            "/a",
            "Bin/a\0",
        ] {
            assert!(within(Path::new("/tmp"), name).is_err(), "{name}")
        }
    }
}

pub fn linked(info: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    info.file_type().is_symlink()
}
pub fn ensure_directory(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        if parent != path && !parent.exists() {
            ensure_directory(parent)?;
        }
    }
    match std::fs::symlink_metadata(path) {
        Ok(info) => {
            if linked(&info) || !info.is_dir() {
                bail!("A linked or invalid installation directory was found.")
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path)?;
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
pub fn replace(source: &Path, target: &Path) -> Result<()> {
    for attempt in 0..6 {
        match std::fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if attempt == 5 || !matches!(error.raw_os_error(), Some(5 | 13 | 16 | 32 | 33)) {
                    return Err(error.into());
                }
                std::thread::sleep(std::time::Duration::from_millis(50 << attempt));
            }
        }
    }
    unreachable!()
}
