use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;

pub struct RecordCipher(Aes256Gcm);
impl RecordCipher {
    pub fn new(key: &[u8; 32]) -> Self {
        Self(Aes256Gcm::new(key.into()))
    }
    fn aad(scope: &str, name: &str) -> Vec<u8> {
        serde_json::to_vec(&[scope, name]).expect("string encoding")
    }
    pub fn seal(&self, scope: &str, name: &str, plain: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = self
            .0
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain.as_bytes(),
                    aad: &Self::aad(scope, name),
                },
            )
            .map_err(|_| anyhow::anyhow!("Could not protect saved data."))?;
        // Node stores nonce + authentication tag + ciphertext; RustCrypto returns ciphertext + tag.
        let split = encrypted.len() - 16;
        let mut data = Vec::with_capacity(28 + split);
        data.extend_from_slice(&nonce);
        data.extend_from_slice(&encrypted[split..]);
        data.extend_from_slice(&encrypted[..split]);
        Ok(format!("tia:gcm:1:{}", STANDARD.encode(data)))
    }
    pub fn open(&self, scope: &str, name: &str, raw: &str) -> Result<String> {
        let Some(encoded) = raw.strip_prefix("tia:gcm:1:") else {
            bail!("Saved launcher data could not be verified.")
        };
        let data = STANDARD.decode(encoded)?;
        if data.len() < 28 {
            bail!("Saved launcher data could not be verified.")
        }
        let mut encrypted = data[28..].to_vec();
        encrypted.extend_from_slice(&data[12..28]);
        let plain = self
            .0
            .decrypt(
                Nonce::from_slice(&data[..12]),
                Payload {
                    msg: &encrypted,
                    aad: &Self::aad(scope, name),
                },
            )
            .map_err(|_| anyhow::anyhow!("Saved launcher data could not be verified."))?;
        Ok(String::from_utf8(plain)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binds_identity_and_detects_changes() {
        let cipher = RecordCipher::new(&[7; 32]);
        let raw = cipher
            .seal("game:C:\\Games", "install", "{\"version\":\"1\"}")
            .unwrap();
        assert_eq!(
            cipher.open("game:C:\\Games", "install", &raw).unwrap(),
            "{\"version\":\"1\"}"
        );
        assert!(cipher.open("game:D:\\Games", "install", &raw).is_err());
        assert!(cipher.open("game:C:\\Games", "verifyCache", &raw).is_err());
        assert!(cipher.open("game:C:\\Games", "install", "{}").is_err());
    }
}
