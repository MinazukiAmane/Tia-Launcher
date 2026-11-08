use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub md5: String,
    pub size: u64,
    pub url: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub repair_supported: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub key_id: String,
    pub game_biz: String,
    pub signature: String,
    pub body: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
pub struct PublicKey {
    pub id: String,
    pub public_key: String,
}

pub fn authenticate(proof: &Proof, game: &str) -> Result<Manifest> {
    authenticate_with_keys(proof, game, &pinned_keys()?)
}
pub fn pinned_keys() -> Result<Vec<PublicKey>> {
    Ok(serde_json::from_str(include_str!(
        "../../src/shared/manifestKeys.json"
    ))?)
}
pub fn authenticate_with_keys(proof: &Proof, game: &str, keys: &[PublicKey]) -> Result<Manifest> {
    if proof.game_biz != game {
        bail!("Manifest belongs to another game.")
    }
    let key = keys
        .iter()
        .find(|key| key.id == proof.key_id)
        .ok_or_else(|| anyhow::anyhow!("Unrecognized manifest signing key."))?;
    let public = VerifyingKey::from_public_key_pem(&key.public_key)?;
    let signature = Signature::from_slice(&STANDARD.decode(&proof.signature)?)?;
    let mut message = format!("Tia version manifest v1\0{game}\0").into_bytes();
    message.extend_from_slice(proof.body.as_bytes());
    public.verify(&message, &signature)?;
    let manifest: Manifest = serde_json::from_str(&proof.body)?;
    for file in &manifest.files {
        if file.md5.len() != 32 || hex::decode(&file.md5).is_err() {
            bail!("Invalid file hash.")
        }
    }
    Ok(manifest)
}
