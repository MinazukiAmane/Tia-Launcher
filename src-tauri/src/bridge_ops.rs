use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
};

pub fn verify_installer(path: &Path, expected: &str) -> Result<()> {
    ensure!(
        STANDARD
            .decode(expected)
            .is_ok_and(|bytes| bytes.len() == 64),
        "Invalid installer digest"
    );
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "The downloaded migration installer could not be verified"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= 512 * 1024 * 1024,
        "The launcher update is too large"
    );
    let mut hash = Sha512::new();
    let mut bytes = [0; 128 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(
            total <= 512 * 1024 * 1024,
            "The launcher update is too large"
        );
        hash.update(&bytes[..count]);
    }
    ensure!(
        STANDARD.encode(hash.finalize()) == expected,
        "The downloaded migration installer has changed. Download the update again"
    );
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    VerifyInstaller {
        path: PathBuf,
        sha512: String,
    },
    WindowsContext {
        executable: PathBuf,
        guid: String,
    },
    WindowsArguments {
        args: Vec<String>,
        context: crate::installation::InstallContext,
    },
    #[cfg(unix)]
    Start {
        path: PathBuf,
        startup: crate::unix_update::Startup,
    },
    #[cfg(unix)]
    AppimageContext {
        path: PathBuf,
    },
    #[cfg(unix)]
    ReplaceAppimage {
        context: crate::unix_update::FileContext,
        download: PathBuf,
        sha512: String,
        startup: crate::unix_update::Startup,
    },
    #[cfg(unix)]
    MacContext {
        executable: PathBuf,
        id: String,
    },
    #[cfg(unix)]
    ReplaceMac {
        context: crate::unix_update::MacContext,
        download: PathBuf,
        sha512: String,
        version: String,
        startup: crate::unix_update::Startup,
    },
}
pub fn run(request: Request) -> Result<Value> {
    #[cfg(unix)]
    ensure!(
        !matches!(
            &request,
            Request::Start { .. } | Request::ReplaceAppimage { .. } | Request::ReplaceMac { .. }
        ) || unsafe { libc::geteuid() } != 0,
        "Bridge file operations must run without administrator privileges"
    );
    match request {
        Request::VerifyInstaller { path, sha512 } => {
            verify_installer(&path, &sha512)?;
            Ok(Value::Null)
        }
        Request::WindowsArguments { args, context } => Ok(json!(
            crate::installation::preserve_arguments(args, &context)?
        )),
        Request::WindowsContext { executable, guid } => {
            #[cfg(windows)]
            {
                Ok(json!(crate::installation::windows_context(
                    &executable,
                    &guid
                )?))
            }
            #[cfg(not(windows))]
            {
                let _ = (executable, guid);
                anyhow::bail!("Windows installation detection requires Windows")
            }
        }
        #[cfg(unix)]
        Request::AppimageContext { path } => {
            Ok(json!(crate::unix_update::appimage_context(&path)?))
        }
        #[cfg(unix)]
        Request::MacContext { executable, id } => Ok(json!(crate::unix_update::mac_context(
            &executable,
            &id,
            crate::unix_update::bundle_identity
        )?)),
        #[cfg(unix)]
        Request::Start { path, startup } => {
            Ok(json!({"pid":crate::unix_update::start(&path,&startup)?}))
        }
        #[cfg(unix)]
        Request::ReplaceAppimage {
            context,
            download,
            sha512,
            startup,
        } => Ok(
            json!({"pid":crate::unix_update::replace_appimage(&context,&download,&sha512,|path|crate::unix_update::start(path,&startup))?}),
        ),
        #[cfg(unix)]
        Request::ReplaceMac {
            context,
            download,
            sha512,
            version,
            startup,
        } => Ok(
            json!({"pid":crate::unix_update::replace_mac(&context,&download,&sha512,&version,|path|crate::unix_update::start(path,&startup),crate::unix_update::bundle_identity)?}),
        ),
    }
}
