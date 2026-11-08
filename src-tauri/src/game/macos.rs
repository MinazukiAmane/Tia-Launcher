use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn inspect_wrapper(path: &Path) -> Result<()> {
    let configured = (|| -> Result<bool> {
        if !path.is_absolute()
            || !path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("app"))
        {
            return Ok(false);
        }
        let launcher = std::fs::metadata(path.join("Contents/MacOS/wineskinlauncher"))?;
        if !launcher.is_file()
            || !path.join("Contents/SharedSupport/prefix/drive_c").is_dir()
            || !path.join("Contents/SharedSupport/wine").is_dir()
        {
            return Ok(false);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if launcher.permissions().mode() & 0o111 == 0 {
                return Ok(false);
            }
        }
        Ok(true)
    })();
    if configured.unwrap_or(false) {
        Ok(())
    } else {
        bail!("Select a configured Sikarugir .app wrapper in Game Settings before playing.")
    }
}

pub fn find_wrapper(saved: Option<&Value>, defaults: &[PathBuf]) -> Option<PathBuf> {
    if let Some(saved) = saved.filter(|value| !value.is_null()) {
        return saved["wrapperPath"]
            .as_str()
            .map(PathBuf::from)
            .filter(|path| inspect_wrapper(path).is_ok());
    }
    defaults
        .iter()
        .find(|path| inspect_wrapper(path).is_ok())
        .cloned()
}

fn wine_path(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .context("The game path contains unsupported characters")?;
    if !text.starts_with('/') || text.contains(['\\', '\r', '\n', '\0', '"']) {
        bail!("The macOS game path contains unsupported characters.")
    }
    Ok(format!("Z:{}", text.replace('/', "\\")))
}
fn batch_arg(value: &str) -> Result<String> {
    if value.contains(['\r', '\n', '\0', '"']) {
        bail!("Unsupported quote or control character in the macOS launch path or options.")
    }
    Ok(format!("\"{}\"", value.replace('%', "%%")))
}
pub fn build_batch(executable: &Path, args: &[String], working_directory: &Path) -> Result<String> {
    let invocation = std::iter::once(wine_path(executable)?)
        .chain(args.iter().cloned())
        .map(|arg| batch_arg(&arg))
        .collect::<Result<Vec<_>>>()?
        .join(" ");
    Ok(format!(
        "@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d {}\r\n{invocation}\r\n",
        batch_arg(&wine_path(working_directory)?)?
    ))
}
