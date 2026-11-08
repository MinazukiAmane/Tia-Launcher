#[cfg(any(unix, test))]
mod unix;
use anyhow::{Result, bail};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::{fs, path::Path};
use zeroize::Zeroizing;

#[derive(Deserialize)]
struct Envelope {
    version: u8,
    mode: String,
    data: String,
    migrated: bool,
    tag: String,
}

fn read_regular(path: &Path) -> Result<Vec<u8>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 4 * 1024 * 1024 {
        bail!("The old launcher key could not be read safely.")
    }
    Ok(fs::read(path)?)
}

fn verified_key(envelope: &Envelope, secret: &str) -> Result<Zeroizing<[u8; 32]>> {
    if envelope.version != 1
        || !envelope.migrated
        || !matches!(envelope.mode.as_str(), "file" | "os")
    {
        bail!("Update the Electron launcher before migrating your saved data.")
    }
    let decoded = Zeroizing::new(hex::decode(secret)?);
    let key: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid old launcher key."))?;
    let key = Zeroizing::new(key);
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_ref()).expect("key length");
    mac.update(&serde_json::to_vec(&(
        envelope.version,
        &envelope.mode,
        &envelope.data,
        envelope.migrated,
    ))?);
    mac.verify_slice(&hex::decode(&envelope.tag)?)
        .map_err(|_| anyhow::anyhow!("The old launcher key could not be verified."))?;
    Ok(key)
}

pub fn recover(directory: &Path) -> Result<Option<Zeroizing<[u8; 32]>>> {
    let envelope: Envelope =
        serde_json::from_slice(&read_regular(&directory.join("launcher.key"))?)?;
    if envelope.mode == "file" {
        return Ok(Some(verified_key(&envelope, &envelope.data)?));
    }
    #[cfg(target_os = "windows")]
    if envelope.mode == "os" {
        let plaintext = windows_secret(directory, &envelope.data)?;
        return Ok(Some(verified_key(
            &envelope,
            std::str::from_utf8(&plaintext)?,
        )?));
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if envelope.mode == "os" {
        return unix::recover(&envelope);
    }
    Ok(None)
}

#[cfg(any(target_os = "windows", test))]
fn chromium_gcm(blob: &[u8], master: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>> {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    if blob.len() < 3 + 12 + 16 || &blob[..3] != b"v10" {
        bail!("Unsupported Electron key format.")
    }
    let cipher = Aes256Gcm::new_from_slice(master).expect("key length");
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&blob[3..15]), &blob[15..])
        .map_err(|_| anyhow::anyhow!("Windows could not verify the old launcher key."))?;
    Ok(Zeroizing::new(plaintext))
}

#[cfg(target_os = "windows")]
fn windows_secret(directory: &Path, encoded: &str) -> Result<Zeroizing<Vec<u8>>> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let blob = STANDARD.decode(encoded)?;
    if !blob.starts_with(b"v10") {
        if blob.starts_with(b"v") {
            bail!("This Electron key format needs the migration update.")
        }
        return Ok(Zeroizing::new(crate::keystore::dpapi(&blob, false)?));
    }
    let state: serde_json::Value =
        serde_json::from_slice(&read_regular(&directory.join("Local State"))?)?;
    let encoded = state["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("The old Windows encryption key is missing."))?;
    let wrapped = STANDARD.decode(encoded)?;
    let protected = wrapped
        .strip_prefix(b"DPAPI")
        .ok_or_else(|| anyhow::anyhow!("Unsupported Windows encryption key."))?;
    let raw = Zeroizing::new(crate::keystore::dpapi(protected, false)?);
    let master: &[u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid Windows encryption key."))?;
    chromium_gcm(&blob, master)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticates_old_envelope_and_rejects_tampering() {
        let key = [9u8; 32];
        let mut envelope = Envelope {
            version: 1,
            mode: "file".into(),
            data: hex::encode(key),
            migrated: true,
            tag: String::new(),
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(&serde_json::to_vec(&(1u8, "file", &envelope.data, true)).unwrap());
        envelope.tag = hex::encode(mac.finalize().into_bytes());
        assert_eq!(*verified_key(&envelope, &envelope.data).unwrap(), key);
        envelope.migrated = false;
        assert!(verified_key(&envelope, &envelope.data).is_err());
        envelope.migrated = true;
        envelope.tag = "0".repeat(64);
        assert!(verified_key(&envelope, &envelope.data).is_err());
    }
    #[test]
    fn decrypts_chromium_layout_and_rejects_modified_ciphertext() {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
        let key = [7; 32];
        let nonce = [3; 12];
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(Nonce::from_slice(&nonce), b"old root key".as_slice())
            .unwrap();
        let mut blob = [b"v10".as_slice(), &nonce, &ciphertext].concat();
        assert_eq!(&*chromium_gcm(&blob, &key).unwrap(), b"old root key");
        *blob.last_mut().unwrap() ^= 1;
        assert!(chromium_gcm(&blob, &key).is_err());
        assert!(chromium_gcm(b"v20", &key).is_err());
    }
}
