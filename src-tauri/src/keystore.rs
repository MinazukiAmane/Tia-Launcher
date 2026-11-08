use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "windows"))]
use sha2::Digest;
use sha2::Sha256;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    mode: String,
    data: String,
    tag: String,
}
fn key_tag(mode: &str, data: &str, key: &[u8; 32]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("key length");
    mac.update(&serde_json::to_vec(&(1u8, mode, data)).expect("strings"));
    hex::encode(mac.finalize().into_bytes())
}
#[cfg(not(target_os = "windows"))]
fn account(directory: &Path) -> String {
    hex::encode(Sha256::digest(
        fs::canonicalize(directory)
            .unwrap_or_else(|_| directory.to_path_buf())
            .to_string_lossy()
            .as_bytes(),
    ))
}

pub fn atomic_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let written = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

pub fn import_key(directory: &Path, key: &[u8; 32], native: bool) -> Result<()> {
    let path = directory.join("launcher.tauri.key");
    if path.exists() {
        if load_key(directory)? != *key {
            bail!("A different migration key already exists. Saved data was not changed.")
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    let wrapped = if native {
        Some(native_wrap(directory, key)?)
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let wrapped = if native {
        native_wrap(directory, key).ok()
    } else {
        None
    };
    let (mode, data) = wrapped.unwrap_or_else(|| ("file".to_owned(), STANDARD.encode(key)));
    let envelope = Envelope {
        version: 1,
        tag: key_tag(&mode, &data, key),
        mode,
        data,
    };
    atomic_private_file(&path, &serde_json::to_vec(&envelope)?)
}

pub fn load_key(directory: &Path) -> Result<[u8; 32]> {
    let path = directory.join("launcher.tauri.key");
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16384 {
        bail!("Invalid saved key.")
    }
    let envelope: Envelope = serde_json::from_slice(&fs::read(&path)?)?;
    if envelope.version != 1 {
        bail!("Unsupported saved key version.")
    }
    let raw = if envelope.mode == "file" {
        STANDARD.decode(&envelope.data)?
    } else {
        native_unwrap(directory, &envelope.mode, &envelope.data)?
    };
    let key: [u8; 32] = raw
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid saved key."))?;
    let expected = key_tag(&envelope.mode, &envelope.data, &key);
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("key length");
    mac.update(&serde_json::to_vec(&(1u8, &envelope.mode, &envelope.data))?);
    mac.verify_slice(&hex::decode(&envelope.tag)?)
        .map_err(|_| anyhow::anyhow!("Saved key could not be verified."))?;
    debug_assert_eq!(expected, envelope.tag);
    Ok(key)
}

pub fn load_or_create(directory: &Path) -> Result<[u8; 32]> {
    fs::create_dir_all(directory)?;
    if directory.join("launcher.tauri.key").exists() {
        let key = load_key(directory)?;
        #[cfg(target_os = "macos")]
        protect_after_handoff(directory, &key)?;
        return Ok(key);
    }
    if directory.join("launcher.key").exists() {
        if let Some(key) = crate::legacy_key::recover(directory)? {
            crate::migration::import(
                crate::migration::ImportRequest {
                    protocol: 1,
                    nonce: hex::encode(rand::random::<[u8; 32]>()),
                    profile: fs::canonicalize(directory)?,
                    root_key: hex::encode(key.as_ref()),
                },
                true,
            )?;
            return Ok(*key);
        }
    }
    if directory.join("launcher.db").exists()
        || directory.join("launcher.db.bak").exists()
        || directory.join("launcher.key").exists()
    {
        bail!(
            "Run the Electron migration update first. Your existing launcher data has not been changed."
        )
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    import_key(directory, &key, true)?;
    Ok(key)
}

#[cfg(target_os = "linux")]
fn native_wrap(directory: &Path, key: &[u8; 32]) -> Result<(String, String)> {
    let name = account(directory);
    let entry = keyring::Entry::new("com.serenetia.tia-launcher", &name)?;
    match entry.get_password() {
        Ok(existing) if existing != STANDARD.encode(key) => bail!("An existing OS key differs."),
        Ok(_) => {}
        Err(keyring::Error::NoEntry) => entry.set_password(&STANDARD.encode(key))?,
        Err(e) => return Err(e.into()),
    }
    Ok(("keyring".into(), name))
}
#[cfg(target_os = "linux")]
fn native_unwrap(directory: &Path, mode: &str, data: &str) -> Result<Vec<u8>> {
    if mode != "keyring" || data != account(directory) {
        bail!("Invalid OS key reference.")
    }
    Ok(
        STANDARD
            .decode(keyring::Entry::new("com.serenetia.tia-launcher", data)?.get_password()?)?,
    )
}

#[cfg(target_os = "macos")]
fn native_wrap(directory: &Path, key: &[u8; 32]) -> Result<(String, String)> {
    let name = account(directory);
    if let Ok(existing) =
        security_framework::passwords::get_generic_password("com.serenetia.tia-launcher", &name)
    {
        if existing != key {
            bail!("An existing OS key differs.")
        }
        return Ok(("keychain".into(), name));
    }
    security_framework::passwords::set_generic_password("com.serenetia.tia-launcher", &name, key)?;
    Ok(("keychain".into(), name))
}
#[cfg(target_os = "macos")]
fn native_unwrap(directory: &Path, mode: &str, data: &str) -> Result<Vec<u8>> {
    if mode != "keychain" || data != account(directory) {
        bail!("Invalid OS key reference.")
    }
    Ok(security_framework::passwords::get_generic_password(
        "com.serenetia.tia-launcher",
        data,
    )?)
}

#[cfg(target_os = "windows")]
pub(crate) fn dpapi(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        bail!("Windows could not open the saved launcher key.")
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(result)
}
#[cfg(target_os = "windows")]
fn native_wrap(_directory: &Path, key: &[u8; 32]) -> Result<(String, String)> {
    Ok(("dpapi".into(), STANDARD.encode(dpapi(key, true)?)))
}
#[cfg(target_os = "windows")]
fn native_unwrap(_directory: &Path, mode: &str, data: &str) -> Result<Vec<u8>> {
    if mode != "dpapi" {
        bail!("Invalid OS key provider.")
    }
    dpapi(&STANDARD.decode(data)?, false)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_key_is_dpapi_protected_and_can_be_reopened() {
        let directory = tempfile::tempdir().unwrap();
        let key = [12; 32];
        import_key(directory.path(), &key, true).unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.path().join("launcher.tauri.key")).unwrap(),
        )
        .unwrap();
        assert_eq!(envelope["mode"], "dpapi");
        assert_ne!(envelope["data"], STANDARD.encode(key));
        assert_eq!(load_key(directory.path()).unwrap(), key);
    }

    use super::*;
    #[test]
    fn import_is_idempotent_and_refuses_another_key() {
        let dir = tempfile::tempdir().unwrap();
        import_key(dir.path(), &[8; 32], false).unwrap();
        assert_eq!(load_key(dir.path()).unwrap(), [8; 32]);
        import_key(dir.path(), &[8; 32], false).unwrap();
        assert!(import_key(dir.path(), &[9; 32], false).is_err());
    }
    #[test]
    fn missing_key_never_replaces_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("launcher.db"), b"existing").unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert!(!dir.path().join("launcher.tauri.key").exists());
    }
}

#[cfg(target_os = "macos")]
fn protect_after_handoff(directory: &Path, key: &[u8; 32]) -> Result<()> {
    let path = directory.join("launcher.tauri.key");
    let saved: Envelope = serde_json::from_slice(&fs::read(&path)?)?;
    if saved.mode == "file" {
        if let Ok((mode, data)) = native_wrap(directory, key) {
            let envelope = Envelope {
                version: 1,
                tag: key_tag(&mode, &data, key),
                mode,
                data,
            };
            atomic_private_file(&path, &serde_json::to_vec(&envelope)?)?;
        }
    }
    Ok(())
}
