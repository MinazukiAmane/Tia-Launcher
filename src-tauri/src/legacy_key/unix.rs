use super::{Envelope, verified_key};
use anyhow::{Result, bail};
use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use zeroize::Zeroizing;

#[cfg(any(target_os = "linux", target_os = "macos"))]
const APPLICATIONS: [&str; 3] = ["Tia Launcher", "tia-launcher", "tia-launcher-bootstrap"];

fn decrypt(blob: &[u8], password: &[u8], iterations: u32) -> Result<Zeroizing<Vec<u8>>> {
    if blob.len() < 19 || (blob.len() - 3) % 16 != 0 {
        bail!("Invalid legacy encrypted key")
    }
    let mut derived = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, derived.as_mut());
    cbc::Decryptor::<aes::Aes128>::new(derived.as_ref().into(), b"                ".into())
        .decrypt_padded_vec_mut::<Pkcs7>(&blob[3..])
        .map(Zeroizing::new)
        .map_err(|_| anyhow::anyhow!("Legacy key could not be opened"))
}
fn candidate(
    envelope: &Envelope,
    blob: &[u8],
    password: &[u8],
    iterations: u32,
) -> Result<Zeroizing<[u8; 32]>> {
    let plain = decrypt(blob, password, iterations)?;
    verified_key(envelope, std::str::from_utf8(&plain)?)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn recover(envelope: &Envelope) -> Result<Option<Zeroizing<[u8; 32]>>> {
    use base64::Engine;
    if envelope.version != 1 || !envelope.migrated {
        bail!("Update the Electron launcher before migrating saved data")
    }
    let blob = base64::engine::general_purpose::STANDARD.decode(&envelope.data)?;
    #[cfg(target_os = "linux")]
    {
        if blob.starts_with(b"v10") {
            for password in [b"peanuts".as_slice(), b"".as_slice()] {
                if let Ok(key) = candidate(envelope, &blob, password, 1) {
                    return Ok(Some(key));
                }
            }
        } else if blob.starts_with(b"v11") {
            return linux_recover(envelope, &blob);
        }
    }
    #[cfg(target_os = "macos")]
    if blob.starts_with(b"v10") {
        let mut lookup_status = Vec::new();
        for application in APPLICATIONS {
            let service = format!("{application} Safe Storage");
            let password = macos_password(&service, application);
            match password {
                Ok(password) => {
                    if let Ok(key) = candidate(envelope, &blob, &password, 1003) {
                        return Ok(Some(key));
                    }
                    lookup_status.push(format!("{application}: authentication failed"));
                }
                Err(error) => lookup_status.push(format!("{application}: {error}")),
            }
        }
        bail!(
            "Legacy macOS key could not be verified ({})",
            lookup_status.join(", ")
        )
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn macos_password(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    security_framework::passwords::get_generic_password(service, account)
        .map(Zeroizing::new)
        .map_err(|error| anyhow::anyhow!("keychain status {}", error.code()))
}

#[cfg(target_os = "linux")]
fn linux_recover(envelope: &Envelope, blob: &[u8]) -> Result<Option<Zeroizing<[u8; 32]>>> {
    if let Ok(service) =
        secret_service::blocking::SecretService::connect(secret_service::EncryptionType::Dh)
    {
        for application in APPLICATIONS {
            let attributes = std::collections::HashMap::from([("application", application)]);
            if let Ok(items) = service.search_items(attributes) {
                for item in items.unlocked.into_iter().chain(items.locked).take(4) {
                    if item.unlock().is_ok() {
                        if let Ok(secret) = item.get_secret() {
                            let secret = Zeroizing::new(secret);
                            if let Ok(key) = candidate(envelope, blob, &secret, 1) {
                                return Ok(Some(key));
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(connection) = zbus::blocking::Connection::session() {
        for suffix in ["6", "5", ""] {
            let service = format!("org.kde.kwalletd{suffix}");
            let path = format!("/modules/kwalletd{suffix}");
            let Ok(proxy) = zbus::blocking::Proxy::new(
                &connection,
                service.as_str(),
                path.as_str(),
                "org.kde.KWallet",
            ) else {
                continue;
            };
            let Ok(wallet) = proxy.call::<_, _, String>("networkWallet", &()) else {
                continue;
            };
            let Ok(wallets) = proxy.call::<_, _, Vec<String>>("wallets", &()) else {
                continue;
            };
            if !wallets.contains(&wallet) {
                continue;
            }
            for application in APPLICATIONS {
                let Ok(handle) =
                    proxy.call::<_, _, i32>("open", &(wallet.as_str(), 0i64, application))
                else {
                    continue;
                };
                if handle < 0 {
                    continue;
                }
                let password = proxy.call::<_, _, String>(
                    "readPassword",
                    &(
                        handle,
                        "Chromium Keys",
                        "Chromium Safe Storage",
                        application,
                    ),
                );
                let _ = proxy.call::<_, _, i32>("close", &(handle, false, application));
                if let Ok(password) = password {
                    let password = Zeroizing::new(password.into_bytes());
                    if let Ok(key) = candidate(envelope, blob, &password, 1) {
                        return Ok(Some(key));
                    }
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use cbc::cipher::BlockEncryptMut;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    fn fixture(prefix: &[u8], password: &[u8], iterations: u32) -> (Envelope, [u8; 32]) {
        let key = [41u8; 32];
        let mut derived = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut derived);
        let mut blob = prefix.to_vec();
        blob.extend(
            cbc::Encryptor::<aes::Aes128>::new((&derived).into(), b"                ".into())
                .encrypt_padded_vec_mut::<Pkcs7>(hex::encode(key).as_bytes()),
        );
        let data = base64::engine::general_purpose::STANDARD.encode(blob);
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
        mac.update(&serde_json::to_vec(&(1u8, "os", &data, true)).unwrap());
        (
            Envelope {
                version: 1,
                mode: "os".into(),
                data,
                migrated: true,
                tag: hex::encode(mac.finalize().into_bytes()),
            },
            key,
        )
    }
    #[test]
    fn chromium_cbc_and_authenticated_envelope_match_for_linux_and_mac() {
        for (prefix, password, iterations) in [
            (b"v10".as_slice(), b"peanuts".as_slice(), 1),
            (b"v11".as_slice(), b"stored OS password".as_slice(), 1),
            (b"v10".as_slice(), b"mac keychain password".as_slice(), 1003),
        ] {
            let (mut envelope, key) = fixture(prefix, password, iterations);
            let blob = base64::engine::general_purpose::STANDARD
                .decode(&envelope.data)
                .unwrap();
            assert_eq!(
                *candidate(&envelope, &blob, password, iterations).unwrap(),
                key
            );
            assert!(candidate(&envelope, &blob, b"wrong", iterations).is_err());
            envelope.tag = "0".repeat(64);
            assert!(candidate(&envelope, &blob, password, iterations).is_err());
        }
    }
    #[test]
    fn rejects_truncated_and_unpadded_ciphertexts() {
        for bytes in [vec![], vec![0; 18], vec![0; 20], vec![0; 19]] {
            assert!(decrypt(&bytes, b"peanuts", 1).is_err())
        }
    }
}
