use anyhow::{Result, ensure};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum VideoSource {
    Builtin(String),
    File(PathBuf),
}

pub fn authorize(
    source: &str,
    selected: Option<&Path>,
    pending: Option<&Path>,
) -> Result<VideoSource> {
    if source.starts_with("/assets/") {
        ensure!(
            !source.contains(['\\', '%', '?', '#', '\0'])
                && source
                    .split('/')
                    .skip(1)
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && [".mp4", ".webm"]
                    .iter()
                    .any(|extension| source.ends_with(extension)),
            "Invalid built-in video"
        );
        return Ok(VideoSource::Builtin(source.into()));
    }
    let path = Path::new(source);
    ensure!(
        path.is_absolute() && (selected == Some(path) || pending == Some(path)),
        "Choose a background video first"
    );
    Ok(VideoSource::File(path.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_builtin_videos_to_asset_paths() {
        assert_eq!(
            authorize("/assets/background-123.mp4", None, None).unwrap(),
            VideoSource::Builtin("/assets/background-123.mp4".into())
        );
        for source in [
            "/assets/../secret.mp4",
            "/assets/./clip.mp4",
            "/assets//clip.mp4",
            "/assets/%2e%2e/clip.mp4",
            "/assets/clip.mp4?x=.mp4",
            "/assets/clip.svg",
            "/assets/clip\\escape.mp4",
        ] {
            assert!(authorize(source, None, None).is_err(), "{source}");
        }
    }

    #[test]
    fn accepts_only_selected_or_pending_custom_files() {
        let root = std::env::temp_dir();
        let selected = root.join("selected.mp4");
        let pending = root.join("pending.mp4");
        for path in [&selected, &pending] {
            assert!(authorize(path.to_str().unwrap(), Some(&selected), Some(&pending)).is_ok());
        }
        assert!(
            authorize(
                root.join("unselected.mp4").to_str().unwrap(),
                Some(&selected),
                Some(&pending)
            )
            .is_err()
        );
        assert!(authorize("relative.mp4", Some(Path::new("relative.mp4")), None).is_err());
    }
}
